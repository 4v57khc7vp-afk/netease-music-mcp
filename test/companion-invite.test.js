import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CompanionInviteQueue,
  normalizeListenTogetherInviteUrl,
} from '../src/companion-invite.js';

test('accepts only official NetEase listen-together invite hosts', () => {
  assert.equal(
    normalizeListenTogetherInviteUrl('https://163cn.tv/example#share'),
    'https://163cn.tv/example',
  );
  assert.throws(
    () => normalizeListenTogetherInviteUrl('https://example.com/invite'),
    /163cn\.tv/,
  );
  assert.throws(
    () => normalizeListenTogetherInviteUrl('http://163cn.tv/example'),
    /163cn\.tv/,
  );
});

test('delivers a fresh invite once per companion cursor and expires it', () => {
  let now = 1_000;
  const queue = new CompanionInviteQueue({ ttlMs: 500, now: () => now });
  const queued = queue.enqueue('owner', 'https://163cn.tv/room');
  assert.equal(queue.getPending('owner').pending, true);
  assert.deepEqual(queue.getPending('owner', queued.id), { pending: false });
  assert.deepEqual(queue.getPending('another-owner'), { pending: false });
  now = 1_501;
  assert.deepEqual(queue.getPending('owner'), { pending: false });
});
