// The agent's fence, against a real Postgres: the backend's own boot
// (Database.open → ensureRoles, every SDK migration), a project login made
// by AgentDatabases.ensure, and the agent's SQL through AgentDatabases.query
// — the exact path database_query takes. The agent is assumed hostile:
// every statement here is one it might write to reach past its
// organization. Needs a superuser connection string in TEST_DATABASE_URL to
// an EMPTY database it may fill; skipped without one.
// Run: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5499/sdk npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Database, SDK_MIGRATIONS } from './Database.js';
import { AgentDatabases, SqlError } from './AgentDatabases.js';

const url = process.env.TEST_DATABASE_URL;
const key = Buffer.alloc(32, 7);

let database: Database;
let agents: AgentDatabases;
let superuser: pg.Client;

/** Two organizations, three projects: a1 and a2 in A, b1 in B; a card and a media row each. */
const seed = `
  insert into identity."user"(id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x', true, now(), now());
  insert into identity.organization(id, name, slug, created_at) values ('orga', 'A', 'a', now()), ('orgb', 'B', 'b', now());
  insert into phantom_agent_sdk.projects(id, organization_id, owner, name, base_branch) values
    ('a1', 'orga', 'u1', 'a1', 'main'), ('a2', 'orga', 'u1', 'a2', 'main'), ('b1', 'orgb', 'u1', 'b1', 'main');
  insert into phantom_agent_sdk.media(id, organization_id, project_id, name, mime_type, size, endpoint, bucket, key) values
    ('m-a1', 'orga', 'a1', 'a1.png', 'image/png', 1, 'e', 'b', 'k1'), ('m-a2', 'orga', 'a2', 'a2.png', 'image/png', 1, 'e', 'b', 'k2'),
    ('m-b1', 'orgb', 'b1', 'b1.png', 'image/png', 1, 'e', 'b', 'k3');
  insert into phantom_agent_sdk.cards(organization_id, project_id, number, pos, title) values
    ('orga', 'a1', 1, 1, 'A1 card'), ('orgb', 'b1', 1, 1, 'B1 secret card');
`;

before(async () => {
  if (!url) return;
  database = await Database.open(url, key);
  await database.migrate(SDK_MIGRATIONS);
  superuser = new pg.Client({ connectionString: url });
  await superuser.connect();
  await superuser.query(seed);
  agents = new AgentDatabases(database.pool, database.url, key);
  await agents.ensure('a1');
  await agents.ensure('b1');
});

after(async () => {
  await superuser?.end();
  await database?.close();
});

const asA1 = (sql: string) => agents.query('a1', sql, { limit: 100, maxCellChars: 1000 });
const rows = async (sql: string) => (await asA1(sql))[0].rows;
const refused = async (sql: string, code: string) => {
  await assert.rejects(asA1(sql), (error: unknown) => error instanceof SqlError && error.info.code === code,
    `${sql} should fail with ${code}`);
};

test('sees its organization: media and cards of both A projects, joinable with its own tables', { skip: !url }, async () => {
  assert.deepEqual((await rows('select id from media order by id')).map((r) => r.id), ['m-a1', 'm-a2']);
  assert.deepEqual((await rows('select title from cards')).map((r) => r.title), ['A1 card']);
  await asA1(`create table notes(media_id text, note text); insert into notes values ('m-a1', 'hello')`);
  assert.deepEqual(await rows('select m.name, n.note from media m join notes n on n.media_id = m.id'), [{ name: 'a1.png', note: 'hello' }]);
  // Its table landed in its own schema, not ours.
  assert.deepEqual(await rows(`select table_schema from information_schema.tables where table_name = 'notes'`), [{ table_schema: 'project_a1' }]);
});

test('project b1 sees only B', { skip: !url }, async () => {
  const [result] = await agents.query('b1', 'select id from media', { limit: 100, maxCellChars: 1000 });
  assert.deepEqual(result.rows.map((r) => r.id), ['m-b1']);
});

test('cannot reach organization B by rewriting the identity note', { skip: !url }, async () => {
  const [, all, b] = await asA1(`select set_config('phantom.organization_id', 'orgb', true);
    select id from media order by id; select id from media where organization_id = 'orgb'`);
  assert.deepEqual(all.rows.map((r) => r.id), ['m-a1', 'm-a2']);
  assert.deepEqual(b.rows, []);
});

test('cannot become another role', { skip: !url }, async () => {
  await refused('set role project_b1', '42501');
  await refused('set role service_role', '42501');
  await refused('set role migrator', '42501');
  await refused('set role agent; select 1', '42501');
});

test('cannot write our tables, disable the fence, or alter them', { skip: !url }, async () => {
  await refused(`insert into media(id, organization_id, project_id, name, mime_type, size, endpoint, bucket, key) values ('x', 'orga', 'a1', 'x', 't', 1, 'e', 'b', 'k')`, '42501');
  await refused(`update media set organization_id = 'orgb' where id = 'm-a1'`, '42501');
  await refused(`delete from cards`, '42501');
  await refused('alter table media disable row level security', '42501');
  await refused('create table phantom_agent_sdk.mine(id int)', '42501');
  await refused('drop schema project_a1', '42501');
});

test('cannot see settings, identity, or another project\'s schema', { skip: !url }, async () => {
  await refused('select * from settings', '42501');
  await refused('select * from identity."user"', '42501');
  await refused('select * from identity.account', '42501');
  await refused('select * from telegram_chats', '42501');
  await refused('select * from project_b1.anything', '42501');
  await refused('create table project_b1.mine(id int)', '42501');
});

test('nothing moved', { skip: !url }, async () => {
  const { rows } = await superuser.query('select id, organization_id from phantom_agent_sdk.media order by id');
  assert.deepEqual(rows, [{ id: 'm-a1', organization_id: 'orga' }, { id: 'm-a2', organization_id: 'orga' }, { id: 'm-b1', organization_id: 'orgb' }]);
});

test('the project key names its project and nothing else does', { skip: !url }, async () => {
  const a1 = await agents.keyFor('a1');
  assert.match(a1, /^ph_project_a1_[A-Za-z0-9_-]{43}$/);
  assert.equal(agents.projectOfKey(a1), 'a1');
  assert.equal(agents.projectOfKey(await agents.keyFor('b1')), 'b1');
  // Another project's secret under a1's id, a byte off, a wrong prefix, an empty id: nobody.
  const b1Secret = (await agents.keyFor('b1')).split('_').at(-1);
  assert.equal(agents.projectOfKey(`ph_project_a1_${b1Secret}`), null);
  assert.equal(agents.projectOfKey(a1.slice(0, -1) + (a1.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(agents.projectOfKey(a1.replace('ph_project_', 'ph_user_role_')), null);
  assert.equal(agents.projectOfKey('ph_project_'), null);
  assert.equal(agents.projectOfKey('ph_project__x'), null);
  // A guessed id creates nothing.
  assert.equal(agents.projectOfKey('ph_project_zz_nope'), null);
  assert.equal((await superuser.query(`select from pg_roles where rolname = 'project_zz'`)).rowCount, 0);
});

test('drop takes the schema and role', { skip: !url }, async () => {
  await agents.drop('a1');
  assert.equal((await superuser.query(`select from pg_namespace where nspname = 'project_a1'`)).rowCount, 0);
  assert.equal((await superuser.query(`select from pg_roles where rolname = 'project_a1'`)).rowCount, 0);
});
