import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PersonalAuthStore, parseMasterKey } from '../src/personal-store.js';
import { createPersonalNeteaseServer, PERSONAL_SCOPES } from '../src/personal-server.js';

const CANONICAL_ORIGIN = 'http://127.0.0.1';
const RESOURCE = `${CANONICAL_ORIGIN}/mcp`;

async function withServer(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'netease-personal-server-'));
  const store = new PersonalAuthStore({
    filePath: join(directory, 'auth.json'),
    masterKey: parseMasterKey('2'.repeat(64)),
    allowedScopes: PERSONAL_SCOPES,
  });
  const errors = [];
  const instance = await createPersonalNeteaseServer({
    origin: CANONICAL_ORIGIN,
    store,
    onError: (error) => errors.push(error),
  });
  await new Promise((resolve) => instance.httpServer.listen(0, '127.0.0.1', resolve));
  const address = instance.httpServer.address();
  try {
    return await operation({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
      errors,
    });
  } finally {
    await instance.close();
  }
}

async function readMcpResponse(response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

test('publishes OAuth discovery and challenges anonymous MCP clients', async () => {
  await withServer(async ({ baseUrl }) => {
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadata.status, 200);
    assert.deepEqual((await metadata.json()).authorization_servers, [CANONICAL_ORIGIN]);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
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
          clientInfo: { name: 'anonymous', version: '1' },
        },
      }),
    });
    assert.equal(unauthorized.status, 401);
    const challenge = unauthorized.headers.get('www-authenticate');
    assert.match(challenge, /oauth-protected-resource\/mcp/);
    assert.match(challenge, /music:read/);
    assert.match(challenge, /playlist:read/);
    assert.match(challenge, /playlist:write/);
    assert.match(challenge, /player:control/);
  });
});

test('allows one-time owner setup and rejects a second owner', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const setupPage = await fetch(`${baseUrl}/setup`);
    assert.equal(setupPage.status, 200);
    assert.match(await setupPage.text(), /每个部署只能创建一个所有者/);

    const setup = await fetch(`${baseUrl}/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'only_owner',
        password: 'one private instance password',
        return_to: '/dashboard',
      }),
    });
    assert.equal(setup.status, 303);
    assert.equal(setup.headers.get('location'), '/dashboard');
    assert.equal((await store.getOwner()).username, 'only_owner');

    const secondSetup = await fetch(`${baseUrl}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'second_owner',
        password: 'should never create another owner',
      }),
    });
    assert.equal(secondSetup.status, 409);
    assert.equal((await secondSetup.json()).error, 'already_initialized');
  });
});

test('completes dynamic registration, PKCE authorization and MCP access', async () => {
  await withServer(async ({ baseUrl, store, errors }) => {
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'cross-platform test',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json();

    const user = await store.createOwner('personal_user', 'a secure personal password');
    const browserSession = await store.createBrowserSession(user.id);
    const verifier = 'p'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${baseUrl}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', client.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', PERSONAL_SCOPES.join(' '));
    authorize.searchParams.set('state', 'test-state');
    authorize.searchParams.set('resource', RESOURCE);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');

    const consent = await fetch(authorize, {
      headers: { cookie: `nmcp_session=${browserSession.token}` },
    });
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /cross-platform test/);
    assert.match(
      consent.headers.get('content-security-policy'),
      /form-action 'self' https:\/\/claude\.ai/,
    );

    const form = new URLSearchParams(authorize.searchParams);
    form.set('decision', 'approve');
    form.set('csrf', browserSession.csrfToken);
    const approval = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `nmcp_session=${browserSession.token}`,
      },
      body: form,
    });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'test-state');
    assert.ok(callback.searchParams.get('code'));

    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: callback.searchParams.get('code'),
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'authorized', version: '1' },
        },
      }),
    });
    assert.equal(initialized.status, 200);
    const mcp = await readMcpResponse(initialized);
    assert.equal(mcp.result.serverInfo.name, 'netease-music-mcp');
    assert.deepEqual(errors, []);
  });
});
