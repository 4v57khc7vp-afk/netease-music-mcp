const MAX_EVENTS = 100;
const DEFAULT_STALE_AFTER_MS = 15_000;

function finiteNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return Math.round(number);
}

function shortText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizeArtists(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[,/&、，]+/);
  return values.map((item) => shortText(item, 100)).filter(Boolean).slice(0, 10);
}

function trackKey(state) {
  if (state.songId) return `id:${state.songId}`;
  if (state.title) return `meta:${state.title.toLocaleLowerCase()}\u0000${state.artists.join(',').toLocaleLowerCase()}`;
  return null;
}

export function parsePlaybackReport(report, now = Date.now()) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('播放状态必须是 JSON 对象。');
  }
  const songId = shortText(report.songId, 20);
  if (songId && !/^\d{1,20}$/.test(songId)) {
    throw new Error('songId 必须是 1–20 位数字。');
  }
  const title = shortText(report.title, 200);
  if (!songId && !title) throw new Error('播放状态至少需要 songId 或 title。');

  const positionMs = finiteNumber(report.positionMs, { max: 24 * 60 * 60 * 1000 });
  const durationMs = finiteNumber(report.durationMs, { max: 24 * 60 * 60 * 1000 });
  const reportedAt = finiteNumber(report.reportedAt, {
    min: now - 24 * 60 * 60 * 1000,
    max: now + 5 * 60 * 1000,
  });

  return {
    deviceId: shortText(report.deviceId, 100) || 'android-companion',
    songId: songId || null,
    songIdSource: songId ? (shortText(report.songIdSource, 40) || 'device') : null,
    title,
    artists: normalizeArtists(report.artists ?? report.artist),
    durationMs,
    positionMs: positionMs ?? 0,
    isPlaying: Boolean(report.isPlaying),
    playbackState: shortText(report.playbackState, 40) || (report.isPlaying ? 'playing' : 'paused'),
    reportedAt: reportedAt ?? now,
  };
}

export class PlaybackStateStore {
  constructor({ maxEvents = MAX_EVENTS, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
    this.maxEvents = maxEvents;
    this.staleAfterMs = staleAfterMs;
    this.current = null;
    this.events = [];
    this.sequence = 0;
  }

  update(report, now = Date.now()) {
    const next = { ...parsePlaybackReport(report, now), receivedAt: now };
    const previous = this.current;
    const previousKey = previous ? trackKey(previous) : null;
    const nextKey = trackKey(next);
    this.current = next;

    if (previousKey && nextKey && previousKey !== nextKey) {
      this.sequence += 1;
      this.events.push({
        sequence: this.sequence,
        type: 'track_changed',
        at: now,
        from: {
          songId: previous.songId,
          title: previous.title,
          artists: previous.artists,
        },
        to: { songId: next.songId, title: next.title, artists: next.artists },
      });
      if (this.events.length > this.maxEvents) this.events.shift();
    }
    return this.snapshot(now);
  }

  snapshot(now = Date.now()) {
    if (!this.current) return { available: false, stale: true, sequence: this.sequence };
    const elapsed = Math.max(0, now - this.current.receivedAt);
    let positionMs = this.current.positionMs;
    if (this.current.isPlaying) positionMs += elapsed;
    if (this.current.durationMs !== null) positionMs = Math.min(positionMs, this.current.durationMs);
    return {
      available: true,
      stale: elapsed > this.staleAfterMs,
      sequence: this.sequence,
      ...this.current,
      positionMs: Math.round(positionMs),
    };
  }

  listEvents({ afterSequence = 0, limit = 20 } = {}) {
    const after = Math.max(0, Number(afterSequence) || 0);
    const count = Math.min(100, Math.max(1, Number(limit) || 20));
    return {
      latestSequence: this.sequence,
      events: this.events.filter((event) => event.sequence > after).slice(-count),
    };
  }
}

export function parseLrcLines(text) {
  const lines = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!timestamps.length) continue;
    const lyric = rawLine.replace(/\[[^\]]+\]/g, '').trim();
    for (const match of timestamps) {
      const fraction = String(match[3] ?? '').padEnd(3, '0').slice(0, 3);
      lines.push({
        timeMs: Number(match[1]) * 60_000 + Number(match[2]) * 1000 + Number(fraction),
        text: lyric,
      });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export function locateLyricLine(text, positionMs) {
  const lines = parseLrcLines(text);
  if (!lines.length) return { current: null, next: null, index: -1 };
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].timeMs > positionMs) break;
    index = i;
  }
  return {
    current: index >= 0 ? lines[index] : null,
    next: lines[index + 1] ?? null,
    index,
  };
}
