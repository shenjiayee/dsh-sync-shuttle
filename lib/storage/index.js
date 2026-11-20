// 存储适配器工厂。
//
// 核心流程只通过 createStorageAdapter() 拿一个 adapter，不直接 import 任何具体实现。
// 以后加局域网 SMB 时，这里加一个分支即可，upload/download/manifest 一行都不用改。

import { assertAdapter } from './adapter.js';
import { createQqmailAdapter } from './qqmail.js';

/** 目前支持的后端。新增时在这里登记。 */
export const STORAGE_KINDS = Object.freeze({
  qqmail: 'QQ 邮箱（IMAP）',
  // smb: '局域网共享（未实现）',
});

/** 默认后端。 */
export const DEFAULT_STORAGE_KIND = 'qqmail';

/**
 * 构造一个 storage adapter。
 *
 * @param kind    后端标识（默认 qqmail）
 * @param options 传给具体实现的参数
 * @returns 通过 assertAdapter 校验的 adapter
 */
export function createStorageAdapter(kind, options = {}) {
  const id = String(kind || DEFAULT_STORAGE_KIND);

  let adapter;
  switch (id) {
    case 'qqmail':
      adapter = createQqmailAdapter(options);
      break;
    default:
      throw new Error(
        `未知的存储后端：${id}（可用：${Object.keys(STORAGE_KINDS).join(', ')}）`,
      );
  }

  return assertAdapter(adapter);
}
