import test from 'node:test';
import assert from 'node:assert/strict';

import { PlaybackStateStore, locateLyricLine, parseLrcLines } from '../src/playback-state.js';

test('tracks current playback and projects position while playing', () => {
  const store = new PlaybackStateStore();
  store.update({ songId: '123', title: 'Song', artist: 'Artist', positionMs: 1000, durationMs: 5000, isPlaying: true }, 10_000);
  const state = store.snapshot(12_000);
  assert.equal(state.positionMs, 3000);
  assert.deepEqual(state.artists, ['Artist']);
  assert.equal(state.stale, false);
});

test('emits a cut event when the track changes', () => {
  const store = new PlaybackStateStore();
  store.update({ songId: '1', title: 'One' }, 1000);
  store.update({ songId: '2', title: 'Two' }, 2000);
  const result = store.listEvents();
  assert.equal(result.latestSequence, 1);
  assert.equal(result.events[0].from.songId, '1');
  assert.equal(result.events[0].to.songId, '2');
});

test('parses LRC timestamps and locates the current line', () => {
  const lrc = '[00:01.00]first\n[00:05.250]second\n[00:09]third';
  assert.equal(parseLrcLines(lrc)[1].timeMs, 5250);
  const located = locateLyricLine(lrc, 7000);
  assert.equal(located.current.text, 'second');
  assert.equal(located.next.text, 'third');
});
