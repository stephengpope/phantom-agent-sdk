// One-shot model calls — an app's own (a commit message, a session title,
// a digest) and a project's code asking a question (the /projects/:id/llm
// route, `agent_llm_shared`) — on the client SDK's billed model: the type's
// resolved config, every call logged to token_usage under the work's type.
// No agent, no session turn: one prompt in, text out — optionally with an
// image beside the prompt, optionally forced to answer in JSON.
import { generateText, Output, type LanguageModel } from 'ai';
import { billedModel, BackendClient, type ModelSpec } from '@phantom-agent-sdk/client';
import type { AgentConfig } from './AgentConfig.js';
import type { ModelPin } from './AgentConfig.js';
import type { SettingScope } from '../storage/Settings.js';
import { logger } from '../lib/log.js';

const log = logger('one-shot');

export interface OneShotDeps { agentConfig: AgentConfig; client: BackendClient }

export interface OneShotRequest {
  system?: string;
  prompt: string;
  maxOutputTokens?: number | null;
  /** An image the model sees beside the prompt — a URL the provider (or the
   *  SDK, for a provider that takes only bytes) fetches. */
  image?: { url: URL; mediaType: string } | null;
  /** Force a JSON answer: the provider's JSON mode, and `json` parsed from
   *  the text. The call throws when the text is not valid JSON. */
  json?: boolean;
}

export interface OneShotAnswer { text: string; json?: unknown }

/** One call on `type`'s model (the assistant's for every helper today).
 *  Throws when the type cannot build (no provider / a half-set pair) — the
 *  caller decides what a missing answer means. `report` hears each retry. */
export async function oneShot(
  deps: OneShotDeps, type: string, work: { type: string; sessionId: string | null },
  request: OneShotRequest,
  options: { scope?: SettingScope; pin?: ModelPin | null; report?: (note: string) => void } = {},
): Promise<OneShotAnswer> {
  const config = await deps.agentConfig.resolve(type, options.scope ?? {}, options.pin ?? null);
  if (!config.model.provider || !config.model.model) throw new Error(`no model set for ${type} — pick one on /settings`);
  const spec: ModelSpec = { provider: config.model.provider as ModelSpec['provider'], model: config.model.model,
    baseUrl: config.model.baseUrl, reasoning: (config.model.reasoning ?? null) as ModelSpec['reasoning'], apiKey: config.model.apiKey ?? null };
  const model = billedModel(deps.client, spec, work, {
    notice: (text) => { log.warn({ work: work.type }, text); options.report?.(text); },
    onBillingError: (error) => log.warn({ work: work.type, err: error.message }, 'billing failed'),
  });
  return ask(model, request);
}

/** The call itself, on a built model: the prompt (with the image beside it
 *  when given) as one user message; JSON mode when asked. */
export async function ask(model: LanguageModel, request: OneShotRequest): Promise<OneShotAnswer> {
  const content = request.image
    ? [{ type: 'text' as const, text: request.prompt }, { type: 'file' as const, data: request.image.url, mediaType: request.image.mediaType }]
    : request.prompt;
  const result = await generateText({
    model, maxRetries: 0,
    ...(request.system ? { system: request.system } : {}),
    messages: [{ role: 'user', content }],
    ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
    ...(request.json ? { output: Output.json() } : {}),
  });
  return request.json ? { text: result.text, json: result.output } : { text: result.text };
}
