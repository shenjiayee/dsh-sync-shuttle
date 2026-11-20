// 离线：静态检查 —— 引用了未声明的标识符。
//
// 背景：重构 adapter 时把 web-rpc.js 里的 `session` 变量删掉了，
// 但 runUpload({ session, ... }) 的传参没删，导致上传一运行就
// "session is not defined"。`node --check` 只查语法，查不出这种
// 「语法合法但运行时必崩」的引用，只有真跑一次上传才会暴露。
//
// 本测试用 AST 级别的近似检查（不引入外部解析器）：
//   1. 逐文件扫描「对象字面量里出现 identifier,」这种简写传参
//   2. 与同文件内已知的声明（const/let/var/参数解构）比对
//   3. 报告那些"看起来是变量但从未声明"的裸标识符
//
// 为了降低误报，只检查一组**已知的高风险名字**（重构中删掉的那些）：
// 它们曾经存在、被删后最容易留下悬空引用。
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ' :: ' + String(extra).slice(0, 250) : ''}`);
  }
};

const LIB = 'D:/dsh-project/sync-shuttle/lib';

// 重构过程中删除 / 改名过的高风险标识符。
// 如果这些名字出现在「简写传参」位置（`session,` 这种），但文件内没有声明，就是悬空引用。
const HIGH_RISK = [
  'session', // 被 adapter 内部 ensureSession() 取代
  'makeSession', // 仍存在，但要确认使用处有声明
  'password', // 加密功能移除后应彻底消失
  'sevenZipPath', // 7z 改为内置 ZIP 后移除
  'compression', // 同上
  'lock', // 局部变量，需确认声明
  'manifestBody', // 上传流程重构后可能残留
  'conn', // 连接对象
];

/** 读取文件内容。 */
function readLib(rel) {
  return fs.readFileSync(path.join(LIB, rel), 'utf8');
}

/** 列出 lib 下所有 js。 */
function listLib() {
  const out = [];
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  walk(LIB, '');
  return out;
}

/**
 * 检查一个文件里是否用到了某标识符但从未声明。
 * 判定方式（保守，宁可漏报不误报）：
 *   - 出现 `name,` 这种简写形态
 *   - 文件里没有 `name` 的声明（const/let/var/function/参数/解构/import）
 */
function isUndeclared(src, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 转义，name 里可能有特殊字符

  // 该名字是否在文件里被声明过。这里要覆盖跨行解构：
  //   const {
  //     storage,
  //     session,     ← 这是合法声明
  //   } = ctx;
  // 所以除了常规模式，还要检查「名字是否出现在 `= ctx` / `= opts` 之前的解构块里」。
  const declaredPatterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`),
    new RegExp(`\\bfunction\\s+${n}\\b`),
    new RegExp(`\\(\\s*[^)]*\\b${n}\\b[^)]*\\)\\s*=>`), // 箭头函数参数
    new RegExp(`\\bfunction\\s*[\\w$]*\\s*\\([^)]*\\b${n}\\b`), // 函数参数
    new RegExp(`import[^;]*\\b${n}\\b`),
  ];
  // 宽松解构：`{ ... name ... } = <expr>` 允许跨行，且解构体内可能有 `{}`（如 options = {}）
  if (new RegExp(`\\{[\\s\\S]*?\\b${n}\\b[\\s\\S]*?\\}\\s*=\\s*[\\w$.]`).test(src)) return false;
  if (declaredPatterns.some((p) => p.test(src))) return false;

  // 该名字是否真的被"当变量用"（简写传参 / 简写对象成员）
  const usedPatterns = [
    new RegExp(`^\\s*${n},\\s*$`, 'm'), // 对象字面量简写：单独一行 `  session,`
    new RegExp(`\\b${n}\\s*,\\s*$`, 'm'),
  ];
  return usedPatterns.some((p) => p.test(src));
}

console.log('=== 高风险标识符的悬空引用检查 ===');
const files = listLib();
let badCount = 0;

for (const rel of files) {
  const src = readLib(rel);
  for (const name of HIGH_RISK) {
    if (isUndeclared(src, name)) {
      // 再确认：不在注释行里
      const lines = src.split(/\r?\n/);
      const hitLines = [];
      lines.forEach((l, i) => {
        const trimmed = l.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (new RegExp(`^${name},$`).test(trimmed)) hitLines.push(i + 1);
      });
      if (hitLines.length) {
        badCount += 1;
        console.log(`  ✗ ${rel} 使用了未声明的 ${name}（行 ${hitLines.join(', ')}）`);
      }
    }
  }
}
check('lib 下没有悬空的简写传参引用', badCount === 0, `发现 ${badCount} 处`);

console.log('');
console.log('=== 重点核对：web-rpc.js 的上传/下载调用参数 ===');
{
  const src = readLib('web-rpc.js');
  // runUpload({ ... }) 的实参块里不应出现 session
  const uploadBlock = /runUpload\(\{([\s\S]*?)\}\)/.exec(src);
  check(
    'runUpload 调用未传 session（adapter 内部自管会话）',
    uploadBlock ? !/^\s*session,\s*$/m.test(uploadBlock[1]) : true,
    uploadBlock ? '(检查到 runUpload 参数块)' : '(未找到 runUpload 调用)',
  );

  const dlBlock = /runDownload\(\{([\s\S]*?)\}\)/.exec(src);
  check(
    'runDownload 调用未传 session',
    dlBlock ? !/^\s*session,\s*$/m.test(dlBlock[1]) : true,
    dlBlock ? '(检查到 runDownload 参数块)' : '(未找到 runDownload 调用)',
  );

  check(
    'runUpload 传了 storage（新路径必须项）',
    uploadBlock ? /^\s*storage,\s*$/m.test(uploadBlock[1]) : false,
  );
  check(
    'runDownload 传了 storage',
    dlBlock ? /^\s*storage,\s*$/m.test(dlBlock[1]) : false,
  );
}

console.log('');
console.log('=== 重点核对：upload.js / download.js 内部对 session 的使用 ===');
{
  // 这两个文件里 session 只应作为解构出的可选参数出现（兼容旧调用），
  // 且必须在使用前判空 —— 否则 adapter 路径下会 undefined 访问崩掉。
  for (const rel of ['upload.js', 'download.js']) {
    const src = readLib(rel);
    // 解构可能跨行，且体内可能有 `{}`（options = {}）：
    //   const {\n storage,\n session,\n options = {},\n } = ctx;
    const destructured = /const\s*\{[\s\S]*?\bsession\b[\s\S]*?\}\s*=\s*ctx/.test(src);
    check(`${rel} 从 ctx 解构出 session`, destructured, src.indexOf('session') < 0 ? '文件里没有 session' : '');

    // 找出所有 session.xxx 的调用点
    const uses = [...src.matchAll(/\bsession\.(\w+)/g)].map((m) => m[1]);
    check(
      `${rel} 有 session 使用点（旧路径兜底）`,
      uses.length > 0,
      uses.length ? `调用: ${[...new Set(uses)].join(', ')}` : '无（可能已完全移除）',
    );

    // 关键：所有 session 使用点都必须在 storage 分支内被跳过，或者有判空保护。
    // 这里做静态近似：确认文件里存在 `if (storage)` / `storage.get` / `storage.put` 分支，
    // 说明新路径优先、session 只在旧路径用。
    const hasStorageBranch = /if\s*\(\s*storage\s*\)|storage\.(get|put|list|remove)\(/.test(src);
    check(`${rel} 有 storage 新路径分支`, hasStorageBranch);
  }
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
