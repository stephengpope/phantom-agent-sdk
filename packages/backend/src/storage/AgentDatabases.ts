// The agent's database access, one login per project: `project_<id>` on
// THIS database, reached through the coding agent's database_query tool
// (the /projects/:id/database routes). The agent gets two things:
//
//   - its own schema, `project_<id>`: its private, permanent store — the
//     tables it makes, read-write, outliving containers and sessions. The
//     schema is ours (the agent cannot drop it); what is inside is the
//     agent's.
//   - a read of the project-scoped SDK tables (cards, sessions, media, …),
//     fenced by the row-level policies exactly as a user is (migration
//     067): its organization's rows, nothing else, and a join between its
//     own tables and ours is one query.
//
// The fence is the LOGIN. Every query CONNECTS as `project_<id>` — never
// `set role` inside a privileged connection, which the agent's own
// statements could undo. The policies read `session_user`, which no
// statement can change; the role owns nothing above its schema (no
// createdb, no createrole, no bypassrls) and is a member of the `agent`
// group (Database.ensureRoles), which holds every grant migration 067
// makes. Its password is derived from ENCRYPTION_KEY and the project id:
// stored nowhere, re-set on every ensure (so a rotated key heals itself),
// and it never leaves this process except as AGENT_DATABASE_URL when
// `agent_database_shared` is on.
//
// The setting `agent_database` says whether a project HAS this; the route
// reads it. Off keeps the data; only the project going drops it.
import pg from 'pg';
import { logger } from '../lib/log.js';
import { AGENT_TYPES, runStatements, type QueryOptions, type StatementResult } from './sqlRunner.js';
export { SqlError, locate, type QueryOptions, type StatementResult, type SqlErrorLocation } from './sqlRunner.js';
import { derivedPassword } from '../lib/crypto.js';
import { AGENT_ROLE, AGENT_SCHEMA_PREFIX } from './Database.js';

const log = logger('database');

const STATEMENT_TIMEOUT = '30s';
/** Where the SDK's tables are: on the agent's search path after its own
 *  schema, so `cards` is ours and `create table cards` is the agent's. */
const SDK_SCHEMA = 'phantom_agent_sdk';

const quoteIdent = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const quoteLiteral = (literal: string) => `'${literal.replaceAll("'", "''")}'`;

export class AgentDatabases {
  /** Projects whose schema and role this process has already ensured. */
  private ready = new Set<string>();
  private ensuring = new Map<string, Promise<void>>();
  private readonly server: URL;

  /** `pool` is the backend's own connection (`service_role`: createrole,
   *  create on the database, admin on `agent` — Database.ensureRoles) —
   *  the one that makes schemas and roles. `databaseUrl` is that role's; a
   *  project's connection is the same server and database with its own
   *  login. */
  constructor(private readonly pool: pg.Pool, databaseUrl: string, private readonly encryptionKey: Buffer) {
    this.server = new URL(databaseUrl);
  }

  /** Schema name and role name are the same word: `project_<id>`. A
   *  project id is a lowercase ULID, so the name is a plain identifier. */
  nameOf(projectId: string): string { return `${AGENT_SCHEMA_PREFIX}${projectId}`; }

  private passwordOf(projectId: string): string { return derivedPassword(this.encryptionKey, `database:${projectId}`); }

  /** The connection string the project's code gets as AGENT_DATABASE_URL
   *  when `agent_database_shared` is on — the same login the tool uses.
   *  Ensures first, so the URL works the moment it is handed out. The host
   *  is the server's own (`postgres` on the stack network); the container
   *  must be on that network to resolve it. */
  async urlFor(projectId: string): Promise<string> {
    await this.ensure(projectId);
    return this.connectionString(projectId);
  }

  private connectionString(projectId: string): string {
    const url = new URL(this.server.toString());
    url.username = this.nameOf(projectId);
    url.password = this.passwordOf(projectId);
    return url.toString();
  }

  /** The role and schema exist and the role's password is current. Once
   *  per project per process; serialized so two first queries cannot race
   *  each other into `create role` twice. */
  async ensure(projectId: string): Promise<void> {
    if (this.ready.has(projectId)) return;
    const inflight = this.ensuring.get(projectId);
    if (inflight) return inflight;
    const ensuring = this.ensureInner(projectId)
      .then(() => { this.ready.add(projectId); })
      .finally(() => this.ensuring.delete(projectId));
    this.ensuring.set(projectId, ensuring);
    return ensuring;
  }

  private async ensureInner(projectId: string): Promise<void> {
    const name = this.nameOf(projectId);
    const role = quoteIdent(name);
    const password = quoteLiteral(this.passwordOf(projectId));

    const { rows: roles } = await this.pool.query('select from pg_roles where rolname = $1', [name]);
    if (!roles.length) {
      await this.pool.query(`create role ${role} login nosuperuser nocreatedb nocreaterole nobypassrls inherit password ${password}`);
    } else {
      // A role from before 067 was noinherit: healed here.
      await this.pool.query(`alter role ${role} with inherit password ${password}`);
    }
    // In the group: its grants (067) are the login's own (inherit), but the
    // login may not `set role agent` (set false) — one identity, no other.
    await this.pool.query(`grant ${quoteIdent(AGENT_ROLE)} to ${role} with inherit true, set false`);
    await this.pool.query(`alter role ${role} set statement_timeout = ${quoteLiteral(STATEMENT_TIMEOUT)}`);
    await this.pool.query(`alter role ${role} set search_path = ${role}, ${quoteIdent(SDK_SCHEMA)}`);

    const { rows: schemas } = await this.pool.query('select from pg_namespace where nspname = $1', [name]);
    if (!schemas.length) {
      // Ours (the agent cannot drop it); the agent may build anything inside.
      await this.pool.query(`create schema ${role}`);
      await this.pool.query(`grant all on schema ${role} to ${role}`);
      log.info({ project: projectId, schema: name }, 'agent schema created');
    }
  }

  /** Run the agent's SQL connected AS the project role. One result per
   *  statement, carrying the first `limit` rows and the true row count.
   *  Rows are read as they stream and dropped past `limit`, so the server
   *  never holds a result bigger than what was asked for. Rows come back
   *  as arrays with the field list, so a duplicate column name is refused
   *  instead of silently overwriting. */
  async query(projectId: string, sql: string, options: QueryOptions): Promise<StatementResult[]> {
    await this.ensure(projectId);
    const client = new pg.Client({
      connectionString: this.connectionString(projectId), connectionTimeoutMillis: 5000, types: AGENT_TYPES,
    });
    await client.connect();
    try {
      return await runStatements(client, sql, options);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** The project is gone: its schema, everything in it, and its role go
   *  with it. An install from before 067 gave the agent a database of its
   *  own under the same name; it goes too. */
  async drop(projectId: string): Promise<void> {
    const name = quoteIdent(this.nameOf(projectId));
    this.ready.delete(projectId);
    await this.pool.query(`drop schema if exists ${name} cascade`);
    await this.pool.query(`drop database if exists ${name} with (force)`);
    await this.pool.query(`drop role if exists ${name}`);
    log.info({ project: projectId, schema: this.nameOf(projectId) }, 'agent schema dropped');
  }
}
