// The OAuth secret's lifecycle against a fake provider: connect stores the
// grant, a live token is handed back untouched, a lapsing one is refreshed
// exactly once however many ask, a revoked grant marks the row expired and
// a provider outage does not. Run: npm test (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthSecrets, OAuthSecretError, OAUTH_REDIRECT_URI, type OAuthRecord, type OAuthSecretStore, type OAuthState, type OAuthVault } from './OAuthSecrets.js';

const CHAIN = ['global'];

/** A store with one row, remembering every save. */
function memoryStore(oauth: OAuthState, vault: OAuthVault): OAuthSecretStore & { rows: Map<string, OAuthRecord>; saves: number } {
  const rows = new Map<string, OAuthRecord>([['GH', { scope: 'global', description: 'd', oauth, vault }]]);
  const store = {
    rows, saves: 0,
    loadOAuth: async (name: string) => rows.get(name),
    saveOAuth: async (scope: string, name: string, description: string, oauth: OAuthState, vault: OAuthVault) => {
      store.saves += 1; rows.set(name, { scope, description, oauth, vault });
    },
  };
  return store;
}

/** A token endpoint: answers every POST with `reply` (a status + JSON), counting calls. */
function provider(reply: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: URLSearchParams; headers: Headers }> = [];
  const fetch = async (url: string, init: { method?: string; body?: string; headers?: HeadersInit }) => {
    calls.push({ url, body: new URLSearchParams(init.body ?? ''), headers: new Headers(init.headers) });
    const { status, body } = await reply();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetch as never };
}

const connected = (expiresAt: number | null): OAuthState =>
  ({ provider: 'gitlab', clientId: 'id', scopes: ['api'], status: 'connected', expiresAt, accountEmail: null });

test('a live token is handed back without touching the provider', async () => {
  const store = memoryStore(connected(Date.now() + 3_600_000), { clientSecret: 's', accessToken: 'live', refreshToken: 'r1' });
  const api = provider(() => { throw new Error('must not be called'); });
  const oauth = new OAuthSecrets(store, api.fetch);
  assert.equal(await oauth.token('GH', CHAIN), 'live');
  assert.equal(api.calls.length, 0);
});

test('a lapsing token is refreshed once, however many ask at the same time', async () => {
  const store = memoryStore(connected(Date.now() + 10_000), { clientSecret: 's', accessToken: 'old', refreshToken: 'r1' });
  const api = provider(() => new Promise((resolve) => setTimeout(() => resolve({ status: 200,
    body: { access_token: 'new', refresh_token: 'r2', token_type: 'bearer', expires_in: 7200 } }), 20)));
  const oauth = new OAuthSecrets(store, api.fetch);
  const tokens = await Promise.all([oauth.token('GH', CHAIN), oauth.token('GH', CHAIN), oauth.token('GH', CHAIN)]);
  assert.deepEqual(tokens, ['new', 'new', 'new']);
  assert.equal(api.calls.length, 1, 'one refresh for three callers');
  const call = api.calls[0];
  assert.equal(call.url, 'https://gitlab.com/oauth/token');
  assert.equal(call.body.get('grant_type'), 'refresh_token');
  assert.equal(call.body.get('refresh_token'), 'r1');
  assert.equal(call.body.get('client_secret'), 's', 'gitlab: secret in the body');
  const row = store.rows.get('GH')!;
  assert.equal(row.vault.refreshToken, 'r2', 'the rotated refresh token is kept');
  assert.equal(row.vault.accessToken, 'new');
  assert.equal(row.oauth.status, 'connected');
  assert.ok(row.oauth.expiresAt! > Date.now() + 7_000_000);
});

test('a revoked grant marks the row expired and asks for a reconnect', async () => {
  const store = memoryStore(connected(Date.now() - 1), { clientSecret: 's', accessToken: 'old', refreshToken: 'r1' });
  const api = provider(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } }));
  const oauth = new OAuthSecrets(store, api.fetch);
  await assert.rejects(oauth.token('GH', CHAIN), (error: OAuthSecretError) => error.code === 'reconnect' && /revoked/.test(error.message));
  assert.equal(store.rows.get('GH')!.oauth.status, 'expired');
});

test('a provider outage is reported and does not cost the connection', async () => {
  const store = memoryStore(connected(Date.now() - 1), { clientSecret: 's', accessToken: 'old', refreshToken: 'r1' });
  const api = provider(() => ({ status: 503, body: { error: 'temporarily_unavailable' } }));
  const oauth = new OAuthSecrets(store, api.fetch);
  await assert.rejects(oauth.token('GH', CHAIN), (error: OAuthSecretError) => error.code === 'provider');
  assert.equal(store.rows.get('GH')!.oauth.status, 'connected', 'still connected: the next call may succeed');
  assert.equal(store.rows.get('GH')!.vault.refreshToken, 'r1');
});

test('a disconnected row asks for a reconnect without calling anyone', async () => {
  const store = memoryStore({ ...connected(null), status: 'disconnected' }, { clientSecret: 's' });
  const api = provider(() => { throw new Error('must not be called'); });
  await assert.rejects(new OAuthSecrets(store, api.fetch).token('GH', CHAIN), (error: OAuthSecretError) => error.code === 'reconnect');
});

test('connect: the authorization URL carries PKCE and state; the callback exchanges the code and stores the grant', async () => {
  const store = memoryStore({ ...connected(null), status: 'disconnected' }, { clientSecret: 's' });
  const api = provider(() => ({ status: 200, body: { access_token: 'a1', refresh_token: 'r1', token_type: 'bearer', expires_in: 3600 } }));
  const oauth = new OAuthSecrets(store, api.fetch);
  const url = new URL(await oauth.start('GH', CHAIN));
  assert.equal(url.origin + url.pathname, 'https://gitlab.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'id');
  assert.equal(url.searchParams.get('redirect_uri'), OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), 'api');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const state = url.searchParams.get('state')!;
  assert.ok(state.length > 10);

  // The wrong state is refused before any exchange.
  await assert.rejects(oauth.callback('GH', `${OAUTH_REDIRECT_URI}?code=c&state=wrong`), (error: OAuthSecretError) => error.code === 'provider');
  assert.equal(api.calls.length, 0);
  // The flow is consumed by that attempt: a second callback needs a new start.
  await assert.rejects(oauth.callback('GH', `${OAUTH_REDIRECT_URI}?code=c&state=${state}`), (error: OAuthSecretError) => error.code === 'invalid_args');

  const state2 = new URL(await oauth.start('GH', CHAIN)).searchParams.get('state')!;
  const result = await oauth.callback('GH', `${OAUTH_REDIRECT_URI}?code=c&state=${state2}`);
  assert.equal(result.status, 'connected');
  const call = api.calls[0];
  assert.equal(call.body.get('grant_type'), 'authorization_code');
  assert.equal(call.body.get('code'), 'c');
  assert.equal(call.body.get('redirect_uri'), OAUTH_REDIRECT_URI);
  assert.ok(call.body.get('code_verifier'));
  assert.deepEqual(store.rows.get('GH')!.vault, { clientSecret: 's', accessToken: 'a1', refreshToken: 'r1' });

  await oauth.disconnect('GH', CHAIN);
  const row = store.rows.get('GH')!;
  assert.equal(row.oauth.status, 'disconnected');
  assert.deepEqual(row.vault, { clientSecret: 's' }, 'the client secret survives a disconnect');
});

test('config: the preset fills default scopes; a custom provider needs both https endpoints', () => {
  assert.deepEqual(OAuthSecrets.config({ provider: 'google', clientId: ' x ' }),
    { provider: 'google', clientId: 'x', scopes: ['openid', 'email', 'profile'] });
  assert.throws(() => OAuthSecrets.config({ provider: 'nope', clientId: 'x' }), /unknown OAuth provider/);
  assert.throws(() => OAuthSecrets.config({ provider: 'google' }), /clientId/);
  assert.throws(() => OAuthSecrets.config({ provider: 'custom', clientId: 'x', authUrl: 'http://a', tokenUrl: 'https://b' }), /authUrl must be an https URL/);
  assert.deepEqual(OAuthSecrets.config({ provider: 'custom', clientId: 'x', scopes: ['s'], authUrl: 'https://a/auth', tokenUrl: 'https://a/token' }),
    { provider: 'custom', clientId: 'x', scopes: ['s'], authUrl: 'https://a/auth', tokenUrl: 'https://a/token' });
});
