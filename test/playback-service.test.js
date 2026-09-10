import test from 'node:test';
import assert from 'node:assert/strict';

import { PlaybackService } from '../src/playback-service.js';

test('matches a missing song id exactly and returns the current lyric', async () => {
  let now = 10_000;
  const service = new PlaybackService({
    now: () => now,
    searchSongs: async () => ({ songs: [{ id: 42, name: '盛夏', artists: ['毛不易'] }] }),
    getLyrics: async () => ({
      lyric: '[00:01]第一句\n[00:05]第二句',
      translatedLyric: '',
      romanizedLyric: '',
    }),
  });
  await service.report({ title: '盛夏', artist: '毛不易', positionMs: 2000, isPlaying: true });
  now = 11_000;
  const state = await service.nowPlaying();
  assert.equal(state.songId, '42');
  assert.equal(state.songIdSource, 'netease_exact_match');
  assert.equal(state.positionMs, 3000);
  assert.equal(state.lyrics.current.text, '第一句');
  assert.equal('full' in state.lyrics, false);
});

test('does not guess a song id from a non-exact search result', async () => {
  const service = new PlaybackService({
    searchSongs: async () => ({ songs: [{ id: 99, name: '不同的歌', artists: ['别人'] }] }),
  });
  await service.report({ title: '想听的歌', artist: '歌手' });
  const state = await service.nowPlaying();
  assert.equal(state.songId, null);
  assert.equal(state.lyricsUnavailableReason, 'song_id_unavailable');
});
