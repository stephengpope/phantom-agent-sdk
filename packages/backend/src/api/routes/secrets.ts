// Secrets — user-named tokens the coding agent reads (the cli adds and
// deletes). The settings table's `secret` namespace: free names, one row per
// secret, token encrypted, description plain. Two layers — global and
// project — project winning a name collision, the same chain the GitHub
// token walks. Writes and deletes address ONE explicit layer; only the value
// GET cascades.
//
//   GET    /secrets            names + descriptions (+?project= merges that layer)
//   PUT    /secrets/:name      create or overwrite {description?, value?} at one layer
//                             (no value = keep the stored one, description only);
//                             or {description?, oauth: {provider, clientId, scopes, …}, clientSecret?}
//                             for an OAuth secret (no clientSecret = keep the stored one)
//   GET    /secrets/:name      the usable value, project → global: the token, or
//                             for an OAuth secret a live access token
//   DELETE /secrets/:name      remove at one layer
//
// An OAuth secret is connected by the cli's browser round-trip (oauth/OAuthSecrets.ts):
//   GET    /secrets/oauth/presets           the providers the form offers + the redirect to register
//   POST   /secrets/:name/oauth/start       → {url} to open in the browser
//   POST   /secrets/:name/oauth/callback    {url: the redirect the cli caught} → the connection's state
//   POST   /secrets/:name/oauth/disconnect  forget the tokens, keep the client config
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GLOBAL, type Layer, type SettingScope, layerOf, scopeNames, scopeOf } from '../../lib/scopes.js';
import { ok, err } from '../HttpApi.js';
import { ownLayers } from '../ownLayers.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { secretName, SECRET_NAME_RULE } from '@phantom-agent-sdk/client';
import { OAuthSecrets, OAuthSecretError, OAUTH_REDIRECT_URI, type OAuthConfig } from '../../oauth/OAuthSecrets.js';

const TAG = { tags: ['secrets'] };
const scopeQuery = { type: 'object', properties: {
  organization: { type: 'string', description: 'The organization\'s layer (list merges it; write/delete target the deepest named; the value GET walks the chain).' },
  user: { type: 'string', description: 'The user\'s layer.' },
  project: { type: 'string', description: 'The project\'s layer (its organization\'s rides along).' },
} };
type ScopeQuery = { organization?: string; user?: string; project?: string };
const nameParam = { type: 'object', required: ['name'],
  properties: { name: { type: 'string' } } };

export function secretsRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  /** The scopes a request reads, in chain order (most specific LAST) — and
   *  the one it writes: the deepest named. Each id is verified to exist, or
   *  a typo becomes a row nothing will ever read. */
  async function scopesOf(req: FastifyRequest<{ Querystring: ScopeQuery }>):
  Promise<{ error: string } | { chain: string[]; write: string; label: Layer }> {
    const query = req.query;
    const own = ownLayers(req.caller, query);
    if (own === 'denied') return { error: 'access denied' };
    let scope: SettingScope = { ...own };
    if (query.organization) {
      if (!await ctx.identity.organization(query.organization)) return { error: `no organization ${query.organization}` };
      scope.organizationId = query.organization;
    }
    if (query.user) {
      if (!await ctx.identity.user(query.user)) return { error: `no user ${query.user}` };
      scope.userId = query.user;
    }
    if (query.project) {
      const project = await ctx.projects.get(query.project);
      if (!project) return { error: `no project ${query.project}` };
      scope = { ...scope, ...scopeOf(project) };
    }
    const label: Layer = query.project ? 'project' : query.user ? 'user' : query.organization ? 'organization' : 'global';
    const names = scopeNames(scope);
    return { chain: Object.values(names), write: names[label] ?? GLOBAL, label };
  }

  app.get<{ Querystring: ScopeQuery }>(
    '/secrets', { schema: { ...TAG,
      summary: 'List secrets',
      description: 'The names and descriptions of stored secrets, never their values. Add `project`, `organization` or `user` to see the secrets that apply there.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      // Bare, the service role lists every layer on the server; a user, their own chain.
      const raw = scopes.label !== 'global' || req.caller?.type === 'user'
        ? await ctx.settings.listSecrets(scopes.chain)
        : await ctx.settings.listAllSecrets();
      const secrets = raw.map((secret) => {
        const layer = layerOf(secret.scope);
        return { name: secret.name, description: secret.description, scope: layer,
          ...(layer === 'global' ? {} : { [layer]: secret.scope.slice(layer.length + 1) }),
          ...(secret.oauth ? { oauth: secret.oauth } : {}) };
      });
      return ok({ secrets });
    });

  app.get('/secrets/oauth/presets', { schema: { ...TAG,
    summary: 'OAuth providers',
    description: 'The providers an OAuth secret can connect to (endpoints, default scopes, a hint on where to create the client), and the redirect URI to register with the provider.' } },
    async () => ok({ presets: ctx.settings.oauth.presets, redirectUri: OAUTH_REDIRECT_URI }));

  app.put<{ Params: { name: string }; Querystring: ScopeQuery;
    Body: { description?: string; value?: string; oauth?: Partial<OAuthConfig>; clientSecret?: string } }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Save a secret',
      description: 'Creates or replaces one secret at one scope. The body holds the secret\'s `value` and an optional `description`; leave out `value` to change only the description. For an OAuth secret send `oauth` ({provider, clientId, scopes, authUrl?, tokenUrl?}) and `clientSecret` instead of `value`; leave out `clientSecret` to keep the stored one. Names are stored in capitals.',
      params: nameParam, querystring: scopeQuery,
      body: { type: 'object', properties: {
        description: { type: 'string' }, value: { type: 'string' },
        oauth: { type: 'object', properties: {
          provider: { type: 'string' }, clientId: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } },
          authUrl: { type: 'string' }, tokenUrl: { type: 'string' } } },
        clientSecret: { type: 'string' } } } } },
    async (req, reply) => {
      const name = secretName(req.params.name);
      if (!name) {
        return reply.code(400).send(err('invalid_args',
          `secret names are ${SECRET_NAME_RULE} (got "${req.params.name}")`));
      }
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      if (req.body?.oauth) {
        let config: OAuthConfig;
        try { config = OAuthSecrets.config(req.body.oauth); }
        catch (error) { return reply.code(400).send(err('invalid_args', (error as Error).message)); }
        await ctx.settings.writeOAuthSecret(scopes.write, name, String(req.body.description ?? ''), config, req.body.clientSecret || undefined);
        return ok({ name, scope: scopes.label });
      }
      // An empty string is a mistake ("" is not a token); an ABSENT value is
      // a description-only edit of a secret already there.
      const value = req.body?.value;
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
        return reply.code(400).send(err('invalid_args', 'body.value (the secret itself) must not be empty'));
      }
      const stored = await ctx.settings.writeSecret(scopes.write, name,
        String(req.body?.description ?? ''), value);
      if (!stored) {
        return reply.code(400).send(err('invalid_args',
          `body.value (the secret itself) is required — nothing named "${name}" is stored at the ${scopes.label} layer to keep`));
      }
      return ok({ name, scope: scopes.label });
    });

  app.get<{ Params: { name: string }; Querystring: ScopeQuery }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Read a secret',
      description: 'Returns one secret\'s value. When the same name is stored at several scopes, the most specific one wins: the project\'s, then the user\'s, then the organization\'s, then the server\'s.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const name = secretName(req.params.name);
      let value: string | undefined;
      try { value = name ? await ctx.settings.readSecret(name, scopes.chain) : undefined; }
      catch (error) {
        if (error instanceof OAuthSecretError) return reply.code(error.code === 'provider' ? 502 : 409).send(err(error.code, error.message));
        throw error;
      }
      if (value === undefined) {
        const names = (await ctx.settings.listSecrets(scopes.chain)).map((secret) => secret.name);
        return reply.code(404).send(err('not_found',
          `no secret named "${req.params.name}" — stored: ${names.length ? names.join(', ') : '(none)'}`));
      }
      return ok({ name, value });
    });

  app.delete<{ Params: { name: string }; Querystring: ScopeQuery }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Delete a secret',
      description: 'Removes one secret from one scope. The same name at other scopes is untouched.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const name = secretName(req.params.name);
      const gone = name ? await ctx.settings.deleteSecret(scopes.write, name) : false;
      if (!gone) {
        return reply.code(404).send(err('not_found',
          `no secret named "${req.params.name}" at the ${scopes.label} layer`));
      }
      return ok({ deleted: req.params.name, scope: scopes.label });
    });

  // ── the OAuth round-trip ─────────────────────────────────────────────────────

  /** Run one OAuth step; its refusals become the API's. */
  const oauthStep = async (reply: FastifyReply, step: () => Promise<unknown>) => {
    try { return ok(await step()); }
    catch (error) {
      if (!(error instanceof OAuthSecretError)) throw error;
      const status = error.code === 'not_found' ? 404 : error.code === 'invalid_args' ? 400 : error.code === 'provider' ? 502 : 409;
      return reply.code(status).send(err(error.code, error.message));
    }
  };

  app.post<{ Params: { name: string }; Querystring: ScopeQuery }>(
    '/secrets/:name/oauth/start', { schema: { ...TAG,
      summary: 'Start connecting an OAuth secret',
      description: `The provider's authorization URL to open in a browser. The provider sends the browser back to ${OAUTH_REDIRECT_URI}; hand that full URL to the callback route.`,
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const name = secretName(req.params.name) ?? req.params.name;
      return oauthStep(reply, async () => ({ url: await ctx.settings.oauth.start(name, scopes.chain) }));
    });

  app.post<{ Params: { name: string }; Body: { url?: string } }>(
    '/secrets/:name/oauth/callback', { schema: { ...TAG,
      summary: 'Finish connecting an OAuth secret',
      description: 'The full redirect URL the browser was sent back to (code and state in its query). Exchanges the code and stores the tokens.',
      params: nameParam, body: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } } },
    async (req, reply) => {
      const name = secretName(req.params.name) ?? req.params.name;
      return oauthStep(reply, async () => ({ oauth: await ctx.settings.oauth.callback(name, String(req.body.url)) }));
    });

  app.post<{ Params: { name: string }; Querystring: ScopeQuery }>(
    '/secrets/:name/oauth/disconnect', { schema: { ...TAG,
      summary: 'Disconnect an OAuth secret',
      description: 'Forgets the tokens; the client id and secret stay so it can be reconnected.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const name = secretName(req.params.name) ?? req.params.name;
      return oauthStep(reply, async () => { await ctx.settings.oauth.disconnect(name, scopes.chain); return { name }; });
    });
}
