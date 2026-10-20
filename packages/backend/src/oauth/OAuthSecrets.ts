// OAuth secrets — a secret whose value is not pasted but granted: the user
// connects an account once (the cli opens the browser, the provider sends a
// code back), and from then on the server holds the refresh token and hands
// the agent a live access token on every `secret_get`. The protocol work —
// authorization URL, PKCE, state, code exchange, refresh, client
// authentication — is openid-client's (panva; the Node OAuth client), never
// ours. What is ours: the provider presets (presets.json — endpoints,
// scopes, hints), the secret row's shape, and when to refresh.
//
// One row, two halves (storage/Settings.ts, the `secret` namespace): the
// plain value carries the connection's facts (provider, client id, scopes,
// status, expiry, account), the encrypted blob carries what must not be
// read back (client secret, access token, refresh token) as one JSON
// string. The store is handed in — Settings owns the table; this object
// owns what an OAuth secret means.
//
// Bring-your-own client: the user registers an OAuth client in the
// provider's console and pastes its id (and secret, where one is issued).
// The redirect the cli catches is a fixed `http://localhost:53682/callback`
// (rclone's convention) — most providers require the exact registered URI,
// so a random port could never match.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as client from 'openid-client';
import { publicFetch } from '../lib/publicFetch.js';
import { logger, errStr } from '../lib/log.js';
import { OAUTH_REDIRECT_URI, type OAuthPreset, type OAuthConfig, type OAuthState } from '@phantom-agent-sdk/client';

export { OAUTH_REDIRECT_URI };

const log = logger('oauth');

export type { OAuthPreset, OAuthConfig, OAuthState };

/** The encrypted half, as one JSON string in value_enc. */
export interface OAuthVault { clientSecret?: string; accessToken?: string; refreshToken?: string }

/** A secret row as this object sees it. */
export interface OAuthRecord { scope: string; description: string; oauth: OAuthState; vault: OAuthVault }

/** The store (Settings) this object reads and writes OAuth rows through. */
export interface OAuthSecretStore {
  /** The row `name` resolves to over the chain, or undefined when there is none or it is not an OAuth secret. */
  loadOAuth(name: string, chain: string[]): Promise<OAuthRecord | undefined>;
  /** Write the row's two halves at one scope. */
  saveOAuth(scope: string, name: string, description: string, oauth: OAuthState, vault: OAuthVault): Promise<void>;
}

/** Refresh this long before the real expiry, so a token handed over is not stale by the time it is used. */
const EXPIRY_SKEW_MS = 60_000;
/** A connect the browser never finished is forgotten after this. */
const FLOW_TTL_MS = 10 * 60_000;

export class OAuthSecretError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_args' | 'reconnect' | 'provider', message: string) { super(message); this.name = 'OAuthSecretError'; }
}

const PRESETS: OAuthPreset[] = JSON.parse(readFileSync(join(import.meta.dirname, 'presets.json'), 'utf8')) as OAuthPreset[];

export function oauthPreset(id: string): OAuthPreset | undefined { return PRESETS.find((preset) => preset.id === id); }

/** A browser round-trip in progress, keyed by secret name. */
interface Flow { verifier: string; state: string; chain: string[]; startedAt: number }

export class OAuthSecrets {
  readonly #flows = new Map<string, Flow>();
  /** One refresh at a time per name: two agents asking at once share it,
   *  so a provider that rotates refresh tokens never sees the stale one. */
  readonly #refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly store: OAuthSecretStore,
    /** The outbound HTTP; the public internet only, in production. */
    private readonly fetch: typeof publicFetch = publicFetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get presets(): readonly OAuthPreset[] { return PRESETS; }

  /** Check a user's config before it is stored. Returns the stored shape. */
  static config(input: Partial<OAuthConfig> | undefined): OAuthConfig {
    const provider = String(input?.provider ?? '');
    const preset = oauthPreset(provider);
    if (!preset) throw new OAuthSecretError('invalid_args', `unknown OAuth provider "${provider}" — one of ${PRESETS.map((preset) => preset.id).join(', ')}`);
    const clientId = String(input?.clientId ?? '').trim();
    if (!clientId) throw new OAuthSecretError('invalid_args', 'oauth.clientId is required');
    const scopes = Array.isArray(input?.scopes) ? input.scopes.map(String).map((scope) => scope.trim()).filter(Boolean) : [];
    const out: OAuthConfig = { provider, clientId, scopes: scopes.length ? scopes : preset.defaultScopes };
    if (preset.custom) {
      const authUrl = String(input?.authUrl ?? '').trim();
      const tokenUrl = String(input?.tokenUrl ?? '').trim();
      for (const [label, url] of [['authUrl', authUrl], ['tokenUrl', tokenUrl]] as const) {
        if (!/^https:\/\//.test(url)) throw new OAuthSecretError('invalid_args', `oauth.${label} must be an https URL`);
      }
      out.authUrl = authUrl; out.tokenUrl = tokenUrl;
    }
    return out;
  }

  /** The authorization URL to open in the browser. The flow (PKCE verifier,
   *  state) waits here for `callback`. */
  async start(name: string, chain: string[]): Promise<string> {
    const record = await this.load(name, chain);
    const { preset, config } = this.client(record);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const params: Record<string, string> = {
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: record.oauth.scopes.join(preset.scopeSeparator ?? ' '),
      state,
      ...(preset.authParams ?? {}),
    };
    if (preset.pkce) {
      params.code_challenge = await client.calculatePKCECodeChallenge(verifier);
      params.code_challenge_method = 'S256';
    }
    this.#flows.set(name, { verifier, state, chain, startedAt: this.now() });
    return client.buildAuthorizationUrl(config, params).toString();
  }

  /** The browser came back: `callbackUrl` is the full URL the cli caught.
   *  Exchanges the code, stores the tokens, marks the row connected. */
  async callback(name: string, callbackUrl: string): Promise<OAuthState> {
    const flow = this.#flows.get(name);
    this.#flows.delete(name);
    if (!flow || this.now() - flow.startedAt > FLOW_TTL_MS) throw new OAuthSecretError('invalid_args', `no connect in progress for ${name} — start again`);
    const record = await this.load(name, flow.chain);
    const { preset, config } = this.client(record);
    let tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;
    try {
      tokens = await client.authorizationCodeGrant(config, new URL(callbackUrl), {
        expectedState: flow.state,
        ...(preset.pkce ? { pkceCodeVerifier: flow.verifier } : {}),
      });
    } catch (error) {
      throw new OAuthSecretError('provider', `${preset.label} refused the connection: ${errStr(error)}`);
    }
    const oauth = this.connected(record.oauth, tokens);
    const vault: OAuthVault = {
      ...record.vault,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? record.vault.refreshToken,
    };
    await this.store.saveOAuth(record.scope, name, record.description, oauth, vault);
    log.info({ name, provider: oauth.provider }, 'oauth secret connected');
    return oauth;
  }

  /** A live access token: the stored one while it lasts, a refreshed one
   *  when it is about to lapse. Throws `reconnect` when only the user can
   *  fix it (never connected, disconnected, or the provider revoked the
   *  grant), `provider` when the refresh failed for any other reason — a
   *  network blip does not cost the connection. */
  async token(name: string, chain: string[]): Promise<string> {
    const record = await this.load(name, chain);
    const { oauth, vault } = record;
    if (oauth.status !== 'connected' || !vault.accessToken) {
      throw new OAuthSecretError('reconnect', `the ${name} connection is ${oauth.status === 'expired' ? 'expired' : 'not connected'} — reconnect it in /secrets`);
    }
    const fresh = oauth.expiresAt === null || oauth.expiresAt - EXPIRY_SKEW_MS > this.now();
    if (fresh) return vault.accessToken;
    const running = this.#refreshing.get(name);
    if (running) return running;
    const refresh = this.refresh(name, record).finally(() => this.#refreshing.delete(name));
    this.#refreshing.set(name, refresh);
    return refresh;
  }

  /** Forget the tokens; keep the client config so a reconnect needs no retyping. */
  async disconnect(name: string, chain: string[]): Promise<void> {
    const record = await this.load(name, chain);
    await this.store.saveOAuth(record.scope, name, record.description,
      { ...record.oauth, status: 'disconnected', expiresAt: null, accountEmail: null },
      { clientSecret: record.vault.clientSecret });
  }

  // ── internals ────────────────────────────────────────────────────────

  private async refresh(name: string, record: OAuthRecord): Promise<string> {
    const { preset, config } = this.client(record);
    if (!record.vault.refreshToken) {
      await this.expire(name, record);
      throw new OAuthSecretError('reconnect', `the ${name} access token expired and ${preset.label} issued no refresh token — reconnect it in /secrets`);
    }
    let tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;
    try {
      tokens = await client.refreshTokenGrant(config, record.vault.refreshToken);
    } catch (error) {
      // The grant is gone (revoked, rotated away, past its life): only the
      // user can bring it back. Anything else is the provider or the
      // network having a moment — say so, keep the connection.
      if (error instanceof client.ResponseBodyError && error.error === 'invalid_grant') {
        await this.expire(name, record);
        throw new OAuthSecretError('reconnect', `${preset.label} no longer accepts the ${name} connection (${error.error_description ?? 'invalid_grant'}) — reconnect it in /secrets`);
      }
      throw new OAuthSecretError('provider', `could not refresh the ${name} token at ${preset.label}: ${errStr(error)}`);
    }
    const oauth = this.connected(record.oauth, tokens);
    const vault: OAuthVault = {
      ...record.vault,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? record.vault.refreshToken, // some providers rotate it
    };
    await this.store.saveOAuth(record.scope, name, record.description, oauth, vault);
    return tokens.access_token;
  }

  private async expire(name: string, record: OAuthRecord): Promise<void> {
    await this.store.saveOAuth(record.scope, name, record.description, { ...record.oauth, status: 'expired' }, record.vault)
      .catch((error) => log.warn({ name, err: errStr(error) }, 'could not mark the oauth secret expired'));
  }

  private connected(previous: OAuthState, tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers): OAuthState {
    const expiresIn = tokens.expiresIn();
    const email = tokens.claims()?.email;
    return {
      ...previous,
      status: 'connected',
      expiresAt: typeof expiresIn === 'number' ? this.now() + expiresIn * 1000 : null,
      accountEmail: typeof email === 'string' ? email : previous.accountEmail,
    };
  }

  private async load(name: string, chain: string[]): Promise<OAuthRecord> {
    const record = await this.store.loadOAuth(name, chain);
    if (!record) throw new OAuthSecretError('not_found', `no OAuth secret named "${name}"`);
    return record;
  }

  /** openid-client's view of this connection: endpoints + how to authenticate the client. */
  private client(record: OAuthRecord): { preset: OAuthPreset; config: client.Configuration } {
    const { oauth, vault } = record;
    const preset = oauthPreset(oauth.provider);
    if (!preset) throw new OAuthSecretError('invalid_args', `unknown OAuth provider "${oauth.provider}"`);
    const authUrl = preset.custom ? oauth.authUrl : preset.authUrl;
    const tokenUrl = preset.custom ? oauth.tokenUrl : preset.tokenUrl;
    if (!authUrl || !tokenUrl) throw new OAuthSecretError('invalid_args', `the ${oauth.provider} connection is missing its endpoint URLs`);
    const auth = preset.clientAuth === 'none' ? client.None()
      : preset.clientAuth === 'basic' ? client.ClientSecretBasic(vault.clientSecret ?? '')
      : client.ClientSecretPost(vault.clientSecret ?? '');
    const config = new client.Configuration(
      { issuer: new URL(tokenUrl).origin, authorization_endpoint: authUrl, token_endpoint: tokenUrl },
      oauth.clientId, undefined, auth);
    config[client.customFetch] = (url, options) => this.fetch(url, options);
    return { preset, config };
  }
}
