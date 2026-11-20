# 存储 Adapter 重构方案

> 状态：**第一、二步已完成**（接口 + qqmail 实现 + 租约层 + 核心流程接入 + `lock.js` 删除），
> 294 项测试全绿。
> 目标：把「邮箱上传/下载/加锁」抽象成 adapter，以便后续加局域网 SMB。

---

## 1. 为什么叫 qqmail 而不是 imap

实现依赖的是**腾讯 QQ 邮箱的实测行为**，不是 IMAP 协议通用要求：

| 行为 | 说明 |
|---|---|
| 必须用 seq 读 | UID 一律返回空 |
| EXISTS 不刷新 | append 后同连接 fetch 仍 0 封，必须 close + 重新 SELECT |
| INTERNALDATE 可信 | 客户端时钟可能差几分钟，陈锁判定必须用它 |
| 51 MiB 硬上限 | 52 MiB 起报 `TOOBIG` |
| 头值必须纯 ASCII | 否则被 RFC 2047 编码且 mailparser 不解码 |
| 非空文件夹不能 DELETE | 必须先清空 |

网易 163/126/yeah 共用本实现，但**未真机实测**，UI 需标注。

---

## 2. 接口契约

见 `lib/storage/adapter.js`。核心只认这些：

```js
{
  id, displayName,
  volumeBytes,        // 固定常量，非用户配置
  maxObjectBytes,     // null = 不限制

  open() / close() / ping()

  put({ collection, key, meta, body })  // => { ref }
  get({ collection, ref })              // => { key, meta, body }
  list({ collection })                  // => [{ ref, key, meta, sizeBytes }]
  remove({ collection, refs })          // => { removed }

  lockTryCreate({ owner, nonce, ttlMs, op })
  lockInspect()   // => { holder, serverTimeMs } | null
  lockRenew({ nonce })
  lockRelease({ nonce, force })

  capacity()      // => { totalBytes, exact, note }
}
```

`collection` 只有两个值：`data`（项目分卷）、`config`（本机配置备份）。

### 三条硬性要求

1. **meta 随每个对象走**，不能每版本只写一份清单。
   这是原「护栏 3」：删到只剩 1 封仍知道该有几卷。
   SMB 没有邮件头，必须给每个分片旁挂 `<分片>.meta.json`。

2. **`lockInspect()` 必须回传 `serverTimeMs`**。
   陈锁判定用服务器时间，不用本地时钟。
   IMAP = 邮件 INTERNALDATE；SMB = 文件 mtime。

3. **`ref` 只在一次会话内有效**，不得跨会话持久化。
   重试必须重新 `list()`。

---

## 3. 分层

```
核心流程  upload.js / download.js / manifest.js / config-store.js
   │  只认 adapter 契约
   ▼
租约层    lease.js（重试、排队、心跳、陈锁判定、nonce 校验）
   │  只认 lock* 四个原语
   ▼
适配层    storage/qqmail.js
   │  翻译 collection/meta/body ↔ 文件夹/邮件头/附件
   ▼
传输层    mail.js / envelope.js / builder.js（IMAP 内部实现）
```

`lib/lock.js` 已删除：它的排队/心跳逻辑抽到了 `lease.js`，
四个锁原语落在 `storage/qqmail.js` 的 `lock*` 方法里。

---

## 4. 分卷大小归 adapter

`volumeBytes` 从 `cordis.patch.yml` 删除，改为 adapter 常量：

- qqmail：**40 MiB**（依据：51 MiB 上限留 11 MiB 余量）
- SMB（未来）：可按需设大，或干脆不分卷

旧配置里的 `volumeBytes` 启动时忽略并打日志提示。
好处：从设计上消灭「贴着 51 MiB 用导致某次 TOOBIG」这类误配置。

---

## 5. 容量

- qqmail：手填基线，`exact: false`，文案「仅统计本插件占用」
- SMB（未来）：`statfs` 真实总量，`exact: true`

`capacityBytes` **保留在配置里**，只被 qqmail 读取。

---

## 6. 落地节奏

### 第一步（✅ 已完成）

- [x] `lib/storage/adapter.js` —— 契约 + `validateMeta` + `assertAdapter`
- [x] `lib/storage/qqmail.js` —— QQ 实现
- [x] `lib/storage/index.js` —— 工厂
- [x] `lib/lease.js` —— 通用租约
- [x] `lib/index.js` 构造 adapter 并注入 dispatcher
- [x] `lib/settings.js` 增加 `storageKind`
- [x] `lib/web-rpc.js` 接收 `storage`，`status.get` 暴露 `storageInfo`
- [x] `test/adapters.mjs` —— 42 项契约测试（离线，不联网）
- [x] 现有 180 项测试全绿、行为零变化

### 第二步（✅ 已完成）

- [x] `manifest.js` 消费 `adapter.list()` 输出（entries 结构，不再解析邮件头）
- [x] `upload.js` 用 `adapter.volumeBytes` / `put` / `get` / `remove`
- [x] `download.js` 用 `storage.get({ref})`，`vol.seq` → `vol.ref`
- [x] `cleanupOldVersions` 支持 `storage` 参数
- [x] `index.js` 的 `makeLock` 改走 `LeaseGuard`
- [x] **删除 `lib/lock.js`**（`storage/qqmail.js` 的 4 个 `lock*` 原语成为唯一实现）
- [x] `cordis.patch.yml` 删 `volumeBytes`，加 `storageKind`
- [x] 联网测试改用 adapter
- [x] 全量测试：276 项全绿

### 第三步：清理过渡代码（✅ 已完成）

- [x] `web-rpc.js` 删掉 `scanRemote` / `findVersion` / `projectDelete` /
      `projectCleanResidue` 里的旧 IMAP 分支，全部走 adapter
- [x] `upload.start` / `download.start` 不再预开 IMAP 会话（adapter 内部 `ensureSession()`）
- [x] `config-store.js` 走 `collection:'config'`（backup / list / download / restoreMine）
- [x] `storage/qqmail.js` 的 config `get()` 补齐 meta（原来返回 null，上层无法做 sha256 回读校验）
- [x] `test/config-backup.mjs` —— 18 项离线测试（假 adapter 驱动，不联网）
- [x] `settings.js` 保留 `volumeBytes` 但注明「仅兜底」

### 最终状态

| 项 | 状态 |
|---|---|
| 核心流程是否仍 import IMAP 细节 | 否（upload/download/manifest/config-store 只认 adapter） |
| `lib/lock.js` | 已删除 |
| 旧路径分支 | 已全部移除；adapter 不可用时明确报 `NO_STORAGE` |
| 测试总数 | 294 项（离线 259 + 联网 35） |

---

## 7. 已知取舍

1. **投机性抽象**。目前只有 qqmail 一个实现，接口可能没抽到点上。
   缓解：只抽象确定会变的东西（对象读写、锁原语、限额、分卷大小），
   不预判用不上的能力。SMB 真来时再调整接口是正常的。

2. **SMB 与现卖点矛盾**。README 宣称「两台电脑不同时开机也能同步」，
   那是 IMAP 独有能力。SMB 需要一台机器常开。
   做 SMB 时文档要按 adapter 分别说明能力边界。

3. **测试项数会变**。`manifest` 入参结构变了，`smoke-local` 版本聚合几条要改。
