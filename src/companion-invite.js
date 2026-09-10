import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60_000;
const ALLOWED_HOSTS = new Set(['163cn.tv', 'st.music.163.com']);

export function normalizeListenTogetherInviteUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('请提供有效的网易云一起听邀请链接。');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('邀请链接必须来自 163cn.tv 或 st.music.163.com。');
  }
  url.hash = '';
  return url.href;
}

export class CompanionInviteQueue {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.pending = new Map();
  }

  enqueue(userId, inviteUrl) {
    const createdAt = this.now();
    const invite = {
      id: randomUUID(),
      inviteUrl: normalizeListenTogetherInviteUrl(inviteUrl),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.pending.set(String(userId), invite);
    return { queued: true, ...invite };
  }

  getPending(userId, afterId = '') {
    const invite = this.pending.get(String(userId));
    if (!invite || invite.expiresAt <= this.now() || invite.id === String(afterId ?? '')) {
      if (invite?.expiresAt <= this.now()) this.pending.delete(String(userId));
      return { pending: false };
    }
    return { pending: true, invite };
  }
}
