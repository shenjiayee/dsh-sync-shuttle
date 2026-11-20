// 测试脚本共用的环境解析：不把本机绝对路径写进仓库。
//
// LIB：插件源码目录。优先 DSH_PROFILE_DIR，其次默认 profile 位置。
// 从 profile 路径 import 是为了复用 profile 的 node_modules（imapflow 等），
// 并且必须配合 node --preserve-symlinks --preserve-symlinks-main 运行。
//
// ⚠️ 本文件加载时会做一次「代码新鲜度」检查（见下方 assertPluginRootFresh）：
// 如果 PLUGIN_ROOT 指向的代码与测试脚本所在的工作区不一致，直接报错终止。
// 这是为了防止「在旧副本上跑测试，却得出新代码通过的结论」——真发生过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HOME = os.homedir();

export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');

export const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ||
  path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop');

/**
 * 测试脚本所在的工作区根目录（cred.mjs 位于 <workspace>/test/ 下）。
 * 用自身位置反推，而不是用 cwd——cwd 可能是任意目录。
 */
export const WORKSPACE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PLUGIN_ROOT =
  process.env.SS_PLUGIN_ROOT || path.join(PROFILE_DIR, 'local-plugins', 'sync-shuttle');

export const LIB = path.join(PLUGIN_ROOT, 'lib').replace(/\\/g, '/');

export const PROFILE_NM = path.join(PROFILE_DIR, 'node_modules').replace(/\\/g, '/');

/**
 * 递归列出目录下所有 .js 文件，返回相对路径 → sha256 的映射。
 * 只用于比对两份 lib 是否同一份代码，不涉及业务逻辑。
 */
function fingerprintLib(root) {
  const libDir = path.join(root, 'lib');
  const out = new Map();
  if (!fs.existsSync(libDir)) return out;

  const walk = (dir, base = '') => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile() && e.name.endsWith('.js')) {
        try {
          out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
        } catch {
          /* 读不到就跳过，靠后续的缺失判断 */
        }
      }
    }
  };
  walk(libDir);
  return out;
}

/** 判断两个目录是否指向同一物理位置（junction / 软链会被 realpath 归一）。 */
function samePhysicalDir(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * 校验 PLUGIN_ROOT 与工作区是同一份代码。
 *
 * 为什么需要：插件通过 Junction 挂在 profile 下，而 Junction 可能指向另一份旧副本。
 * 若不检查，测试会安安静静地在旧代码上跑完并「全部通过」，
 * 让人误以为工作区的改动已被验证——这是真实踩过的坑。
 *
 * 放行条件（满足任一）：
 *   1. SS_SKIP_PLUGIN_ROOT_CHECK=1（显式跳过，会打印醒目警告）
 *   2. 两者是同一物理目录（realpath 相同）
 *   3. 两者 lib/ 下所有 .js 内容完全一致
 *
 * @throws 不一致时抛错，并列出具体差异文件
 */
function assertPluginRootFresh() {
  if (process.env.SS_SKIP_PLUGIN_ROOT_CHECK === '1') {
    console.log('');
    console.log('  ╔════════════════════════════════════════════════════════════╗');
    console.log('  ║ ⚠️  已跳过 PLUGIN_ROOT 与工作区的一致性检查                ║');
    console.log('  ║    （SS_SKIP_PLUGIN_ROOT_CHECK=1）                        ║');
    console.log('  ║    测试结果可能来自旧代码，不代表当前工作区！              ║');
    console.log('  ╚════════════════════════════════════════════════════════════╝');
    console.log('');
    return;
  }

  // PLUGIN_ROOT 不存在：这是更早、更明确的问题
  if (!fs.existsSync(PLUGIN_ROOT)) {
    throw new Error(
      `PLUGIN_ROOT 不存在：${PLUGIN_ROOT}\n` +
        `请检查 SS_PLUGIN_ROOT 环境变量，或在工作区根目录设置：` +
        `$env:SS_PLUGIN_ROOT='${WORKSPACE_ROOT}'`,
    );
  }

  // 同一物理目录 → 直接通过（最常见：显式把 SS_PLUGIN_ROOT 指到工作区）
  if (samePhysicalDir(PLUGIN_ROOT, WORKSPACE_ROOT)) return;

  // 路径不同，但可能是 Junction 指向了同一处 → 比对内容
  const a = fingerprintLib(PLUGIN_ROOT);
  const b = fingerprintLib(WORKSPACE_ROOT);

  if (a.size === 0 || b.size === 0) {
    throw new Error(
      `无法比对代码：${a.size === 0 ? PLUGIN_ROOT : WORKSPACE_ROOT} 下没有 lib/*.js\n` +
        `  PLUGIN_ROOT  : ${PLUGIN_ROOT}（${a.size} 个 js）\n` +
        `  工作区       : ${WORKSPACE_ROOT}（${b.size} 个 js）`,
    );
  }

  const diffs = [];
  for (const [rel, hash] of b) {
    if (!a.has(rel)) diffs.push(`缺少 ${rel}（工作区有，PLUGIN_ROOT 没有）`);
    else if (a.get(rel) !== hash) diffs.push(`内容不同 ${rel}`);
  }
  for (const rel of a.keys()) {
    if (!b.has(rel)) diffs.push(`多出 ${rel}（PLUGIN_ROOT 有，工作区没有）`);
  }

  if (diffs.length === 0) return; // 内容一致，放行

  const shown = diffs.slice(0, 8).map((d) => `  · ${d}`).join('\n');
  const more = diffs.length > 8 ? `\n  … 另有 ${diffs.length - 8} 处差异` : '';
  throw new Error(
    [
      '',
      '════════════════════════════════════════════════════════════',
      ' 拒绝运行：PLUGIN_ROOT 指向的代码与工作区不一致',
      '════════════════════════════════════════════════════════════',
      '',
      `  PLUGIN_ROOT : ${PLUGIN_ROOT}`,
      `  工作区      : ${WORKSPACE_ROOT}`,
      '',
      '  差异：',
      shown + more,
      '',
      '  后果：测试会在旧代码上跑完并「全部通过」，',
      '        但完全不能证明当前工作区的改动是对的。',
      '',
      '  解决办法（任选其一）：',
      `    1) 显式指定工作区（推荐）：`,
      `         $env:SS_PLUGIN_ROOT='${WORKSPACE_ROOT}'`,
      '    2) 把 Junction 指向工作区',
      '    3) 确实要测旧副本：设 SS_SKIP_PLUGIN_ROOT_CHECK=1（会打印醒目警告）',
      '',
      '════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );
}

// 模块加载即执行：任何测试脚本 import 本文件时都会先过这道闸门
assertPluginRootFresh();

/** 动态 import 插件自己的 lib 模块。 */
export const imp = (file) => import(pathToFileURL(`${LIB}/${file}`).href);

/** 动态 import profile 里的第三方依赖（imapflow / nodemailer / mailparser）。 */
export const impNm = (spec) => import(pathToFileURL(`${PROFILE_NM}/${spec}`).href);

/** 插件的数据目录。 */
export const dataDir = () => path.join(DSH_HOME, 'sync-shuttle');

/** 凭据文件路径：优先 SS_CRED，其次桌面若干候选名。 */
export function credFile() {
  if (process.env.SS_CRED) return process.env.SS_CRED;
  const candidates = [
    path.join(HOME, 'Desktop', 'sync-shuttle-cred.txt'),
    path.join(HOME, 'sync-shuttle-cred.txt'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      '找不到凭据文件：请设置环境变量 SS_CRED 指向一个文本文件（一行邮箱地址 + 一行 16 位授权码）',
    );
  }
  return found;
}

/** 读凭据（忽略空行与 # 注释，顺序不限）。 */
export function readCred() {
  const lines = fs
    .readFileSync(credFile(), 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  const account = lines.find((s) => /^[^\s@]+@[^\s@]+$/.test(s));
  const token = lines.find((s) => /^[A-Za-z0-9]{8,32}$/.test(s));
  if (!account || !token) throw new Error('凭据文件格式不对：需要一行邮箱地址 + 一行授权码');
  return { account, token };
}

/** 把凭据写入插件自己的位置（mode 0600），让插件与测试共用。 */
export function installCred({ account, token }) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ account, token }, null, 2), { mode: 0o600 });
  return file;
}

/**
 * 测试专用的远端文件夹前缀。
 *
 * ⚠️ 测试**必须**跑在独立文件夹里，否则中途崩溃留下的残留会混进生产数据、
 * 生产锁、生产配置备份——历史上已经发生过一次（残留邮件让「清单聚合」断言变 2）。
 *
 * 这是一个**真前缀**，拼在基础名前面（与 lib/paths.js 的语义一致）：
 *   'Testing-' → Testing-Sync-Shuttle / Testing-Sync-Shuttle-Config / Testing-Sync-Shuttle-Lock
 *
 * 环境变量 SS_TEST_FOLDER_PREFIX 可以覆盖，但**一旦设置了就必须合法**：
 * 设成空串或空白会直接抛错，而不是悄悄回退到默认值——
 * 「我明明设了隔离，结果它悄悄用了别的」比直接报错危险得多。
 */
export const TEST_FOLDER_PREFIX = (() => {
  const raw = process.env.SS_TEST_FOLDER_PREFIX;
  // 未设置 → 用默认值
  if (raw === undefined) return 'Testing-';
  // 设置了（哪怕是空串）→ 必须过校验，不允许静默兜底
  return normalizeTestPrefix(raw);
})();

/**
 * 校验并规范化测试前缀。
 *
 * 拒绝的情况（每一种都曾可能导致写进生产）：
 *   · 空串 / 纯空白  → 前缀为空，拼出来就是生产名
 *   · 含非 ASCII     → IMAP 文件夹名会走 modified UTF-7，客户端对不上
 *   · 含空白字符     → " Sync-Shuttle" 与生产只差一个空格，肉眼几乎看不出
 *   · 含 '/' 等路径符 → 会被当成嵌套文件夹
 *   · 已经是 "Sync-Shuttle" → 拼出来是 Sync-Shuttle-Sync-Shuttle，显然不是本意
 *
 * 末尾的 '-' 会自动补上（'Testing' → 'Testing-'），避免 'TestingSync-Shuttle' 这种粘连。
 */
function normalizeTestPrefix(raw) {
  const value = String(raw ?? '').trim();

  if (!value) {
    throw new Error(
      '测试文件夹前缀不能为空：空前缀会拼出生产文件夹名（Sync-Shuttle），' +
        '测试脚本绝不允许操作生产数据。请设置一个合法前缀（如 Testing-），或干脆不设该环境变量以使用默认值。',
    );
  }
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error(
      `非法测试文件夹前缀：${JSON.stringify(value)}（只允许字母、数字、连字符；` +
        '不允许空白，否则会拼出与生产只差一个空格的名字）',
    );
  }
  if (/^-+$/.test(value)) {
    throw new Error(`非法测试文件夹前缀：${JSON.stringify(value)}（不能只有连字符）`);
  }
  // 已经以生产基础名结尾/开头 → 明显是误填，拒绝而不是拼出怪名字
  if (/sync-shuttle/i.test(value)) {
    throw new Error(
      `非法测试文件夹前缀：${JSON.stringify(value)}（不该包含 Sync-Shuttle，` +
        '前缀会拼在基础名前面，直接填一个短前缀即可，如 Testing-）',
    );
  }
  // 自动补尾部连字符，保证 'Testing' → 'Testing-Sync-Shuttle'
  return value.endsWith('-') ? value : `${value}-`;
}

/** 测试用的三个文件夹名（规则与 lib/paths.js 的 resolveMailFolders 完全一致）。 */
export function testFolders() {
  const prefix = TEST_FOLDER_PREFIX;
  const folders = {
    data: `${prefix}Sync-Shuttle`,
    config: `${prefix}Sync-Shuttle-Config`,
    lock: `${prefix}Sync-Shuttle-Lock`,
    prefix,
  };
  // 兜底：无论前面怎么算，最终结果都再过一道生产检查。
  // 双重保险——「测试脚本永远不碰生产」不允许有任何绕过路径。
  assertNotProduction(folders);
  return folders;
}

/**
 * 断言一组文件夹名确实是测试文件夹，绝不允许指向生产。
 *
 * 这是 test/ 下所有脚本的最后一道闸门：
 * 「测试脚本永远不碰生产」不能只靠自觉，必须在动任何写操作之前硬校验。
 *
 * @param folders resolveMailFolders 或 testFolders 的返回值
 * @throws 如果这组名字等于生产文件夹名，直接抛错终止
 */
export function assertNotProduction(folders) {
  const prod = { data: 'Sync-Shuttle', config: 'Sync-Shuttle-Config', lock: 'Sync-Shuttle-Lock' };

  if (!folders || typeof folders !== 'object') {
    throw new Error('拒绝执行：没有可用的文件夹配置');
  }

  // 1. 任一文件夹名与生产完全相同 → 拒绝
  const clash = Object.keys(prod).filter((k) => folders[k] === prod[k]);
  if (clash.length) {
    throw new Error(
      `拒绝执行：目标文件夹是生产文件夹（${clash.map((k) => prod[k]).join('、')}）。` +
        '测试脚本永远不碰生产数据；请使用带前缀的测试文件夹。',
    );
  }

  // 2. 前缀必须非空
  if (!folders.prefix) {
    throw new Error('拒绝执行：测试文件夹必须带前缀（prefix 为空说明指向了生产）。');
  }

  // 3. 去空白后不能等于生产名 —— 防 " Sync-Shuttle" 这种只差空格的近似值
  const norm = (s) => String(s ?? '').trim();
  const subtle = Object.keys(prod).filter((k) => norm(folders[k]) === prod[k]);
  if (subtle.length) {
    throw new Error(
      `拒绝执行：文件夹名去掉首尾空白后等于生产名（${subtle.map((k) => prod[k]).join('、')}）。`,
    );
  }
}
