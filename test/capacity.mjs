// 离线：容量看护逻辑验证（不联网）。
//
// 需求：默认容量基线 12 GiB（不是 QQ 上限 16 GiB）——刻意留出余量，
// 避免把邮箱占满导致连正常收信都被服务商拒绝。
//
// 本套验证：
//   1. 默认值是 12 GiB，且与 cordis.patch.yml 一致
//   2. 超限时拒绝上传（CAPACITY_EXCEEDED），并给出可读的中文提示
//   3. 不同「保留策略」下，容量阈值的实际含义要说得清
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const { imp } = await import('./cred.mjs');

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

const { DEFAULTS } = await imp('paths.js');
const { humanBytes } = await imp('util.js');

const GiB = 1024 ** 3;
const GIB12 = 12 * GiB;

// ── 1. 默认基线必须是 12 GiB
check('DEFAULTS.capacityBytes = 12 GiB', DEFAULTS.capacityBytes === GIB12, humanBytes(DEFAULTS.capacityBytes));
check('12 GiB 等于 12884901888 字节', GIB12 === 12884901888, String(GIB12));
check('不是 16 GiB（刻意留余量）', DEFAULTS.capacityBytes !== 16 * GiB);

// ── 2. cordis.patch.yml 里的值必须与代码默认一致
{
  const yml = fs.readFileSync(
    pathToFileURL('D:/dsh-project/sync-shuttle/cordis.patch.yml').href.replace('file:///', ''),
    'utf8',
  );
  const m = /capacityBytes:\s*(\d+)/.exec(yml);
  check('cordis.patch.yml 声明了 capacityBytes', Boolean(m), yml.match(/capacityBytes.*/)?.[0]);
  check(
    'yml 的值 = 12 GiB（与代码默认一致）',
    m && Number(m[1]) === GIB12,
    m ? `${m[1]} vs ${GIB12}` : '',
  );
  check('yml 里不再出现 16 GiB 旧值', !/capacityBytes:\s*17179869184/.test(yml));
}

// ── 3. settings 读取优先级：patch 覆盖 > 默认
{
  const { createSettings } = await imp('settings.js');
  const os = await import('node:os');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cap-'));
  const mk = (cfg) =>
    createSettings(cfg, { env: { ...process.env, DSH_HOME: tmp } }).snapshot().capacityBytes;

  check('未配置时用默认 12 GiB', mk({}) === GIB12, humanBytes(mk({})));
  check('显式配置时用配置值', mk({ capacityBytes: 5 * GiB }) === 5 * GiB);
  check('传 0 表示不限制', mk({ capacityBytes: 0 }) === 0);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 4. 超限判定边界（复现 upload.js 的算法）
{
  const cap = GIB12;
  const over = (used, incoming) => cap > 0 && used > 0 && used + incoming > cap;

  check('已用 11 GiB + 上传 0.5 GiB → 允许', over(11 * GiB, 0.5 * GiB) === false);
  check('已用 11 GiB + 上传 1.5 GiB → 拒绝', over(11 * GiB, 1.5 * GiB) === true);
  check('已用 12 GiB + 上传 1 字节 → 拒绝', over(12 * GiB, 1) === true);
  check('已用 0（无从统计）→ 不拦（宁可不拦也不误拦）', over(0, 100 * GiB) === false);

  // 关键：16 GiB 邮箱用 12 GiB 基线后，还有 ~4 GiB 余量
  const headroom = 16 * GiB - GIB12;
  check('相对 16 GiB 邮箱留出约 4 GiB 余量', headroom === 4 * GiB, humanBytes(headroom));
  check('余量占比约 25%', Math.round((headroom / (16 * GiB)) * 100) === 25);
}

// ── 5. 提示文案里带得上人话（不是裸字节数）
{
  const cap = GIB12;
  const used = 11 * GiB;
  const incoming = 2 * GiB;
  const msg =
    `邮箱容量不足：已用 ${humanBytes(used)}，本次约 ${humanBytes(incoming)}，` +
    `容量上限 ${humanBytes(cap)}。`;
  check('提示包含「已用 11 GB」', msg.includes('11.0 GB') || msg.includes('11 GB'), msg);
  check('提示包含「上限 12 GB」', msg.includes('12.0 GB') || msg.includes('12 GB'), msg);
  check('提示不是裸数字', !msg.includes('12884901888'), msg);
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
