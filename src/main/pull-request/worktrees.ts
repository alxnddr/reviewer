import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { GitResult, RepoInfo } from "../../shared/git";
import {
  GitHubPullRequest,
  GITHUB_HOST,
  PULL_REQUEST_REF_NAMESPACE,
  type PullRequest,
} from "../../shared/pull-request";
import type { PullRequestWorktree, WorktreeChanges } from "../../shared/pull-request-ipc";
import {
  hasUncommittedChanges,
  hasUnreachableCommits,
  listWorktrees,
  validateRepo,
  type WorktreeEntry,
} from "../git/ops";
import type { GitRunner } from "../git/runner";

// Where Review Pull Request… puts a pull request's worktree, and how it finds them again.
//
// **`<userData>/worktrees/<owner>/<repo>-<n>`**, lowercased. Each part of that is a decision:
//
// - **Under the app's own userData**, never `~/.rvw`: that directory is the CLI's, and
//   `rvw emit` owns every byte of `~/.rvw/reviews` — the app writing worktrees beside them
//   would make two programs owners of one tree, the reason read progress lives in userData too
//   (`main/index.ts`). Never inside the reader's checkout either: a worktree nested in the
//   working tree it belongs to shows up in that tree's own `git status`.
// - **A path that is a function of the pull request alone**, so running Review Pull Request…
//   again for the same one finds the worktree it made last time and moves it, instead of
//   making a second. Nothing about the run (a timestamp, a counter) is in it.
// - **`<owner>/<repo>-<n>` rather than the flat `<owner>-<repo>-<n>` the handoff suggested.**
//   GitHub owners and repositories may both contain `-`, so the flat form is ambiguous —
//   `a-b/c#1` and `a/b-c#1` are both `a-b-c-1`. Nested, the owner is its own segment and the
//   number is whatever follows the *last* `-` (it is all digits), so the mapping is one-to-one
//   and `pullRequestOfWorktree` can read it back. The last segment is still `widget-12`, which
//   is what a tab, a terminal prompt and git's own `.git/worktrees/<name>` show.
// - **Lowercased**, because GitHub's names are case-insensitive and a reader may paste
//   `Acme/Widget` one day and `acme/widget` the next: on a case-sensitive volume those would
//   otherwise be two worktrees of one pull request.
//
// **Path safety.** Owner and repository were validated at the IPC boundary as single URL-safe
// segments (`shared/pull-request.ts`: no `/`, never `.` or `..`), so the join cannot escape the
// root. `worktreeLocation` checks anyway, after the join — a schema loosened one day should
// fail here loudly, not write a worktree somewhere else on the disk.
//
// Electron-free: the root is passed in (`app.getPath("userData")` is read in `handlers.ts`), so
// the flow and its tests run under plain node against temp directories.

/** Whether `path` lies strictly inside `root` — both absolute and normalized by the caller. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The worktree directory for a pull request. Throws if the join would land outside `root`,
 * which the schemas make impossible; the throw is the tripwire for the day they do not. */
export function worktreeLocation(root: string, pr: PullRequest): string {
  const path = locationOf(root, pr);
  if (!isInside(root, path) || relative(root, path).split(sep).length !== 2) {
    throw new Error(`Refusing a worktree path outside ${root}: ${path}`);
  }
  return path;
}

/** A value-returning switch on the host with no `default:`, so a second host has to decide its
 * own layout here before it builds. */
function locationOf(root: string, pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return join(root, pr.owner.toLowerCase(), `${pr.repo.toLowerCase()}-${pr.number}`);
  }
}

/** The pull request a worktree directory was made for, read back off its two segments under
 * `root` — or null for anything under the root that is not one (a stray file, a directory
 * someone made by hand). Parsed through the same schema a pasted pull request crosses, so a
 * name that could not have come from `worktreeLocation` is not mistaken for one that did. */
export function pullRequestOfWorktree(root: string, path: string): GitHubPullRequest | null {
  if (!isInside(root, path)) {
    return null;
  }
  const segments = relative(root, path).split(sep);
  const [owner, leaf] = segments;
  const match = leaf === undefined ? null : /^(.+)-(\d+)$/u.exec(leaf);
  if (segments.length !== 2 || match === null) {
    return null;
  }
  const parsed = GitHubPullRequest.safeParse({
    host: GITHUB_HOST,
    owner,
    repo: match[1],
    number: Number(match[2]),
  });
  return parsed.success ? parsed.data : null;
}

/** Whether anything is at `path` — `lstat`, so a symlink counts even when it dangles, which
 * `existsSync` (it follows the link) would call absent and then watch `worktree add` fail on. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** `path` with every symlink resolved, or null when it does not resolve. */
export async function realPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** The repository `path` belongs to, as the place git's worktree commands are run from: the
 * main working tree (`git worktree list`'s first entry), validated like any checkout — or, for a
 * bare repository whose working trees are all worktrees (the `repo.git` + worktrees layout), the
 * bare directory itself, which is a repository but has no toplevel for `validateRepo` to find.
 * From any of its working trees the answer is the same, which is what lets a tab open on one of
 * the worktrees this flow made lead back to the repository it came from. A path that is not in
 * a repository answers git's own failure (`notARepo` for a missing directory too). */
export async function repositoryOf(runner: GitRunner, path: string): Promise<GitResult<RepoInfo>> {
  const worktrees = await listWorktrees(runner, path);
  if (!worktrees.ok) {
    return worktrees;
  }
  const main = worktrees.value.find((entry) => entry.main);
  if (main === undefined) {
    return validateRepo(runner, path);
  }
  return main.bare
    ? { ok: true, value: { path: main.path, name: basename(main.path) } }
    : validateRepo(runner, main.path);
}

/** One of the repository's *linked* worktrees registered at exactly `path` — never the main
 * one, so a path that is the repository itself is never mistaken for a worktree to move or
 * remove. */
export function registeredWorktree(
  entries: readonly WorktreeEntry[],
  path: string,
): WorktreeEntry | undefined {
  return entries.find((entry) => !entry.main && entry.path === path);
}

/** What a worktree holds that removing or moving it would lose: its files first (`git status`,
 * untracked included), then commits on its HEAD that no ref holds — the work an agent leaves
 * when it *commits* on the detached HEAD, which a clean status says nothing about. Everything
 * under `refs/rvw` counts as holding a commit: the fetched pull request heads, and the placed
 * refs (`placedWorktreeRef`) recording what the flow itself checked out — so after a force-push
 * rewrote the pull request, the old head the worktree still stands on is not mistaken for the
 * reader's work. "commits" means commits beyond what Reviewer put there. */
export async function worktreeChanges(
  runner: GitRunner,
  path: string,
): Promise<GitResult<WorktreeChanges>> {
  const uncommitted = await hasUncommittedChanges(runner, path);
  if (!uncommitted.ok) {
    return uncommitted;
  }
  if (uncommitted.value) {
    return { ok: true, value: "uncommitted" };
  }
  const commits = await hasUnreachableCommits(runner, path, PULL_REQUEST_REF_NAMESPACE);
  if (!commits.ok) {
    return commits;
  }
  return { ok: true, value: commits.value ? "commits" : "none" };
}

/** Directories one level down, or none when `dir` cannot be read (most often: not made yet). */
async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return (
      entries
        // Symlinks too, so one planted where a worktree goes is listed — and refused — rather
        // than hidden.
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(dir, entry.name))
        .toSorted()
    );
  } catch {
    return [];
  }
}

/** Every worktree under `root`, as the dialog lists them: which pull request, which repository
 * it belongs to, what it has checked out, and what a removal would lose.
 *
 * Read off the disk and then off git, per directory, sequentially — a handful of directories
 * at most, and a burst of parallel spawns is what the rest of main avoids. A directory that is
 * a symlink, or that git does not list as one of its repository's linked worktrees at exactly
 * this path, is still listed — with `checkout: null`, so it is explained rather than silently
 * skipped, and never offered a Remove. */
export async function listPullRequestWorktrees(
  runner: GitRunner,
  root: string,
): Promise<PullRequestWorktree[]> {
  const rows: PullRequestWorktree[] = [];
  for (const ownerDir of await subdirectories(root)) {
    for (const path of await subdirectories(ownerDir)) {
      const pullRequest = pullRequestOfWorktree(root, path);
      if (pullRequest === null) {
        continue;
      }
      const unknown: PullRequestWorktree = {
        path,
        pullRequest,
        checkout: null,
        head: null,
        changes: "none",
        branch: null,
        locked: null,
      };
      if ((await realPath(path)) !== path) {
        rows.push(unknown);
        continue;
      }
      const repository = await repositoryOf(runner, path);
      const worktrees = repository.ok ? await listWorktrees(runner, repository.value.path) : null;
      const own = worktrees?.ok === true ? registeredWorktree(worktrees.value, path) : undefined;
      if (!repository.ok || own === undefined) {
        rows.push(unknown);
        continue;
      }
      if (own.locked !== null) {
        // A locked tree may be a truncated checkout: its status is noise, and the row offers no
        // Remove either way (`worktreeLocked`).
        rows.push({
          ...unknown,
          checkout: repository.value.path,
          head: own.head,
          locked: own.locked,
        });
        continue;
      }
      const changes = await worktreeChanges(runner, path);
      rows.push({
        path,
        pullRequest,
        checkout: repository.value.path,
        head: own.head,
        // A state that cannot be read is reported as uncommitted work: the row's Remove is then
        // withheld, which is the safe way to be wrong about a working tree.
        changes: changes.ok ? changes.value : "uncommitted",
        branch: own.branch,
        locked: null,
      });
    }
  }
  return rows;
}
