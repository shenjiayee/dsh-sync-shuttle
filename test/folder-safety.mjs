// 离线：测试文件夹前缀的安全校验（不联网）。
//
// 这是「测试脚本永远不碰生产」这条铁律的看门测试。
// 背景：曾经 SS_TEST_FOLDER_PREFIX 设成空串时，testFolders() 会拼出生产文件夹名
// （Sync-Shuttle），一旦跑起来就会把测试数据写进生产、甚至在清理时删掉生产邮件。
//
// 本套测试把「所有可能导致撞生产的输入」逐个打一遍，确保每一种都被拒绝，
// 而合法的输入仍然正常工作。
import { pathToFileURL } from 'node:url';

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ' :: ' + String(extra).slice(0, 200) : ''}`);
  }
};

const BASE = pathToFileURL('D:/dsh-project/sync-shuttle/test/cred.mjs').href;

/**
 * 在指定前缀下重新求值 cred.mjs（query 参数绕过 ESM 缓存），
 * 返回 { ok, folders } 或 { ok:false, message }。
 */
async function withPrefix(value, tag) {
  if (value === undefined) delete process.env.SS_TEST_FOLDER_PREFIX;
  else process.env.SS_TEST_FOLDER_PREFIX = value;
  try {
    const m = await import(`${BASE}?probe=${tag}`);
    return { ok: true, folders: m.testFolders() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ── 1. 非法输入必须全部被拒绝
const INVALID = [
  { v: '', label: '空串' },
  { v: ' ', label: '单个空格' },
  { v: '    ', label: '多个空格' },
  { v: '\t', label: '制表符' },
  { v: '\n', label: '换行' },
  { v: '-', label: '只有连字符' },
  { v: '--', label: '两个连字符' },
  { v: '中文', label: '非 ASCII' },
  { v: 'a/b', label: '含路径分隔符' },
  { v: 'a b', label: '含内部空格' },
  { v: 'Sync-Shuttle', label: '误填生产基础名' },
  { v: 'Testing-Sync-Shuttle', label: '误填完整文件夹名' },
  { v: 'sync-shuttle', label: '小写生产名' },
];

for (let i = 0; i < INVALID.length; i += 1) {
  const c = INVALID[i];
  const r = await withPrefix(c.v, `bad${i}`);
  check(`拒绝非法前缀：${c.label}`, r.ok === false, r.ok ? `竟然得到 ${r.folders.data}` : '');
}

// ── 2. 合法输入必须通过，且名字正确
const VALID = [
  { v: 'Testing-', expect: 'Testing-Sync-Shuttle', label: '带尾部连字符' },
  { v: 'Testing', expect: 'Testing-Sync-Shuttle', label: '无连字符（自动补）' },
  { v: 'MyTest', expect: 'MyTest-Sync-Shuttle', label: '驼峰' },
  { v: 't1', expect: 't1-Sync-Shuttle', label: '字母数字' },
];

for (let i = 0; i < VALID.length; i += 1) {
  const c = VALID[i];
  const r = await withPrefix(c.v, `good${i}`);
  check(`接受合法前缀：${c.label}`, r.ok === true, r.message);
  if (r.ok) {
    check(`  └ 数据文件夹正确（${c.expect}）`, r.folders.data === c.expect, r.folders.data);
    check(`  └ 配置文件夹正确`, r.folders.config === `${c.expect.replace('Sync-Shuttle', 'Sync-Shuttle-Config')}`, r.folders.config);
    check(`  └ 锁文件夹正确`, r.folders.lock === `${c.expect.replace('Sync-Shuttle', 'Sync-Shuttle-Lock')}`, r.folders.lock);
  }
}

// ── 3. 未设置环境变量时用默认 Testing-
{
  const r = await withPrefix(undefined, 'default');
  check('未设置时使用默认前缀', r.ok === true && r.folders.prefix === 'Testing-', r.message || r.folders?.prefix);
  check('默认文件夹 = Testing-Sync-Shuttle', r.ok === true && r.folders.data === 'Testing-Sync-Shuttle', r.folders?.data);
}

// ── 4. assertNotProduction 独立把关（即使绕过 testFolders 直接构造也要拦住）
{
  const m = await import(`${BASE}?guard=1`);

  const prod = { data: 'Sync-Shuttle', config: 'Sync-Shuttle-Config', lock: 'Sync-Shuttle-Lock', prefix: '' };
  check('断言：完整生产名被拒', (() => {
    try { m.assertNotProduction(prod); return false; } catch { return true; }
  })());

  check('断言：仅 data 撞车也被拒', (() => {
    try {
      m.assertNotProduction({ data: 'Sync-Shuttle', config: 'X-Config', lock: 'X-Lock', prefix: 'X-' });
      return false;
    } catch { return true; }
  })());

  check('断言：空前缀被拒', (() => {
    try {
      m.assertNotProduction({ data: 'Foo', config: 'Foo-C', lock: 'Foo-L', prefix: '' });
      return false;
    } catch { return true; }
  })());

  check('断言：去掉首尾空白后等于生产名也被拒', (() => {
    try {
      m.assertNotProduction({ data: ' Sync-Shuttle ', config: ' Testing-Config ', lock: ' Testing-Lock ', prefix: 'X-' });
      return false;
    } catch { return true; }
  })());

  check('断言：合法测试文件夹通过', (() => {
    try {
      m.assertNotProduction(m.testFolders());
      return true;
    } catch { return false; }
  })());
}

// 清理环境变量，避免影响后续测试
delete process.env.SS_TEST_FOLDER_PREFIX;

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
