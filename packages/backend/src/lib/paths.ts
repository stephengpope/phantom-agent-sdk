// Path math only — no db, no docker, nothing that has to be running for these
// to be true. All three trees MUST live on one filesystem (the named volume):
// rename is atomic within a filesystem and fails across them, and that
// atomicity is the entire concurrency story.
import path from 'node:path';

export interface Paths {
  root: string;
  /** The mirrors: one bare clone per project, the only thing that clones
   *  from GitHub (git/Git.ts, the mirror section). */
  poolMirror: string;
  poolSetup: string;
  poolReady: string;
  work: string;
}

export function makePaths(root: string): Paths {
  return {
    root,
    poolMirror: path.join(root, 'pool', 'mirror'),
    poolSetup: path.join(root, 'pool', 'setup'),
    poolReady: path.join(root, 'pool', 'ready'),
    work: path.join(root, 'work'),
  };
}

export function sessionDir(paths: Paths, sessionId: string): string {
  return path.join(paths.work, sessionId);
}
export function repoDir(paths: Paths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), 'repo');
}

/** Slot and mirror names say which PROJECT they serve (never just the repo
 *  — two organizations' projects on one repo each clone with their own
 *  token and never share a checkout) and which branch. A slot adds a ULID
 *  so two can exist while one is being replaced. */
export function slotPrefix(projectId: string, branch: string): string {
  return `${projectId}__${branch}__`;
}
export function mirrorDir(paths: Paths, projectId: string, branch: string): string {
  return path.join(paths.poolMirror, `${projectId}__${branch}`);
}
