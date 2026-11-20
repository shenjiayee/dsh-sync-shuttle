# 测试说明

十套测试，共 **294 项检查**。分两类：离线（不需要邮箱）与联网（需要真实邮箱授权码）。

## ⚠️ 铁律：测试脚本永远不碰生产

**联网测试全部跑在带 `Testing-` 前缀的独立文件夹里，生产的三个文件夹一个都不会被读写。**

| | 生产文件夹 | 测试文件夹 |
|---|---|---|
| 数据 | `Sync-Shuttle` | `Testing-Sync-Shuttle` |
| 配置备份 | `Sync-Shuttle-Config` | `Testing-Sync-Shuttle-Config` |
| 锁 | `Sync-Shuttle-Lock` | `Testing-Sync-Shuttle-Lock` |

### 三层防御（不是靠自觉，是硬校验）

1. **`testFolders()` 内部调用 `assertNotProduction()`** —— 任何调用方都无法绕过
2. **环境变量「存在但非法」直接报错** —— 不做静默兜底
   （`SS_TEST_FOLDER_PREFIX=''` 会抛错，而不是悄悄用默认值）
3. **每个测试/维护脚本显式再断言一次** —— 让「目标是测试文件夹」在代码里一眼可见

被拒绝的前缀输入：

| 输入 | 为什么危险 |
|---|---|
| `''` / `' '` / `'\t'` | 拼出生产名，或只差一个空白字符 |
| `'Sync-Shuttle'` | 误把生产基础名当前缀，拼成 `Sync-Shuttle-Sync-Shuttle` |
| `'Testing-Sync-Shuttle'` | 混淆了「前缀」与「完整文件夹名」 |
| `'-'` / `'--'` | 无意义 |
| `'中文'` / `'a/b'` / `'a b'` | 非 ASCII、路径分隔符、内部空格 |

**为什么这么严**：测试崩溃、清理失败时，残留只会留在测试文件夹里。
若测试与生产共用文件夹，一次残留邮件就足以让「清单聚合」这类断言失败（分组数偏大），
而清理时面对的是**生产文件夹**，风险极高。

### 前缀规则

前缀是**真前缀**，拼在基础名前面（与 `lib/paths.js` 的 `resolveMailFolders()` 语义一致）：

```
folderPrefix=''          → Sync-Shuttle / Sync-Shuttle-Config / Sync-Shuttle-Lock
folderPrefix='Testing-'  → Testing-Sync-Shuttle / Testing-Sync-Shuttle-Config / Testing-Sync-Shuttle-Lock
folderPrefix='MyTest'    → MyTest-Sync-Shuttle / ...   （尾部连字符自动补）
```

默认 `Testing-`，可用 `SS_TEST_FOLDER_PREFIX` 覆盖（值必须合法，否则报错终止）。

## 准备

测试脚本共用 `test/cred.mjs` 解析环境，不把任何本机路径写死：

| 环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `SS_CRED` | 凭据文件路径 | `%USERPROFILE%\Desktop\sync-shuttle-cred.txt` |
| `SS_PLUGIN_ROOT` | 插件源码根目录 | `%DSH_HOME%\profiles\<profile>\local-plugins\sync-shuttle` |
| `SS_TEST_FOLDER_PREFIX` | 测试文件夹前缀 | `Testing-` |
| `DSH_HOME` | DSH 主目录 | `%USERPROFILE%\.dsh` |
| `DSH_PROFILE` | profile 名 | `desktop` |

凭据文件格式（两行，顺序不限，`#` 开头是注释）：

```
你的账号@qq.com
16位授权码
```

授权码在邮箱网页版开启 IMAP 后生成，**不是登录密码**，只显示一次。
插件把它存在 `%DSH_HOME%\sync-shuttle\credentials.json`（mode 0600），不进仓库、不进日志。

## 跑法

联网测试**必须**加 `--preserve-symlinks --preserve-symlinks-main`：
插件通过 Junction 挂在 profile 下，ESM 默认会把软链解析回真实路径，
于是从 workspace 找不到 profile 的 `node_modules`（`imapflow` 等）。

### ⚠️ 代码新鲜度检查（会拒绝运行）

`test/cred.mjs` 在加载时会比对 **`PLUGIN_ROOT` 指向的 `lib/`** 与**测试脚本所在的**工作区**，
不一致就直接报错终止**。

原因：插件通过 Junction 挂在 profile 下，而那个 Junction 可能指向**另一份旧副本**。
不检查的话，测试会安安静静地在旧代码上跑完并「全部通过」——这真实发生过一次，
当时 `capacityBytes` 明明改成了 12 GiB，测试读到的却还是 16 GiB。

报错长这样：

```
拒绝运行：PLUGIN_ROOT 指向的代码与工作区不一致

  PLUGIN_ROOT : C:\Users\sjy\.dsh\profiles\desktop\local-plugins\sync-shuttle
  工作区      : D:\dsh-project\sync-shuttle

  差异：
  · 内容不同 paths.js
  · 缺少 lease.js（工作区有，PLUGIN_ROOT 没有）
```

解决办法（任选其一）：

| 做法 | 命令 |
|---|---|
| **显式指定工作区（推荐）** | `$env:SS_PLUGIN_ROOT='D:\dsh-project\sync-shuttle'` |
| 把 Junction 指向工作区 | 重做 junction |
| 确实要测旧副本 | `$env:SS_SKIP_PLUGIN_ROOT_CHECK='1'`（会打印醒目警告） |

工作区根目录是**从 `cred.mjs` 自身位置反推**的（它位于 `<workspace>/test/`），
所以无论从哪个 cwd 执行都能正确判断。

### 命令

```powershell
cd D:\dsh-project\sync-shuttle

# 离线：不需要邮箱
node test\smoke-local.mjs                                                    # 62 项
node --preserve-symlinks --preserve-symlinks-main test\folder-safety.mjs     # 36 项
node --preserve-symlinks --preserve-symlinks-main test\capacity.mjs          # 18 项
node --preserve-symlinks --preserve-symlinks-main test\adapters.mjs          # 42 项
node --preserve-symlinks --preserve-symlinks-main test\config-backup.mjs     # 18 项
node --preserve-symlinks --preserve-symlinks-main test\e2e-archive.mjs       # 28 项
node --preserve-symlinks --preserve-symlinks-main test\load-smoke.mjs        # 14 项
node --preserve-symlinks --preserve-symlinks-main test\rpc-smoke.mjs         # 41 项

# 联网：需要授权码（自动跑在 Testing-* 测试文件夹）
node --preserve-symlinks --preserve-symlinks-main test\e2e-online.mjs        # 21 项
node --preserve-symlinks --preserve-symlinks-main test\e2e-version.mjs       # 14 项
```

> 归档为内置纯 JS ZIP 实现，**不需要安装 7-Zip**，所以离线测试也能直接跑。

## 各套测什么

| 脚本 | 项数 | 内容 |
| --- | --- | --- |
| `smoke-local.mjs` | 62 | 项目名编码往返（中文/竖线/斜杠/空格/emoji/全角）、纯 ASCII 断言、清单正文解析、版本聚合与最新版判定、凭据脱敏、日志脱敏、原子写、路径校验 |
| `folder-safety.mjs` | 36 | **测试文件夹安全**：13 种非法前缀全部被拒（空串/空白/制表符/换行/只有连字符/非 ASCII/路径符/内部空格/误填生产名）、4 种合法前缀正确生成三文件夹、未设置时用默认、`assertNotProduction` 独立把关（含「去掉首尾空白后等于生产名」） |
| `capacity.mjs` | 18 | **容量看护**：默认基线 12 GiB（非邮箱上限 16 GiB，刻意留 4 GiB 余量）、`cordis.patch.yml` 与代码默认一致、超限时拒绝上传、边界判定、提示是「已用 11 GB / 上限 12 GB」这种人话 |
| `adapters.mjs` | 42 | 存储 adapter 契约（缺方法在构造期报错、`maxObjectBytes` 可为 null）、qqmail 分卷常量符合实测依据、`meta` 校验（大写/短一位的哈希必须被拒）、租约状态机（陈锁判定用服务器时间、拿不到时间不许判陈、锁易主不删、空锁等满心跳） |
| `config-backup.mjs` | 18 | 配置备份走 adapter：backup 回读校验 sha256、同机只留最新一份、list/restoreMine 语义、非 JSON 备份被拒绝、无备份时返回 null |
| `e2e-archive.mjs` | 28 | ZIP 打包 → 切片 → CRC32 自检 → 列表 → 拼回 → 解包 → 逐文件哈希；中文路径、空文件、深层目录；数据区损坏与截断检测；路径穿越拒绝；空目录拒绝 |
| `load-smoke.mjs` | 14 | `apply()` 不抛错、注册 `/sync-shuttle` 前缀路由、重复 apply 单例兜底、`dispose()` 干净、目录结构 |
| `rpc-smoke.mjs` | 41 | 请求/响应信封、`rpcId` 回显、405/415/400 拒绝、未知端点 404、`settings.get` 不含 token、真实 `connection.test`、配置恢复与下载确认的回归用例 |
| `e2e-online.mjs` | 21 | 抢锁 → 另一机抢锁被挡 → 上传 → 回读校验（校验 C）→ 释放锁 → 新连接看清单 → 下载镜像 → 逐文件哈希 → 空文件保留 → 多余文件被删 |
| `e2e-version.mjs` | 14 | 归档内容逐文件一致、keepPrev 1/2 版切换、历史版回滚、不支持加密时的明确拒绝（`ENCRYPTED_UNSUPPORTED`）、清理旧版本 |

## 维护脚本

两个清理脚本都**只操作测试文件夹**，并且在任何写操作之前用 `assertNotProduction()` 硬校验一次。

| 脚本 | 用途 |
| --- | --- |
| `cleanup-remote.mjs` | 清理测试文件夹里的 `SS-E2E-*` / `SS-FIX-*` 邮件、配置备份、残留锁文件夹。<br>加 `--dry` 只查看不删除 |
| `clear-lock.mjs` | 强制清空**测试**锁文件夹（仅测试崩溃残留）。加 `--dry` 只查看 |
| `dbg-hash.mjs` | 打印头字段里的片哈希与正文清单里的同片哈希，定位「哈希不符」。<br>**这是运维工具**：默认只读生产文件夹（唯一允许读生产的脚本），加 `--test` 看测试文件夹 |

> 生产的锁如果真卡住了，不属测试脚本职责——应由用户在插件界面或自行用 IMAP 客户端处理。

## 注意

- 联网测试用 `SS-E2E-<随机>` 项目名，跑完自动清理。
- **测试跑在 `Testing-*` 文件夹，与生产物理隔离**，测试崩溃的残留不会污染生产。
- 若某次中断留下残留：`node test/cleanup-remote.mjs`（默认就是测试文件夹）。
- 联网测试会真连邮箱、真写分卷，请勿在正式同步进行中同时跑。
- 想彻底删除测试痕迹，可在邮箱网页版手动删掉 `Testing-Sync-Shuttle*` 三个文件夹。
