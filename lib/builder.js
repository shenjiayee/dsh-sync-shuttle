// 用 nodemailer 的 streamTransport 构造完整 RFC822 报文（Buffer），
// 不经过 SMTP —— 造好直接交给 IMAP APPEND。
//
// 这一步是方案 B 的基础：全程不碰 SMTP、不进收件箱、不触发通知、只存一份。

import nodemailer from 'nodemailer';

/** 复用同一个 streamTransport（无状态，安全）。 */
const streamTransport = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: 'unix',
});

/**
 * @param opts.from/to       发件人收件人（都用自己账号）
 * @param opts.subject       主题（给人看，已净化）
 * @param opts.headers       自定义头（值必须纯 ASCII）
 * @param opts.text          正文纯文本
 * @param opts.attachments   [{ filename, content: Buffer }]
 * @returns Promise<Buffer>  完整报文
 */
export async function buildRawMessage(opts) {
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) {
    headers[k] = String(v);
  }
  const info = await streamTransport.sendMail({
    from: opts.from,
    to: opts.to || opts.from,
    subject: opts.subject || '(no subject)',
    text: opts.text || '',
    headers,
    attachments: opts.attachments || [],
  });
  if (!info || !info.message) {
    throw new Error('构造邮件报文失败：nodemailer 没有返回 message');
  }
  return Buffer.isBuffer(info.message) ? info.message : Buffer.from(info.message);
}

/** 估算一封报文的最终字节数（含 base64 膨胀），用于上传前预检。 */
export function estimateRawBytes(attachmentBytes, { filenameLength = 64, bodyBytes = 1024 } = {}) {
  const base64 = Math.ceil(Number(attachmentBytes || 0) / 3) * 4;
  const overhead = 2 * filenameLength + bodyBytes + 2000;
  return base64 + overhead;
}

/** 实测的 QQ 单封上限（§9.2）：附件 51 MiB / 报文 68.9 MiB。 */
export const LIMITS = Object.freeze({
  attachmentBytes: 51 * 1024 * 1024,
  rawBytes: 68.9 * 1024 * 1024,
});
