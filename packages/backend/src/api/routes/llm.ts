// The project's code asking the model a question (agents/oneShot.ts), behind
// the project's `agent_llm_shared` setting:
//
//   POST /projects/:id/llm   { prompt, system?, maxOutputTokens? } → { text }
//
// On the model of the type whose sessions own the container (the coding
// agent's), resolved in the project's scope — the same model the project's
// sessions use — and logged to token_usage as `project_llm`. One prompt in,
// text out: no agent, no session, no memory between calls. The ONE route
// beside database/query a project key (the container's PHANTOM_PROJECT_KEY)
// may call — for its own project; the front step refuses it everywhere else.
import type { FastifyInstance } from 'fastify';
import { BackendClient } from '@phantom-agent-sdk/client';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { scopeOf } from '../../lib/scopes.js';
import { oneShot } from '../../agents/oneShot.js';
import { logger, errStr } from '../../lib/log.js';

const log = logger('llm');
const TAG = { tags: ['llm'] };
const WORK_TYPE = 'project_llm';
const CLIENT_ID = 'phantom-llm';

export function llmRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  // ONE client for every question: the loopback, as the service role — the
  // billing it does is the project's (actingFor) so the usage lands on it.
  const clientFor = (organizationId: string) => new BackendClient({ url: ctx.loopback.url,
    credential: { serviceRoleKey: ctx.loopback.serviceRoleKey }, clientId: CLIENT_ID, label: 'project llm', actingFor: { organizationId } });

  app.post<{ Params: { id: string }; Body: { prompt: string; system?: string; maxOutputTokens?: number } }>(
    '/projects/:id/llm', { config: { projectKey: true }, schema: { ...TAG,
      summary: 'Ask the model a question',
      description: 'One prompt in, text out, on the model the project\'s coding sessions use; logged to token usage as project_llm. The project\'s own code may call this with its project key (PHANTOM_PROJECT_KEY, when agent_llm_shared is on).',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', required: ['prompt'], additionalProperties: false,
        properties: {
          prompt: { type: 'string', minLength: 1 },
          system: { type: 'string' },
          maxOutputTokens: { type: 'integer', minimum: 1 },
        } } } },
    async (req, reply) => {
      const project = await ctx.projects.get(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      if (!(await ctx.settings.resolve('agent_llm_shared', scopeOf(project)))) {
        return reply.code(409).send(err('llm_off', 'agent_llm_shared is off for this project'));
      }
      const type = ctx.agentTypes.ownerOfWorkspaces();
      if (!type) return reply.code(503).send(err('llm_unavailable', 'no agent type owns workspaces on this server'));
      try {
        const text = await oneShot({ agentConfig: ctx.agentConfig, client: clientFor(project.organizationId) }, type.name,
          { type: WORK_TYPE, sessionId: null }, req.body, { scope: scopeOf(project) });
        return ok({ text });
      } catch (error) {
        log.warn({ project: project.name, err: errStr(error) }, 'project llm call failed');
        return reply.code(502).send(err('llm_failed', errStr(error)));
      }
    });
}
