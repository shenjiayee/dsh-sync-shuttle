// 插件加载冒烟：模拟 DSH 的 ctx 调用 apply()，验证
// ① 能真实 import ② apply 不抛错 ③ 注册了 web 路由 ④ dispose 干净。
// 不连邮箱（webServer 用假对象），所以不会产生任何网络请求。
import { pathToFileURL } from 'node:url';

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

check('导出 name = sync-shuttle', mod.name === 'sync-shuttle', String(mod.name));
check('导出 inject 数组', Array.isArray(mod.inject), JSON.stringify(mod.inject));
check('导出 apply 函数', typeof mod.apply === 'function');

// 伪造 ctx：只需要 env / webServer / tools / logger
const registered = [];
const tools = [];
const ctx = {
  env: { ...process.env, DSH_HOME: 'C:\\Users\\sjy\\.dsh' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: {
    register(options) {
      registered.push(options);
      return { dispose() {} };
    },
  },
  tools: {
    register(def) {
      tools.push(def);
      return () => {};
    },
  },
};

let dispose = null;
try {
  dispose = mod.apply(ctx, {});
  check('apply 未抛错', true);
} catch (err) {
  check('apply 未抛错', false, err.message);
  console.log(err.stack?.split('\n').slice(0, 8).join('\n'));
}

check('注册了 web 路由', registered.length === 1, String(registered.length));
if (registered.length) {
  const r = registered[0];
  check('路由类型是 prefix', r.kind === 'prefix', r.kind);
  check('路由路径是 /sync-shuttle', r.path === '/sync-shuttle', r.path);
  check('handler 是函数', typeof r.handler === 'function');
}

// 单例兜底：再 apply 一次应自动 dispose 前一个实例
try {
  const dispose2 = mod.apply(ctx, {});
  check('重复 apply 不抛错（单例兜底）', typeof dispose2 === 'function');
  check('重复 apply 后路由被重新注册', registered.length === 2, String(registered.length));
  if (typeof dispose2 === 'function') dispose2();
} catch (err) {
  check('重复 apply 不抛错（单例兜底）', false, err.message);
}

if (typeof dispose === 'function') {
  try {
    dispose();
    check('dispose 未抛错', true);
  } catch (err) {
    check('dispose 未抛错', false, err.message);
  }
}

// 数据目录结构
const fs = await import('node:fs');
const base = 'C:\\Users\\sjy\\.dsh\\sync-shuttle';
for (const p of ['tmp\\build', 'tmp\\fetch', 'logs']) {
  check(`目录已创建 ${p}`, fs.existsSync(`${base}\\${p}`));
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
