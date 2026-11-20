// RPC 线协议测试：直接调用插件注册的 handler，验证
// 客户端 POST {type:'client-request'} → 宿主回 {type:'server-response'} 的完整信封。
// 用的是真实邮箱（connection.test 会真连一次），其余端点不产生网络请求。
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = (await import('./cred.mjs')).PLUGIN_ROOT.replace(/\\/g, '/');
const mod = await import(pathToFileURL(`${ROOT}/lib/index.js`).href);

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
};

/**
 * 安全预览：extra 参数即使断言通过也会被求值，
 * 所以绝不能直接 JSON.stringify(x).slice()——x 可能是 undefined，
 * JSON.stringify(undefined) 返回 undefined（不是字符串），再 .slice 就 TypeError。
 */
const preview = (value, max = 160) => {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return String(text ?? '').slice(0, max);
};

let handler = null;
const ctx = {
  env: { ...process.env, DSH_HOME: 'C:\\Users\\sjy\\.dsh' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: {
    register(options) {
      handler = options.handler;
      return { dispose() {} };
    },
  },
  tools: { register: () => () => {} },
};

const dispose = mod.apply(ctx, {});
check('handler 已注册', typeof handler === 'function');

/** 造一个假 req/res，走一次完整 RPC。 */
function rpc(endpoint, payload = {}, { method = 'POST', contentType = 'application/json', body } = {}) {
  return new Promise((resolve, reject) => {
    const json = body !== undefined ? body : JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload });
    const req = Readable.from([Buffer.from(json, 'utf8')]);
    req.method = method;
    req.headers = { 'content-type': contentType };
    req.url = `/sync-shuttle/${endpoint}`;

    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        res.headers[String(k).toLowerCase()] = v;
      },
      writeHead(code) {
        res.statusCode = code;
      },
      end(buf) {
        if (buf) chunks.push(Buffer.from(buf));
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* 可能是 text/plain 错误页 */
        }
        // 必须用 res.statusCode：sendJson 是直接赋值，不经过 writeHead
        resolve({ status: res.statusCode, text, json: parsed });
      },
      write(buf) {
        if (buf) chunks.push(Buffer.from(buf));
      },
    };
    try {
      const out = handler(req, res);
      if (out && typeof out.catch === 'function') out.catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

const call = async (endpoint, payload) => {
  const r = await rpc(endpoint, payload);
  return r;
};

try {
  // ---- status.get
  const st = await call('status.get');
  check('status.get 返回 200', st.status === 200, String(st.status));
  check('status.get 回 server-response', st.json?.type === 'server-response', st.json?.type);
  check('status.get rpcId 回显', st.json?.rpcId === 'r1', st.json?.rpcId);
  check('status.get ok', st.json?.result?.ok === true, preview(st.json?.result, 150));
  const sv = st.json?.result?.value || {};
  check('status.get 带 machineId', typeof sv.machineId === 'string' && sv.machineId.startsWith('MC-'), sv.machineId);
  check('status.get 带 lock 状态', !!sv.lock, preview(sv.lock, 80));
  check('status.get 不含 token', !JSON.stringify(st.json).toLowerCase().includes('token":"'));

  // ---- settings.get：不返回 token
  const sg = await call('settings.get');
  check('settings.get ok', sg.json?.result?.ok === true);
  // 注意：settings.get 的返回是 { settings, machineId, hostname }，
  // snapshot 在 .settings 里，不是顶层。
  const settingsValue = sg.json?.result?.value?.settings || {};
  check('settings.get 有 accountMasked', typeof settingsValue.accountMasked === 'string', settingsValue.accountMasked);
  check('settings.get hasToken 是布尔', typeof settingsValue.hasToken === 'boolean', String(settingsValue.hasToken));
  check('settings.get 无明文授权码字段', !('token' in settingsValue) && !('pass' in settingsValue));

  // ---- projects.list
  const pl = await call('projects.list');
  check('projects.list ok', pl.json?.result?.ok === true, preview(pl.json?.result, 200));
  check('projects.list 返回 projects 数组', Array.isArray(pl.json?.result?.value?.projects));

  // ---- 错误协议
  const wrongMethod = await rpc('status.get', {}, { method: 'GET' });
  check('GET 被拒绝（405）', wrongMethod.status === 405, String(wrongMethod.status));

  const wrongType = await rpc('status.get', {}, {
    body: JSON.stringify({ type: 'something-else', rpcId: 'r2', method: 'status.get' }),
  });
  check('错误 type 被拒绝', wrongType.status >= 400, String(wrongType.status));

  const mismatch = await rpc('status.get', {}, {
    body: JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'settings.get' }),
  });
  check('method 与端点不符被拒绝', mismatch.status >= 400, String(mismatch.status));

  // 未知端点是 404 + 顶层 { ok:false, error }（还没进信封，因为没有 rpcId 可信来源）
  const unknown = await call('does.not.exist');
  check(
    '未知端点返回 404 + 错误体',
    unknown.status === 404 && unknown.json?.ok === false,
    `${unknown.status} ${preview(unknown.json || unknown.text, 120)}`,
  );

  const notJson = await rpc('status.get', {}, { contentType: 'text/plain' });
  check('非 JSON content-type 被拒绝', notJson.status === 415, String(notJson.status));

  // ---- connection.test（真实连一次邮箱）
  const ct = await call('connection.test');
  check('connection.test ok', ct.json?.result?.ok === true, preview(ct.json?.result, 200));
  const ctValue = ct.json?.result?.value || {};
  check('connection.test 报 IMAP 可用', ctValue.ok === true || ctValue.imap === true, preview(ctValue, 150));

  // ---- 回归：config.restore 必须在「成功」和「失败」两条路径上都不抛
  //
  // 这曾经是个致命 bug：handler 里写了 finally { await session.close() }，
  // 但作用域内根本没有 session 变量。于是无论恢复成功还是失败，
  // finally 都会抛 ReferenceError，把正常的返回值替换成一次 500。
  // 也就是说「从备份恢复」这个功能从来没成功过一次，而 158 项测试全绿，
  // 因为没有任何一条测试碰过这个端点。
  const restoreNoSeq = await call('config.restore', {});
  check('config.restore 缺 seq 返回 200 信封', restoreNoSeq.status === 200, String(restoreNoSeq.status));
  check(
    'config.restore 缺 seq 报 INVALID',
    restoreNoSeq.json?.result?.ok === false && restoreNoSeq.json?.result?.error?.code === 'INVALID',
    preview(restoreNoSeq.json?.result, 160),
  );

  // 用一个肯定不存在的 seq 走完「下载备份 → 失败 → catch」这条路径。
  // 有 finally-ReferenceError 的版本会在这里变成 500，而不是 200 + RESTORE_FAILED。
  const restoreBadSeq = await call('config.restore', { seq: 999999999 });
  check(
    'config.restore 不存在的 seq 回 200 而非 500（finally 不再抛 ReferenceError）',
    restoreBadSeq.status === 200,
    `${restoreBadSeq.status} ${String(restoreBadSeq.text).slice(0, 160)}`,
  );
  check(
    'config.restore 失败时报 RESTORE_FAILED',
    restoreBadSeq.json?.result?.ok === false &&
      typeof restoreBadSeq.json?.result?.error?.code === 'string',
    preview(restoreBadSeq.json?.result, 160),
  );

  // ---- 回归：config.restore 的 confirm 分支必须只回 needConfirm、不改本机配置
  // （diff 里能看出「将删除哪个项目」，用户确认前绝不能落盘）
  check(
    'config.restore 未确认时不返回 applied',
    restoreBadSeq.json?.result?.value?.applied !== true,
    preview(restoreBadSeq.json?.result?.value, 120),
  );

  // ---- 回归：download.start / upload.start 未绑定项目时必须结构化报错，不能抛
  const dlUnbound = await call('download.start', { name: '__不存在的项目__' });
  check('download.start 未绑定回 200 信封', dlUnbound.status === 200, String(dlUnbound.status));
  check(
    'download.start 未绑定报 NOT_BOUND',
    dlUnbound.json?.result?.ok === false && dlUnbound.json?.result?.error?.code === 'NOT_BOUND',
    preview(dlUnbound.json?.result, 160),
  );

  const ulUnbound = await call('upload.start', { name: '__不存在的项目__' });
  check('upload.start 未绑定回 200 信封', ulUnbound.status === 200, String(ulUnbound.status));
  check(
    'upload.start 未绑定报 NOT_BOUND',
    ulUnbound.json?.result?.ok === false && ulUnbound.json?.result?.error?.code === 'NOT_BOUND',
    preview(ulUnbound.json?.result, 160),
  );

  // ---- 回归：project.keepPrev 未绑定时必须拒绝，且不能悄悄写坏 projects.json
  const kpUnbound = await call('project.keepPrev', { name: '__不存在的项目__', keepPrev: true });
  check(
    'project.keepPrev 未绑定报 NOT_BOUND（不落库）',
    kpUnbound.json?.result?.ok === false && kpUnbound.json?.result?.error?.code === 'NOT_BOUND',
    preview(kpUnbound.json?.result, 160),
  );

  // ---- job.status：不存在的任务要报 JOB_NOT_FOUND，而不是抛
  const jsMissing = await call('job.status', { jobId: 'JOB-nope' });
  check(
    'job.status 不存在的任务报 JOB_NOT_FOUND',
    jsMissing.json?.result?.ok === false && jsMissing.json?.result?.error?.code === 'JOB_NOT_FOUND',
    preview(jsMissing.json?.result, 160),
  );

  // ---- lock.status / capacity.get / logs.read：只读端点都要能正常回包
  const ls = await call('lock.status');
  check('lock.status ok', ls.status === 200 && ls.json?.result?.ok === true, preview(ls.json?.result, 160));

  const cap = await call('capacity.get');
  const capValue = cap.json?.result?.value || {};
  check('capacity.get 返回 occupiedBytes 数字', typeof capValue.occupiedBytes === 'number', preview(capValue, 160));
  check('capacity.get 带容量说明', typeof capValue.note === 'string' && capValue.note.length > 0);

  const logs = await call('logs.read', { days: 1 });
  check('logs.read 返回 logs 数组', Array.isArray(logs.json?.result?.value?.logs), preview(logs.json?.result, 120));

  // ---- settings.get 必须把真正生效的开关暴露出来
  // 注意：encryptByDefault / sevenZipPath / compression 已随 A3 方案移除
  //（改用内置 ZIP、不再支持加密），所以这里断言它们**不该再出现**。
  check('settings.get 带 readOnly', typeof settingsValue.readOnly === 'boolean', String(settingsValue.readOnly));
  check('settings.get 带 keepPrevDefault', typeof settingsValue.keepPrevDefault === 'boolean', String(settingsValue.keepPrevDefault));
  check(
    'settings.get 报告归档后端为内置 zip',
    String(settingsValue.archiveBackend || '').includes('zip'),
    settingsValue.archiveBackend,
  );
  check(
    'settings.get 不再暴露 sevenZipPath（已不需要外部 7-Zip）',
    !('sevenZipPath' in settingsValue),
    JSON.stringify(Object.keys(settingsValue)),
  );
  check(
    'settings.get 不再暴露 encryptByDefault（加密已移除）',
    !('encryptByDefault' in settingsValue),
    JSON.stringify(Object.keys(settingsValue)),
  );
} finally {
  try {
    dispose?.();
  } catch {
    /* ignore */
  }
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
