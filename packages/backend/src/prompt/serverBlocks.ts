// The texts of the blocks only the server can fill — named in an agent's
// system prompt layout, filled by phantom-backend/systemPrompt/SystemPrompt.ts
// when the session is created. Text only, zero logic; the blanks are the
// lists the server fills in.

// ═══ skills_list ═════════════════════════════════════════════════════════════
// {{skillsList}} is one line per skill: "- name: description" (clipped to 60
// chars). No skills = the block vanishes; skill_list is the live view.

export const SKILLS_LIST = `Below is a list of your skills and their descriptions:

{{skillsList}}

The skill_load tool loads a skill by name. The skill_list tool returns the skill list if for some reason you need an updated list.`;

// ═══ secrets_list ════════════════════════════════════════════════════════════
// {{secretsList}} is one line per secret: "- name: description" (clipped to
// 60 chars). No secrets = the block vanishes; secret_list is the live view.

export const SECRETS_LIST = `The user has stored secrets for your use — tokens and credentials, kept encrypted on the server:

{{secretsList}}

The secret_get tool returns a value by name. This list was written when the session started; the secret_list tool returns the most current list should you need to find a newly added secret.`;

// ═══ github_token ════════════════════════════════════════════════════════════
// Present only when agent_git_credentials is on for the project.

export const GITHUB_TOKEN = `A GitHub token is in your environment (GITHUB_TOKEN); git and gh are authenticated with it.`;

// ═══ agent_database ══════════════════════════════════════════════════════════
// Present only when agent_database is on for the project. Facts only —
// what it is, not what to do with it. Two wordings: private (the default),
// and shared with the project's code (agent_database_shared on): the api
// route, the env that reaches it, the shape of the answer.

const AGENT_DATABASE_WHAT = `You have your own PostgreSQL schema for this project, \`project_<id>\`, first on your search path: the tables you create land there, and it persists across sessions and container restarts. Next on the path is \`phantom_agent_sdk\`, where this project's own records are readable — projects, workspaces, sessions, cards, card_revisions, crons, media (the tracked files; a row per file, the bytes are in storage), token_usage — read-only, your organization's rows only, joinable with your tables.`;

export const AGENT_DATABASE = `${AGENT_DATABASE_WHAT} No code in the project can reach any of it. The database_query tool runs SQL in it.`;

export const AGENT_DATABASE_SHARED = `${AGENT_DATABASE_WHAT} The database_query tool runs SQL in it and should be your primary way of accessing it. The project's code can reach the same database over the api, as you: \`PHANTOM_API_URL\`, \`PHANTOM_PROJECT_ID\` and \`PHANTOM_PROJECT_KEY\` are in your environment. \`POST $PHANTOM_API_URL/api/projects/$PHANTOM_PROJECT_ID/database/query\` with \`Authorization: Bearer $PHANTOM_PROJECT_KEY\` and a JSON body \`{"sql", "params", "limit"}\` runs SQL exactly as database_query does (several statements = one transaction; $1…$n params need a single statement) and answers \`{ok, data: {results: [{command, rowCount, rows}]}}\`; an error answers \`{ok: false, error: {code, message}}\` with nothing applied. The key opens that one route and nothing else.`;

// ═══ agent_llm_shared ════════════════════════════════════════════════════════
// Present only when agent_llm_shared is on for the project. Facts only.

export const AGENT_LLM_SHARED = `The project's code can ask the model a question over the api, on the model your sessions use: \`PHANTOM_API_URL\`, \`PHANTOM_PROJECT_ID\` and \`PHANTOM_PROJECT_KEY\` are in your environment. \`POST $PHANTOM_API_URL/api/projects/$PHANTOM_PROJECT_ID/llm\` with \`Authorization: Bearer $PHANTOM_PROJECT_KEY\` and a JSON body \`{"prompt", "system"?, "maxOutputTokens"?}\` answers \`{ok, data: {text}}\`; one prompt in, text out, no memory between calls, every call billed to this project's token usage.`;

// ═══ media ═══════════════════════════════════════════════════════════════════
// Present only when agent_media is on for the project AND media storage is
// configured for its organization — the same rule that offers the media
// tools. Facts only.

export const MEDIA = `This project's organization keeps tracked media files (videos, images, audio, documents, text) in storage. The media_list tool lists them. The media_link tool gives a short-lived link to one file. The media_download tool copies one into /workspace/scratch. The media_upload tool keeps a file from /workspace as a new media file.`;

// ═══ disk_limit ════════════════════════════════════════════════════════════════
// Present only when container_disk_gb is set. {{gb}} is the limit.

export const DISK_LIMIT = `Your workspace is limited to {{gb}} GB of disk. A write past it fails with "Disk quota exceeded": free space (build output, caches, dependencies you can reinstall) and carry on.`;

// ═══ time_date ═══════════════════════════════════════════════════════════════
// {{date}} is today, in the builder's time zone (the `timezone` setting),
// written once when the session starts.

export const TIME_DATE = `Current date: {{date}}.`;

// ═══ soul_md · agents_md ═════════════════════════════════════════════════════
// The repo's root SOUL.md / AGENTS.md, verbatim — no wrapper text. Present
// only when the matching setting (agent_soul / agent_agents_md) is on for
// the project AND the checkout has the file.
