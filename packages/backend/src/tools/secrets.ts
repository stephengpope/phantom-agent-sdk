// The SECRET tools — secret_list, secret_get: the stored secrets, over
// Settings' secret layer. Read-only by design. Bound to the session's
// project: its secrets shadow global ones by name.
import { layerOf, scopeNames, scopeOf } from '../lib/scopes.js';
import { secretName } from '@phantom-agent-sdk/client';
import { obj, refusal, str, type ToolCtx, type ToolDef } from './def.js';
import { OAuthSecretError } from '../oauth/OAuthSecrets.js';
import type { SecretMeta } from '../storage/Settings.js';

const chain = (ctx: ToolCtx) => Object.values(scopeNames(scopeOf(ctx.project)));

/** A secret as the agent sees it: an OAuth one says so, and how it stands. */
export const secretListing = (secret: SecretMeta) => ({
  name: secret.name, description: secret.description, scope: layerOf(secret.scope),
  ...(secret.oauth ? { type: 'oauth', provider: secret.oauth.provider, status: secret.oauth.status, scopes: secret.oauth.scopes } : {}),
});

export const SECRET_TOOLS: ToolDef[] = [
  {
    name: 'secret_list',
    summary: 'The stored secrets — names and descriptions, never values.',
    description: 'The stored secrets — names and descriptions, never values. An OAuth secret ' +
      '(type "oauth") lists its provider, granted scopes and connection status; secret_get turns a ' +
      'connected one into a live access token. The index in your instructions was written when ' +
      'this session started; use this when a secret might have been added since, or the one you ' +
      'expected is missing.',
    input: obj({}),
    mutates: false, group: 'secrets',
    async execute(ctx) {
      const raw = await ctx.app.settings.listSecrets(chain(ctx));
      return { secrets: raw.map(secretListing) };
    },
  },
  {
    name: 'secret_get',
    summary: "One stored secret's value, by name.",
    description: 'One stored secret\'s value, by name — tokens and credentials the user saved ' +
      'for your use in this project (API keys, service tokens). For an OAuth secret this is a ' +
      'live access token, refreshed for you when it is about to expire. Use the real value it ' +
      'returns in commands, config and .env files; never invent a placeholder when a stored ' +
      'secret covers the need. If it says a connection must be reconnected, tell the user to do ' +
      'that in /secrets — you cannot authorize it yourself. The names are in your instructions\' ' +
      'secrets index, or secret_list.',
    input: obj({ name: str('the secret\'s name, from the index in your instructions or secret_list') }, ['name']),
    mutates: false, group: 'secrets',
    async execute(ctx, a) {
      const name = secretName(String(a.name));
      let value: string | undefined;
      try { value = name ? await ctx.app.settings.readSecret(name, chain(ctx)) : undefined; }
      catch (error) {
        if (error instanceof OAuthSecretError) throw refusal(error.code === 'provider' ? 'oauth_unavailable' : 'oauth_reconnect', error.message);
        throw error;
      }
      if (value === undefined) {
        const names = (await ctx.app.settings.listSecrets(chain(ctx))).map((secret) => secret.name);
        throw refusal('not_found', `no secret named "${String(a.name)}" — stored: ${names.length ? names.join(', ') : '(none)'}`);
      }
      return { name, value };
    },
  },
];
