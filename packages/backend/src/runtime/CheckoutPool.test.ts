// The checkout pool against a real git "GitHub" on disk: a bare repository
// standing in for origin, and a fake answer to "where is main?". Every
// git operation is the real one; only the network is replaced.
// Run: npm test (tsx --test, node's runner) in this package.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CheckoutPool, type PoolProject } from './CheckoutPool.js';
import { makePaths, mirrorDir, repoDir, sessionDir, type Paths } from '../lib/paths.js';
import { headOf } from '../git/Git.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

let root: string;
let origin: string;         // the bare repo standing in for GitHub
let author: string;         // a working clone that pushes commits to origin
let paths: Paths;
let project: PoolProject;

/** A commit on origin's main; answers its id. */
async function commitOnOrigin(file: string): Promise<string> {
  await fs.writeFile(path.join(author, file), `${file}\n`);
  await git(author, 'add', '.');
  await git(author, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file);
  await git(author, 'push', '-q', 'origin', 'main');
  return git(author, 'rev-parse', 'HEAD');
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-'));
  origin = path.join(root, 'origin.git');
  author = path.join(root, 'author');
  await fs.mkdir(origin);
  await git(origin, 'init', '-q', '--bare', '-b', 'main');
  await exec('git', ['clone', '-q', origin, author]);
  await commitOnOrigin('one');
  paths = makePaths(path.join(root, 'volume'));
  project = { id: 'p1', owner: 'o', name: 'r', baseBranch: 'main', auth: { url: origin }, target: 2, submodules: false };
});
after(() => fs.rm(root, { recursive: true, force: true }));

const spares = async () => (await fs.readdir(paths.poolReady).catch(() => [] as string[])).filter((slot) => slot.startsWith('p1__main__')).sort();
const spareHeads = async () => Promise.all((await spares()).map((slot) => headOf(path.join(paths.poolReady, slot, 'repo'), 'HEAD')));
/** A background refill lands within a moment; wait for the pile to be `n`. */
async function untilSpares(n: number): Promise<void> {
  for (let i = 0; i < 100 && (await spares()).length !== n; i++) await new Promise((wake) => setTimeout(wake, 50));
  assert.equal((await spares()).length, n);
}

test('a pass makes the mirror and the spares, all at origin\'s main', async () => {
  const pool = new CheckoutPool(paths, async () => headOf(origin, 'refs/heads/main'));
  await pool.bootCleanup();
  await pool.pass([project]);
  const want = await headOf(origin, 'refs/heads/main');
  assert.equal(await headOf(mirrorDir(paths, 'p1', 'main'), 'refs/heads/main'), want);
  assert.deepEqual(await spareHeads(), [want, want]);
  // The spare's origin is the real remote, not the mirror: pushes and
  // fetches from the session go to GitHub.
  const spare = path.join(paths.poolReady, (await spares())[0], 'repo');
  assert.equal(await git(spare, 'remote', 'get-url', 'origin'), origin);
  // Objects are the spare's own (hard links), never borrowed from the
  // mirror through alternates — a mirror gc could not pull them away.
  await assert.rejects(fs.access(path.join(spare, '.git', 'objects', 'info', 'alternates')));
});

test('main moves: the next pass pulls the mirror and brings every spare to it, in place', async () => {
  const pool = new CheckoutPool(paths, async () => headOf(origin, 'refs/heads/main'));
  const before = await spares();
  const moved = await commitOnOrigin('two');
  await pool.pass([project]);
  assert.equal(await headOf(mirrorDir(paths, 'p1', 'main'), 'refs/heads/main'), moved);
  assert.deepEqual(await spares(), before);   // the same spares, not new ones
  assert.deepEqual(await spareHeads(), [moved, moved]);
});

test('main unchanged: a pass touches nothing', async () => {
  let asked = 0;
  const pool = new CheckoutPool(paths, async () => { asked++; return headOf(origin, 'refs/heads/main'); });
  const stamp = (await fs.stat(path.join(paths.poolReady, (await spares())[0]))).mtimeMs;
  await pool.pass([project]);
  assert.equal(asked, 1);
  assert.equal((await fs.stat(path.join(paths.poolReady, (await spares())[0]))).mtimeMs, stamp);
});

test('no answer from GitHub is never read as unchanged: the mirror is pulled', async () => {
  const pool = new CheckoutPool(paths, async () => null);
  const moved = await commitOnOrigin('three');
  await pool.pass([project]);
  assert.equal(await headOf(mirrorDir(paths, 'p1', 'main'), 'refs/heads/main'), moved);
  assert.deepEqual(await spareHeads(), [moved, moved]);
});

test('claim: a spare is renamed into the session and refilled at once, in the background', async () => {
  const pool = new CheckoutPool(paths, async () => headOf(origin, 'refs/heads/main'));
  const taken = await spares();
  assert.equal(await pool.claim(project, sessionDir(paths, 's1')), true);
  assert.equal(await headOf(repoDir(paths, 's1'), 'HEAD'), await headOf(origin, 'refs/heads/main'));
  assert.equal(await pool.claim(project, sessionDir(paths, 's2')), true);   // the second of two, before any refill
  await untilSpares(2);
  assert.equal((await spares()).filter((slot) => taken.includes(slot)).length, 0);   // both are new
});

test('claim with nothing to claim answers false', async () => {
  const pool = new CheckoutPool(paths, async () => null);
  assert.equal(await pool.claim({ ...project, id: 'nothing-here' }, sessionDir(paths, 's0')), false);
});

test('a pass trims spares beyond the target', async () => {
  const pool = new CheckoutPool(paths, async () => headOf(origin, 'refs/heads/main'));
  await pool.pass([{ ...project, target: 1 }]);
  assert.equal((await spares()).length, 1);
  await pool.pass([project]);
  assert.equal((await spares()).length, 2);
});

test('copy: a session copy straight from the mirror, no spare needed', async () => {
  const pool = new CheckoutPool(paths, async () => headOf(origin, 'refs/heads/main'));
  const dest = sessionDir(paths, 's3');
  await pool.copy(project, dest);
  assert.equal(await headOf(repoDir(paths, 's3'), 'HEAD'), await headOf(origin, 'refs/heads/main'));
  assert.equal(await git(repoDir(paths, 's3'), 'remote', 'get-url', 'origin'), origin);
  await fs.access(path.join(dest, 'scratch'));
});

test('copy with no mirror yet clones it first — a project\'s first checkout on a host', async () => {
  const other = { ...project, id: 'p2' };
  const pool = new CheckoutPool(paths, async () => null);
  await pool.copy(other, sessionDir(paths, 's4'));
  assert.equal(await headOf(mirrorDir(paths, 'p2', 'main'), 'refs/heads/main'), await headOf(origin, 'refs/heads/main'));
  assert.equal(await headOf(repoDir(paths, 's4'), 'HEAD'), await headOf(origin, 'refs/heads/main'));
});

test('a project no longer served loses its mirror and spare', async () => {
  const pool = new CheckoutPool(paths, async () => headOf(origin, 'refs/heads/main'));
  await pool.pass([project]);   // p2's mirror from the test above is now unserved
  await assert.rejects(fs.access(mirrorDir(paths, 'p2', 'main')));
  await pool.pass([]);
  assert.equal((await spares()).length, 0);
  await assert.rejects(fs.access(mirrorDir(paths, 'p1', 'main')));
});

test('a pass under a running pass is dropped', async () => {
  let answers = 0;
  const pool = new CheckoutPool(paths, async () => { answers++; await new Promise((wake) => setTimeout(wake, 50)); return null; });
  await Promise.all([pool.pass([project]), pool.pass([project])]);
  assert.equal(answers, 1);
});

test('a commit in a submodule of a session copy has an identity (no per-repo config needed)', async () => {
  // A repo with a submodule, pushed to its own bare origin; a copy of it;
  // a commit inside the submodule through the system's git — the exact
  // step the auto-push died on with "Author identity unknown".
  const { git: sysGit, submoduleRepo, localRepo } = await import('../git/Git.js');
  const subOrigin = path.join(root, 'sub.git'); const subAuthor = path.join(root, 'sub-author');
  await fs.mkdir(subOrigin); await git(subOrigin, 'init', '-q', '--bare', '-b', 'main');
  await exec('git', ['clone', '-q', subOrigin, subAuthor]);
  await fs.writeFile(path.join(subAuthor, 'lib'), 'lib\n');
  await git(subAuthor, 'add', '.'); await git(subAuthor, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'lib');
  await git(subAuthor, 'push', '-q', 'origin', 'main');
  await git(author, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'sub');
  await git(author, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add sub');
  await git(author, 'push', '-q', 'origin', 'main');

  const pool = new CheckoutPool(paths, async () => headOf(origin, 'refs/heads/main'));
  await pool.pass([project]);   // the mirror catches up to the commit that added the submodule
  const dest = sessionDir(paths, 's5');
  await pool.copy(project, dest);
  const repo = localRepo(repoDir(paths, 's5'));
  await sysGit(repoDir(paths, 's5'), ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init']);
  const sub = submoduleRepo(repo, 'sub');
  await fs.writeFile(path.join(repoDir(paths, 's5'), 'sub', 'more'), 'more\n');
  await sub.git(['add', '-A']);
  await sub.git(['commit', '--no-verify', '-q', '-m', 'in the submodule']);
  assert.match((await sub.git(['log', '-1', '--format=%an <%ae>'])).stdout, /phantom-looper <agent@phantom-looper\.local>/);
});
