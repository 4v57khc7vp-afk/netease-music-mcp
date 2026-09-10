import test from 'node:test';
import assert from 'node:assert/strict';

import { createNeteaseHttpServer } from '../src/http-server.js';

const SECRET = 'a'.repeat(64);

async function readMcpResponse(response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    assert.ok(data, 'SSE response must include a data frame');
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

async function withServer(operation, options = {}) {
  const errors = [];
  const instance = createNeteaseHttpServer({
    secret: SECRET,
    onError: (error) => errors.push(error),
    ...options,
  });
  await new Promise((resolve) => instance.httpServer.listen(0, '127.0.0.1', resolve));
  const address = instance.httpServer.address();
  try {
    return await operation(`http://127.0.0.1:${address.port}`, errors);
  } finally {
    await instance.close();
  }
}

test('health check does not disclose the secret', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'netease-music-mcp' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('rejects requests that do not use the exact secret path', async () => {
  await withServer(async (origin) => {
    assert.equal((await fetch(`${origin}/mcp/wrong`)).status, 404);
    assert.equal((await fetch(`${origin}/mcp/${SECRET}/extra`)).status, 404);
  });
});

test('rejects oversized request bodies', async () => {
  await withServer(
    async (origin) => {
      const response = await fetch(`${origin}/mcp/${SECRET}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'.repeat(10),
      });
      assert.equal(response.status, 413);
    },
    { maxBodyBytes: 8 },
  );
});

test('serves MCP initialize and tools/list over stateless HTTP', async () => {
  await withServer(async (origin, errors) => {
    const endpoint = `${origin}/mcp/${SECRET}`;
    const initialize = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initialize.status, 200);
    const initialized = await readMcpResponse(initialize);
    assert.equal(initialized.result.serverInfo.name, 'netease-music-mcp');

    const tools = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(tools.status, 200);
    const listed = await readMcpResponse(tools);
    assert.equal(listed.result.tools.length, 21);
    assert.ok(listed.result.tools.some((tool) => tool.name === 'netease_now_playing'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'netease_playback_events'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'netease_control'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'netease_next_track'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'netease_playlist_create'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'netease_playlist_add_songs'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'netease_playlist_remove_songs'));
    assert.ok(
      listed.result.tools.some((tool) => tool.name === 'netease_listen_together_invite'),
    );
    assert.ok(
      listed.result.tools.some(
        (tool) => tool.name === 'netease_listen_together_capabilities',
      ),
    );
    assert.deepEqual(errors, []);
  });
});
