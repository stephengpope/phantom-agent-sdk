-- The agent's SQL runs in THIS database, fenced by the same row-level
-- policies that fence a user (057, 059) — no longer in a database of its
-- own (AgentDatabases). The agent connects as its project's login role,
-- `project_<id>`, a member of the group `agent` (Database.ensureRoles).
--
-- Who is asking, for a project login, is the LOGIN — `session_user`, which
-- nothing in a query can change: `set role` is refused outside one's own
-- memberships, and a security-definer function changes `current_user`, not
-- `session_user`. A user's identity is still the transaction settings
-- queryAs/actAs write; a project login's query may write those settings
-- too, so they are consulted only when the login is not a project's.
--
-- The policies are organization-wide, as they are for a user: the agent
-- sees what a member of its project's organization sees, in the tables
-- granted here and nothing else. Read only on ours: a card's number, a
-- revision, a media row's bytes in the bucket are invariants our code
-- keeps, not the agent's to write around. The agent's own tables live in
-- its own schema (AgentDatabases.ensure), read-write.

-- A project login's organization is its project's; a lookup in projects
-- as the function's owner (migrator, the table's owner — unfenced), so the
-- projects policy itself does not recurse.
create or replace function phantom_agent_sdk.caller_project() returns text
language sql stable as $$ select substring(session_user::text from '^project_(.+)$') $$;

create or replace function phantom_agent_sdk.caller_organization() returns text
language sql stable security definer set search_path = phantom_agent_sdk as $$
  select case
    when session_user::text like 'project\_%' then (select organization_id from projects where id = caller_project())
    else nullif(current_setting('phantom.organization_id', true), '')
  end
$$;

-- What the agent may read: the project-scoped tables, and only those.
-- settings (credentials), identity, telegram, logs, runners stay unreachable.
grant usage on schema phantom_agent_sdk to agent;
do $$
declare t text;
begin
  foreach t in array array['projects', 'workspaces', 'sessions', 'cards', 'card_revisions', 'crons', 'media', 'token_usage'] loop
    execute format('grant select on phantom_agent_sdk.%I to agent', t);
    execute format('alter policy tenant on phantom_agent_sdk.%I to authenticated, agent', t);
  end loop;
end $$;
