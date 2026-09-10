import { locateLyricLine, PlaybackStateStore } from './playback-state.js';

function comparable(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function exactMetadataMatch(report, song) {
  if (comparable(report.title) !== comparable(song.name)) return false;
  const reportArtists = Array.isArray(report.artists)
    ? report.artists
    : String(report.artist ?? '').split(/[,/&、，]+/).filter(Boolean);
  if (!reportArtists.length) return true;
  const wanted = new Set(reportArtists.map(comparable));
  return (song.artists ?? []).some((artist) => wanted.has(comparable(artist)));
}

export class PlaybackService {
  constructor({
    store = new PlaybackStateStore(),
    searchSongs,
    getLyrics,
    now = () => Date.now(),
  } = {}) {
    this.store = store;
    this.searchSongs = searchSongs;
    this.getLyrics = getLyrics;
    this.now = now;
    this.lyricsCache = new Map();
  }

  async report(input) {
    let report = { ...input };
    if (!report.songId && report.title && this.searchSongs) {
      try {
        const query = [report.title, ...(Array.isArray(report.artists) ? report.artists.slice(0, 1) : [report.artist])]
          .filter(Boolean)
          .join(' ');
        const result = await this.searchSongs(query, 5, 0);
        const match = (result.songs ?? []).find((song) => exactMetadataMatch(report, song));
        if (match?.id) {
          report = { ...report, songId: String(match.id), songIdSource: 'netease_exact_match' };
        }
      } catch {
        // Metadata-only playback remains useful if the anonymous search endpoint is unavailable.
      }
    }
    return this.store.update(report, this.now());
  }

  async nowPlaying({ includeFullLyrics = false } = {}) {
    const state = this.store.snapshot(this.now());
    if (!state.available || !state.songId || !this.getLyrics) {
      return {
        ...state,
        lyrics: null,
        lyricsUnavailableReason: !state.available ? 'no_device_report' : 'song_id_unavailable',
      };
    }

    let lyrics = this.lyricsCache.get(state.songId);
    if (!lyrics) {
      lyrics = await this.getLyrics(state.songId);
      this.lyricsCache.set(state.songId, lyrics);
      if (this.lyricsCache.size > 20) this.lyricsCache.delete(this.lyricsCache.keys().next().value);
    }
    const line = locateLyricLine(lyrics.lyric, state.positionMs);
    const translatedLine = locateLyricLine(lyrics.translatedLyric, state.positionMs);
    const romanizedLine = locateLyricLine(lyrics.romanizedLyric, state.positionMs);
    return {
      ...state,
      lyricsUnavailableReason: null,
      lyrics: {
        current: line.current,
        next: line.next,
        currentTranslated: translatedLine.current,
        currentRomanized: romanizedLine.current,
        lineIndex: line.index,
        ...(includeFullLyrics
          ? {
              full: lyrics.lyric,
              fullTranslated: lyrics.translatedLyric,
              fullRomanized: lyrics.romanizedLyric,
            }
          : {}),
      },
    };
  }

  events(options) {
    return this.store.listEvents(options);
  }
}
