// The checkout pool: what makes a session's files instant. Per project, on
// each host that holds workspaces:
//
//   pool/mirror/<project>__<branch>           ONE bare clone — the only thing
//                                             that ever clones from GitHub
//   pool/ready/<project>__<branch>__<ulid>    the spare working copies, made
//                                             from the mirror, claimable
//   pool/setup/<same>                         a spare being made or brought
//                                             up to date — never read
//   work/<sessionId>/repo                     claimed; a session owns it
//
// A pass visits every project IN TURN and does the whole job for it: asks
// GitHub where the base branch is (one small API call, free when unchanged
// — git/GitHub.ts branchHead), pulls the mirror when it moved, brings every
// spare to the mirror (local, milliseconds), and makes spares up to
// `spare_clones` (local, milliseconds). One worker: a pass never starts
// under a running one, and projects never overlap, so a slow clone delays
// the next project and nothing else. A claim refills its own spare at once,
// in the background, so a burst of sessions finds a spare every time.
//
// Movement between ready/ and setup/ is a rename, and a rename is atomic:
// a claim and a pass can never both have the same spare. A spare under
// maintenance is in setup/, where a claim never looks; one that dies there
// is swept by age and never mistaken for usable. Nothing is thrown away on
// a timer — a spare at the mirror's commit IS a fresh clone.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRow } from '../storage/schema.js';
import type { Projects } from '../storage/Projects.js';
import type { Settings } from '../storage/Settings.js';
import { remoteUrl } from '../git/remote.js';
import { branchHead } from '../git/GitHub.js';
import { cloneFromMirror, cloneMirror, fetchMirror, fetchSubmodules, headOf, localRepo, syncFromMirror, type GitAuth } from '../git/Git.js';
import { newId } from '@phantom-agent-sdk/client';
import { mirrorDir, slotPrefix, type Paths } from '../lib/paths.js';
import { logger, errStr } from '../lib/log.js';
import { scopeOf } from '../lib/scopes.js';

const log = logger('pool');

/** A spare still in setup/ after this long is a dead one. Generous — a first
 *  copy of a large project is legitimately slow. */
const SETUP_STALE_MS = 30 * 60_000;

async function listDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}
const exists = (target: string) => fs.access(target).then(() => true, () => false);
const remove = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => {});

/** The chain — this project's token, else the global one, else unauthenticated
 *  — is `github_token` resolved through the same layers every other setting uses. */
export async function resolveAuth(settings: Settings, project: ProjectRow): Promise<GitAuth> {
  return { url: remoteUrl(project.owner, project.name), pat: await settings.credential('github_token', scopeOf(project)) };
}

/** What a pass needs to know about one project — resolved on the API (the
 *  database, the settings, the credential) and handed to whichever box
 *  holds the volume as a `poolTick` job. */
export interface PoolProject {
  id: string;
  owner: string;
  name: string;
  baseBranch: string;
  auth: GitAuth;
  /** spare_clones: how many spares to keep ready. */
  target: number;
  /** git_submodules: the spare carries its submodules already fetched. */
  submodules: boolean;
}

/** The facts for every project, or null when the list cannot be read. A
 *  pass fails OPEN: an unreadable project list must not empty the pool —
 *  but with no list we cannot tell "project removed" from "db down", so
 *  nothing is deleted either. The caller skips the pass. */
export async function poolFacts(projects: Projects, settings: Settings): Promise<PoolProject[] | null> {
  let rows: ProjectRow[];
  try { rows = await projects.list(); } catch (error) {
    log.warn({ err: errStr(error) }, 'skipping the pool pass — could not read projects');
    return null;
  }
  return Promise.all(rows.map(async (project) => {
    const cfg = await settings.resolveMany(['spare_clones', 'git_submodules'], scopeOf(project)) as { spare_clones: number; git_submodules: boolean };
    return {
      id: project.id, owner: project.owner, name: project.name, baseBranch: project.baseBranch,
      auth: await resolveAuth(settings, project),
      target: Number(cfg.spare_clones), submodules: cfg.git_submodules === true,
    };
  }));
}

/** The files a project's checkouts come from: its mirror, and what a copy
 *  of it needs. `copy` and the pass share it. */
type Source = Pick<PoolProject, 'id' | 'baseBranch' | 'auth'> & { submodules?: boolean };

/** `branchHead`'s shape: where GitHub says a branch is, or null for no answer. */
export type RemoteHead = (pat: string | undefined, owner: string, name: string, branch: string) => Promise<string | null>;

export class CheckoutPool {
  #passing = false;

  /** `remoteHead` is GitHub's answer; a test hands in its own. */
  constructor(private readonly paths: Paths, private readonly remoteHead: RemoteHead = branchHead) {}

  /** Anything in setup/ predates this process, so by definition its work died. */
  async bootCleanup(): Promise<void> {
    await remove(this.paths.poolSetup);
    for (const dir of [this.paths.poolMirror, this.paths.poolSetup, this.paths.poolReady, this.paths.work]) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  // ── a session takes its files ──────────────────────────────────────────

  /** One of the project's spares, renamed into `dest`. The rename is the
   *  whole claim — no locks, no bookkeeping; a second claimant gets ENOENT
   *  and takes the next, or copies. False when there is no spare. A claim
   *  refills the spare it took at once, in the background: the pile is
   *  full again long before the pass would have noticed. */
  async claim(project: Source, dest: string): Promise<boolean> {
    const prefix = slotPrefix(project.id, project.baseBranch);
    for (const slot of await listDir(this.paths.poolReady)) {
      if (!slot.startsWith(prefix)) continue;
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(path.join(this.paths.poolReady, slot), dest);
      } catch {
        continue;   // taken between the listing and the rename — try the next
      }
      void this.stock(project).catch((error) => log.warn({ project: project.id, err: errStr(error) }, 'could not refill the spare'));
      return true;
    }
    return false;
  }

  /** One more spare, made in setup/ and renamed into ready/ only when
   *  whole — the rename is what says it is usable. */
  private async stock(project: Source): Promise<void> {
    const slot = `${slotPrefix(project.id, project.baseBranch)}${newId()}`;
    const staging = path.join(this.paths.poolSetup, slot);
    try {
      await this.copy(project, staging);
      await fs.rename(staging, path.join(this.paths.poolReady, slot));
      log.info({ project: project.id, branch: project.baseBranch }, 'spare made');
    } catch (error) {
      await remove(staging);
      throw error;
    }
  }

  /** A working copy at `dest/repo` straight from the mirror — no network,
   *  unless the mirror itself does not exist yet (a project's first checkout
   *  on this host, before a pass has run): then it is cloned first. */
  async copy(project: Source, dest: string): Promise<void> {
    const mirror = await this.mirror(project);
    await cloneFromMirror(mirror, path.join(dest, 'repo'), project.auth, project.baseBranch);
    if (project.submodules) await fetchSubmodules(localRepo(path.join(dest, 'repo')), project.auth);
    await fs.mkdir(path.join(dest, 'scratch'), { recursive: true });
  }

  /** The mirror's path, cloned from GitHub when missing. */
  private async mirror(project: Source): Promise<string> {
    const mirror = mirrorDir(this.paths, project.id, project.baseBranch);
    if (!(await exists(mirror))) {
      await cloneMirror(mirror, project.auth, project.baseBranch);
      log.info({ project: project.id, branch: project.baseBranch }, 'mirror cloned');
    }
    return mirror;
  }

  // ── the pass ───────────────────────────────────────────────────────────

  /** Reconcile this box's pool to `projects`, one project at a time. A pass
   *  under a running one is dropped. Reads no database: `projects` are the
   *  facts (poolFacts), the same on the API and on a runner. */
  async pass(projects: PoolProject[]): Promise<void> {
    if (this.#passing) return;
    this.#passing = true;
    try {
      await this.sweep(projects);
      for (const project of projects) {
        try { await this.visit(project); } catch (error) {
          log.warn({ project: `${project.owner}/${project.name}`, err: errStr(error) }, 'pool pass failed for the project');
        }
      }
    } finally {
      this.#passing = false;
    }
  }

  /** Dead work in setup/, and mirrors and spares of projects this host no
   *  longer serves. */
  private async sweep(projects: PoolProject[]): Promise<void> {
    const now = Date.now();
    for (const slot of await listDir(this.paths.poolSetup)) {
      const stat = await fs.stat(path.join(this.paths.poolSetup, slot)).catch(() => null);
      if (!stat || now - stat.mtimeMs > SETUP_STALE_MS) await remove(path.join(this.paths.poolSetup, slot));
    }
    const prefixes = projects.map((project) => slotPrefix(project.id, project.baseBranch));
    for (const slot of await listDir(this.paths.poolReady)) {
      if (!prefixes.some((prefix) => slot.startsWith(prefix))) await remove(path.join(this.paths.poolReady, slot));
    }
    const mirrors = new Set(projects.map((project) => path.basename(mirrorDir(this.paths, project.id, project.baseBranch))));
    for (const mirror of await listDir(this.paths.poolMirror)) {
      if (!mirrors.has(mirror)) await remove(path.join(this.paths.poolMirror, mirror));
    }
  }

  /** One project: the mirror current, then every spare current, then
   *  spares made up to the target. */
  private async visit(project: PoolProject): Promise<void> {
    const { auth, baseBranch: branch } = project;
    const label = `${project.owner}/${project.name}`;

    // The mirror. GitHub's answer decides whether a pull is needed; no
    // answer (unreachable, rate-limited) means pull — "unknown" is never
    // read as "unchanged".
    const mirror = await this.mirror(project);
    const remote = await this.remoteHead(auth.pat, project.owner, project.name, branch);
    const had = await headOf(mirror, `refs/heads/${branch}`);
    if (remote !== had) {
      await fetchMirror(mirror, auth, branch);
      log.info({ project: label, from: had.slice(0, 7), to: (await headOf(mirror, `refs/heads/${branch}`)).slice(0, 7) }, 'mirror pulled');
    }
    const want = await headOf(mirror, `refs/heads/${branch}`);

    // The spares: each at the mirror's commit, or brought there in setup/
    // (a claim that lands meanwhile finds one fewer — never a spare
    // mid-reset). Beyond the target, removed; short of it, made.
    const prefix = slotPrefix(project.id, branch);
    const spares = (await listDir(this.paths.poolReady)).filter((slot) => slot.startsWith(prefix));
    for (const slot of spares.slice(project.target)) await remove(path.join(this.paths.poolReady, slot));
    let have = Math.min(spares.length, project.target);
    for (const spare of spares.slice(0, project.target)) {
      const ready = path.join(this.paths.poolReady, spare);
      if (await headOf(path.join(ready, 'repo'), 'HEAD').catch(() => '') === want) continue;
      const staging = path.join(this.paths.poolSetup, spare);
      try { await fs.rename(ready, staging); } catch { continue; }   // claimed under us — the claim refills it
      try {
        await syncFromMirror(path.join(staging, 'repo'), mirror, branch);
        if (project.submodules) await fetchSubmodules(localRepo(path.join(staging, 'repo')), auth);
        await fs.rename(staging, ready);
        log.info({ project: label, at: want.slice(0, 7) }, 'spare brought to the mirror');
      } catch (error) {
        log.warn({ project: label, err: errStr(error) }, 'spare would not sync — discarding');
        await remove(staging);
        have--;
      }
    }
    for (; have < project.target; have++) {
      try { await this.stock(project); } catch (error) {
        log.warn({ project: label, err: errStr(error) }, 'could not make a spare');
        break;
      }
    }
  }
}
