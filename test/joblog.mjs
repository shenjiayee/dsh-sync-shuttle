// 验证：上传进度日志的合并与展示效果（离线）。
//
// 背景：打包阶段每写入一块数据就上报一次进度，原来会被原样追加进 job.log，
// 一次 48 MB 的上传能刷出几十上百条几乎相同的「打包 xx MB」。
// 现在 web-rpc.js 的 jobReporter 对进度做同阶段合并（只保留最后一条），
// 对重复的里程碑文案做折叠计数。
//
// 本测试**直接读 web-rpc.js 源码**验证那套逻辑存在，并用等价实现跑一遍
// 完整的上传进度序列，确认最终日志条数合理、内容不丢里程碑。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const { imp } = await import('./cred.mjs');
const LIB = 'D:/dsh-project/sync-shuttle/lib';

// ── 复刻 web-rpc.js 的 pushLog 逻辑（保持同步，测试它本身）
function makeJob() {
  return { stage: 'starting', status: 'running', percent: 0, message: '', log: [] };
}

function makeReporter(job) {
  const pushLog = (evt) => {
    const msg = evt.message || '';
    if (!msg) return;
    const now = Date.now();
    const isProgress = typeof evt.percent === 'number' || /（\d+%）$|^\s*打包\s/.test(msg);
    if (isProgress) {
      const last = job.log[job.log.length - 1];
      if (last && last.stage === evt.stage && last.progress) {
        last.message = msg;
        last.at = new Date(now).toISOString();
        return;
      }
      job.log.push({ at: new Date(now).toISOString(), stage: evt.stage, message: msg, progress: true });
      if (job.log.length > 200) job.log.shift();
      return;
    }
    const last = job.log[job.log.length - 1];
    if (last && last.message === msg) {
      last.at = new Date(now).toISOString();
      last.repeat = (last.repeat || 1) + 1;
      return;
    }
    job.log.push({ at: new Date(now).toISOString(), stage: evt.stage, message: msg });
    if (job.log.length > 200) job.log.shift();
  };
  return { onProgress: (evt) => { if (evt.message) { job.message = evt.message; pushLog(evt); } } };
}

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

// ── 1. 模拟一次真实上传的完整进度序列
const job = makeJob();
const r = makeReporter(job);

r.onProgress({ stage: 'precheck', message: '检查源目录与归档后端' });

r.onProgress({ stage: 'packing', message: '正在打包 3 个文件（48.1 MB）' });
// 模拟打包：每 0.5MB 报一次，共 96 次（真实场景的缩小版）
for (let mb = 0.5; mb <= 48.1; mb += 0.5) {
  const pct = Math.min(100, Math.round((mb / 48.1) * 100));
  r.onProgress({
    stage: 'packing',
    percent: pct,
    message: `打包 ${mb.toFixed(1)} MB / 48.1 MB（${pct}%）`,
  });
}

r.onProgress({ stage: 'hashing', message: '计算 2 卷的 SHA-256' });
r.onProgress({ stage: 'hashing', percent: 50 });
r.onProgress({ stage: 'hashing', percent: 100 });

r.onProgress({ stage: 'uploading', message: '开始上传 2 卷', total: 2 });
r.onProgress({ stage: 'uploading', percent: 50, message: '第 1/2 卷已写入', index: 1, total: 2 });
r.onProgress({ stage: 'uploading', percent: 100, message: '第 2/2 卷已写入', index: 2, total: 2 });

r.onProgress({ stage: 'verifying', message: '正在回读校验（不可跳过）' });
r.onProgress({ stage: 'verifying', percent: 50, message: '第 1/2 卷校验通过', index: 1, total: 2 });
r.onProgress({ stage: 'verifying', percent: 100, message: '第 2/2 卷校验通过', index: 2, total: 2 });

r.onProgress({ stage: 'cleaning', message: '清理旧版本' });

const total = job.log.length;
console.log(`\n=== 日志条数 ===`);
console.log(`  一次完整上传产生 ${total} 条日志`);
console.log(`  （打包阶段上报了 ${Math.floor(48.1 / 0.5)} 次进度，被合并成了 1 条）`);

check('日志条数被压缩到合理范围（< 20）', total < 20, String(total));
check('打包阶段只有 1 条进度日志', job.log.filter((l) => l.stage === 'packing' && l.progress).length === 1);
check(
  '打包进度保留最后一次的值',
  /48\.1 MB.*100%/.test(job.log.find((l) => l.stage === 'packing' && l.progress)?.message || ''),
  job.log.find((l) => l.stage === 'packing' && l.progress)?.message,
);

console.log('\n=== 实际展示效果（倒序，最新在上）===');
[...job.log].reverse().forEach((l) => {
  const time = l.at.slice(11, 19);
  const stage = (l.stage || '').padEnd(10);
  const mark = l.progress ? '·' : '●';
  console.log(`  ${time} ${mark} [${stage}] ${l.message}`);
});

// ── 2. 重复的相同文案会被折叠并计数
console.log('\n=== 重复文案折叠 ===');
const job2 = makeJob();
const r2 = makeReporter(job2);
r2.onProgress({ stage: 'uploading', message: '远端正被占用，排队中' });
r2.onProgress({ stage: 'uploading', message: '远端正被占用，排队中' });
r2.onProgress({ stage: 'uploading', message: '远端正被占用，排队中' });
check('连续相同的非进度日志折叠为 1 条', job2.log.length === 1, String(job2.log.length));
check('折叠时记录重复次数 ×3', job2.log[0].repeat === 3, String(job2.log[0].repeat));

// ── 3. 里程碑不被进度覆盖
console.log('\n=== 里程碑保留 ===');
const job3 = makeJob();
const r3 = makeReporter(job3);
r3.onProgress({ stage: 'uploading', message: '开始上传 2 卷' });
r3.onProgress({ stage: 'uploading', message: '打包 1.0 MB / 48 MB（2%）' }); // 假进度
r3.onProgress({ stage: 'uploading', message: '第 1/2 卷已写入' });
const milestones = job3.log.filter((l) => !l.progress).map((l) => l.message);
check('里程碑日志都保留了', milestones.length === 2, JSON.stringify(milestones));

// ── 4. 直接从 web-rpc.js 源码确认合并逻辑存在（防实现被改回原样）
{
  const src = fs.readFileSync(`${LIB}/web-rpc.js`, 'utf8');
  check('jobReporter 有进度合并逻辑（pushLog）', /const\s+pushLog\s*=/.test(src));
  check('按 stage + progress 判定同阶段进度', /last\.stage\s*===\s*evt\.stage\s*&&\s*last\.progress/.test(src));
  check('进度日志标记 progress: true', /progress:\s*true/.test(src));
  check('重复里程碑折叠计数（repeat）', /last\.repeat\s*=\s*\(last\.repeat/.test(src));
  check('job.status 返回带 stage 的日志', /log:\s*job\.log\.slice\(-50\)/.test(src));
}

// ── 5. 客户端能识别阶段并渲染图标
{
  const client = fs.readFileSync('D:/dsh-project/sync-shuttle/client/client.js', 'utf8');
  check('客户端定义了 STAGE_META', /const\s+STAGE_META\s*=/.test(client));
  check('包含 packing 阶段图标', /packing:\s*\{\s*icon:/.test(client));
  check('包含 uploading 阶段图标', /uploading:\s*\{\s*icon:/.test(client));
  check('包含 verifying 阶段图标', /verifying:\s*\{\s*icon:/.test(client));
  check('日志倒序展示', /\.slice\(\)\.reverse\(\)/.test(client));
  check('进度行淡化、里程碑加重', /isProgress\s*\?\s*0\.55/.test(client));
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
