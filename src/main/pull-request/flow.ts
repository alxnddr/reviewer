import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ReviewRef, type CommitSha, type GitFailure, type RepoInfo } from "../../shared/git";
import {
  isPullRequestRepo,
  parseGitHubRemote,
  pullRequestCloneUrl,
  placedWorktreeRef,
  pullRequestRef,
  type PullRequest,
} from "../../shared/pull-request";
import type {
  BaseSuggestion,
  PreparedPullRequest,
  PullRequestBase,
  PullRequestCheckout,
  PullRequestFailure,
  PullRequestLocateResponse,
  PullRequestPrepareRequest,
  PullRequestRemoveWorktreeResponse,
  PullRequestResult,
  RemoteName,
  WorktreeChange,
} from "../../shared/pull-request-ipc";
import {
  addDetachedWorktree,
  clonePartial,
  defaultBranch,
  deleteRef,
  fetchRefspecs,
  listRemotes,
  listWorktrees,
  remoteDefaultBranch,
  removeWorktree,
  resolveCommit,
  switchDetached,
  updateRef,
} from "../git/ops";
import type { GitRunner } from "../git/runner";
import type { CheckoutMemory } from "./checkouts";
import {
  isInside,
  pathExists,
  pullRequestOfWorktree,
  realPath,
  registeredWorktree,
  repositoryOf,
  worktreeChanges,
  worktreeLocation,
} from "./worktrees";

// Review Pull Request…, the effectful core (`next-features.md`, B3): find a checkout of the
// pull request's repository, fetch the pull request into it with the reader's own git
// credentials, and give it a worktree for the reader's agent to review in. Electron-free — the
// pickers, `app.getPath` and the session store reach it through `PullRequestDeps` from
// `handlers.ts` — so the whole flow is tested under plain node against real temp repositories
// with a local bare repository standing in for GitHub (`flow.test.ts`).
//
// **The reader's checkout is not touched.** That is the property the whole design is bought
// for, so it is worth saying what each step writes. The fetch writes the pull request's ref
// (`pullRequestRef`, under `refs/rvw/`) and the base's remote-tracking ref
// (`refs/remotes/<remote>/<base>`), and with `--refmap=` nothing else — no local branch through
// a configured mirror refspec, not FETCH_HEAD, not tags (`fetchRefspecs`). The worktree is a
// second working tree with its own HEAD and index, detached, so no branch is checked out twice
// or moved; `worktree add` and `worktree remove` edit only `.git/worktrees/<name>` and the
// worktree's own directory; and no hook runs anywhere in the flow (`UNTRUSTED_TREE_CONFIG` in
// `git/ops.ts` says why that matters for a pull request's tree). `flow.test.ts` proves it end to
// end — HEAD, branch, status, stash, every ref outside `refs/rvw` and an uncommitted file,
// before and after the whole flow.
//
// One residue to know about: on a clone whose remote fetches only some branches (a
// `--single-branch` clone, a narrowed `remote.<r>.fetch`), the forced
// `refs/remotes/<remote>/<base>` is a remote-tracking ref the reader's own `git fetch` neither
// updates nor prunes. It goes stale rather than wrong — every run of this flow refreshes it —
// and deleting it by hand is harmless.
//
// **Nothing that holds work is lost.** A worktree is moved to a newly fetched head, or removed,
// only when it holds nothing: no uncommitted or untracked files, no commits that no ref holds
// (an agent that committed on the detached HEAD — `worktreeChanges`), and for a move, no branch
// someone switched it to. Remove also refuses anything under the worktrees root that is not, by
// realpath and by git's own registration at exactly that path, one of the repository's linked
// worktrees — so a symlink planted there can never point the removal at someone's checkout.
//
// **Which checkouts are "known".** Every repository the app has a path for: the open tabs, the
// recent reviews, and the relocations a reader made. Each is resolved to its *main* working tree
// first (`git worktree list` names it first), because a tab may be open on one of the
// worktrees this very flow made — and a review read in a worktree must lead back to the
// repository, not to another worktree. A checkout matches when one of its remotes names the
// pull request's repository, in any spelling (`parseGitHubRemote`: https, ssh, scp-like,
// with or without `.git`), compared case-insensitively. Every remote, not just `origin`: in a
// fork workflow the pull request's repository is `upstream`, and `pull/<n>/head` exists only
// there.
//
// **The remote is re-matched on every request**, not trusted from the locate that suggested it:
// the renderer hands back a path and a remote name, and both are untrusted until git says the
// path is a repository whose remote of that name names the pull request's repository.

export type PullRequestDeps = {
  runner: GitRunner;
  /** Every repository path the app knows about, best candidates first. */
  knownRepoPaths: () => Promise<readonly string[]>;
  /** The paths open tabs read from — a worktree one of them is on is not removed. */
  openRepoPaths: () => readonly string[];
  checkouts: CheckoutMemory;
  /** Where worktrees go: created if missing, and with symlinks resolved, because git reports
   * every worktree path resolved and the flow compares against those. */
  worktreesRoot: () => Promise<string>;
};

/** A git failure as this flow reports it: a cancel is its own outcome, not a git error. */
function fromGit(failure: GitFailure): PullRequestFailure {
  return failure.code === "cancelled" ? { code: "cancelled" } : { code: "git", failure };
}

function gitFailed<T>(failure: GitFailure): PullRequestResult<T> {
  return { ok: false, failure: fromGit(failure) };
}

function failed<T>(failure: PullRequestFailure): PullRequestResult<T> {
  return { ok: false, failure };
}

/** `origin` first, then `upstream`, then the rest by name: when several remotes name the same
 * repository, the one most readers would expect wins, and the choice is stable run to run. */
function remoteRank(name: string): number {
  return name === "origin" ? 0 : name === "upstream" ? 1 : 2;
}

/** A repository and every one of its remotes that names the pull request's repository. */
type MatchedCheckout = { repo: RepoInfo; remotes: RemoteName[] };

/** The remotes of an already-resolved repository that name the pull request's repository, best
 * first — or `noMatchingRemote` when none does. */
async function matchIn(
  runner: GitRunner,
  repo: RepoInfo,
  pr: PullRequest,
): Promise<PullRequestResult<MatchedCheckout>> {
  const remotes = await listRemotes(runner, repo.path);
  if (!remotes.ok) {
    return gitFailed(remotes.failure);
  }
  const names = remotes.value
    .filter((remote) =>
      remote.urls.some((url) => {
        const parsed = parseGitHubRemote(url);
        return parsed.ok && isPullRequestRepo(pr, parsed.repo);
      }),
    )
    .map((remote) => remote.name)
    .toSorted((a, b) => remoteRank(a) - remoteRank(b) || a.localeCompare(b));
  return names.length === 0
    ? failed({ code: "noMatchingRemote", repo: repo.path })
    : { ok: true, value: { repo, remotes: names } };
}

/** `path` as a checkout of the pull request's repository: resolved to its repository
 * (`repositoryOf` — the main working tree, or a bare repository's own directory, so locate and
 * adopt answer alike for both layouts), then matched (`matchIn`). */
async function checkoutAt(
  runner: GitRunner,
  pr: PullRequest,
  path: string,
): Promise<PullRequestResult<MatchedCheckout>> {
  const repo = await repositoryOf(runner, path);
  return repo.ok ? matchIn(runner, repo.value, pr) : gitFailed(repo.failure);
}

/** The base the dialog prefills: the remote's HEAD branch when the checkout recorded one, else
 * the checkout's own default branch. A failed read is no suggestion — the reader types one. */
async function suggestBase(
  runner: GitRunner,
  checkout: PullRequestCheckout,
): Promise<BaseSuggestion | null> {
  const remoteHead = await remoteDefaultBranch(runner, checkout.repo.path, checkout.remote);
  if (remoteHead.ok && remoteHead.value !== null) {
    return { name: remoteHead.value, from: "remoteHead" };
  }
  const local = await defaultBranch(runner, checkout.repo.path);
  return local.ok && local.value !== null ? { name: local.value, from: "localDefault" } : null;
}

/** A matched checkout as the dialog is offered it: its best remote, and the base to prefill. */
async function found(
  runner: GitRunner,
  matched: MatchedCheckout,
): Promise<PullRequestLocateResponse> {
  // `matchIn` only answers a match with at least one remote.
  const remote = matched.remotes[0];
  if (remote === undefined) {
    return gitFailed({ code: "unexpected" });
  }
  const checkout: PullRequestCheckout = { repo: matched.repo, remote };
  return {
    ok: true,
    value: { kind: "found", checkout, base: await suggestBase(runner, checkout) },
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a remembered checkout's failure says the memory is *wrong*, rather than that it
 * could not be checked right now. Wrong: its remotes no longer name the repository, or the
 * directory is there and is not a repository any more. Not wrong: git missing, a timeout, or a
 * directory that is not there at all — which is also what an unmounted volume or a checkout
 * being moved looks like, and a later Locate overwrites the entry anyway. Forgetting on those
 * would make the reader answer the question again for a checkout that is still theirs. */
async function memoryIsWrong(failure: PullRequestFailure, remembered: string): Promise<boolean> {
  if (failure.code === "noMatchingRemote") {
    return true;
  }
  return (
    failure.code === "git" && failure.failure.code === "notARepo" && (await isDirectory(remembered))
  );
}

/** Step 1: a checkout of the pull request's repository among the ones the app knows, the
 * remembered one first. A remembered checkout that is no longer a match is forgotten
 * (`memoryIsWrong` says when) and the search goes on; nothing is remembered by the search
 * itself (`checkouts.ts` says why). Each known path is resolved to its repository once, and a
 * repository reached from two paths is matched once. `notFound` is what offers Locate and the
 * clone. */
export async function locateCheckout(
  deps: PullRequestDeps,
  pr: PullRequest,
): Promise<PullRequestLocateResponse> {
  const remembered = deps.checkouts.get(pr);
  if (remembered !== null) {
    const checkout = await checkoutAt(deps.runner, pr, remembered);
    if (checkout.ok) {
      return found(deps.runner, checkout.value);
    }
    if (await memoryIsWrong(checkout.failure, remembered)) {
      deps.checkouts.forget(pr);
    }
  }

  const tried = new Set<string>();
  for (const path of await deps.knownRepoPaths()) {
    const repo = await repositoryOf(deps.runner, path);
    if (!repo.ok || tried.has(repo.value.path)) {
      continue;
    }
    tried.add(repo.value.path);
    const matched = await matchIn(deps.runner, repo.value, pr);
    if (matched.ok) {
      return found(deps.runner, matched.value);
    }
  }
  return { ok: true, value: { kind: "notFound" } };
}

/** Locate Repository…'s answer, and the clone's: the picked path must be a checkout of the pull
 * request's repository — a directory whose remotes do not name it is refused, not remembered —
 * and once it is, it is remembered for every later pull request of that repository. The same
 * `checkoutAt` as the search, so a layout one finds is a layout the other accepts. */
export async function adoptCheckout(
  deps: PullRequestDeps,
  pr: PullRequest,
  picked: string,
): Promise<PullRequestLocateResponse> {
  const checkout = await checkoutAt(deps.runner, pr, picked);
  if (!checkout.ok) {
    return checkout;
  }
  deps.checkouts.remember(pr, checkout.value.repo.path);
  return found(deps.runner, checkout.value);
}

/** Where `cloneCheckout` puts a clone picked into `parentDir`. */
function cloneTarget(parentDir: string, pr: PullRequest): string {
  return join(parentDir, pr.repo);
}

/** The write-queue key (`handlers.ts`) a clone into `parentDir` runs under. Two clones of one
 * target must not overlap: the second's "is the target free?" check can pass before the first
 * has made it, and then the first's cleanup of a failed clone removes the directory the second
 * is cloning into. Queued, the second runs after the first has settled and answers
 * `cloneTargetExists` or clones into a clean slate. Lowercased, because the volume a Mac clones
 * onto is case-insensitive by default — `Widget` and `widget` are one directory there — and
 * over-serializing two clones on a case-sensitive one only costs a wait. */
export function cloneQueueKey(parentDir: string, pr: PullRequest): string {
  return `clone:${cloneTarget(parentDir, pr).toLowerCase()}`;
}

/** Step 5, the fallback: a blobless partial clone of the pull request's repository into
 * `<parentDir>/<repo>`, then the same adoption a located checkout gets. Never over an existing
 * path — a directory (or a link) of that name is the reader's, whatever is in it. Run under
 * `cloneQueueKey`, which is what makes "it was absent a moment ago" below true of this run. */
export async function cloneCheckout(
  deps: PullRequestDeps,
  pr: PullRequest,
  parentDir: string,
  signal?: AbortSignal,
): Promise<PullRequestLocateResponse> {
  const target = cloneTarget(parentDir, pr);
  if (await pathExists(target)) {
    return failed({ code: "cloneTargetExists", path: target });
  }
  const cloned = await clonePartial(
    deps.runner,
    parentDir,
    pullRequestCloneUrl(pr),
    pr.repo,
    signal,
  );
  if (!cloned.ok) {
    // A clone cancelled or failed partway leaves `<parent>/<repo>` behind (git removes it on
    // SIGTERM, not on a SIGKILL after the grace), and every retry would then be refused as
    // `cloneTargetExists`. It is removed — and only because it was absent a moment ago, when
    // this run checked: the flow made it. A directory that was there before never gets here.
    await rm(target, { recursive: true, force: true }).catch((error: unknown) => {
      console.error(`A failed clone's directory could not be removed: ${target}`, error);
    });
    return gitFailed(cloned.failure);
  }
  return adoptCheckout(deps, pr, cloned.value.path);
}

/** A fetch's missing remote ref, told apart: the pull request's own head missing is a pull
 * request that does not exist; the base's is a base the reader should correct. */
function fetchFailure(
  failure: GitFailure,
  pr: PullRequest,
  base: PullRequestBase,
): PullRequestFailure {
  if (failure.code === "remoteRefMissing") {
    if (failure.ref === `refs/pull/${pr.number}/head`) {
      return { code: "prNotFound" };
    }
    if (failure.ref === `refs/heads/${base}`) {
      return { code: "baseNotFound", base };
    }
  }
  return fromGit(failure);
}

/** Step 3: the worktree at `path` standing on `head`, whatever state it was left in.
 *
 * - Registered here but locked by git (`initializing` is an add that never finished): refused
 *   (`worktreeLocked`), never `current` — its tree may be truncated, and the agent must not be
 *   sent to review half a checkout — and never cleared by the flow, which cannot tell a
 *   half-written tree from work someone put in it.
 * - Registered here as a linked worktree, and really at `path` (not a symlink to somewhere
 *   else): already on `head` is `current`; otherwise it is moved — unless someone switched it to
 *   a branch (it is theirs now: `worktreeOnBranch`), or it holds work (`worktreeChanges`:
 *   files, or commits beyond what the flow placed), in which case it is left exactly where it
 *   is.
 * - Registered but its directory deleted by hand: the stale registration is cleared with
 *   `git worktree remove` — which for a missing directory only drops git's bookkeeping for
 *   *that* worktree, unlike `git worktree prune`, which would sweep every stale worktree of the
 *   reader's repository — and the worktree is made afresh.
 * - Anything else at the path — a directory, a file, a symlink even a dangling one (`lstat`),
 *   a worktree of a different clone — is refused; nothing at a path the flow did not make is
 *   overwritten or adopted.
 *
 * Whatever it leaves the worktree on is recorded as the placed ref (`placedWorktreeRef`), so a
 * later force-push that rewrites the pull request does not turn the commit the flow itself
 * checked out into "commits nobody else has". The checkout and the switch are not cancellable
 * (`addDetachedWorktree` says why); Cancel stops only the fetch before them. */
async function placeWorktree(
  runner: GitRunner,
  repoPath: string,
  pr: PullRequest,
  path: string,
  head: CommitSha,
): Promise<PullRequestResult<WorktreeChange>> {
  const ref = pullRequestRef(pr);
  const worktrees = await listWorktrees(runner, repoPath);
  if (!worktrees.ok) {
    return gitFailed(worktrees.failure);
  }
  const registered = registeredWorktree(worktrees.value, path);
  const present = await pathExists(path);
  const real = present ? await realPath(path) : null;

  let change: WorktreeChange;
  if (registered !== undefined && registered.locked !== null) {
    return failed({ code: "worktreeLocked", path, checkout: repoPath, reason: registered.locked });
  } else if (registered !== undefined && present && real === path) {
    if (registered.head === head) {
      change = "current";
    } else {
      if (registered.branch !== null) {
        return failed({ code: "worktreeOnBranch", path, branch: registered.branch });
      }
      const changes = await worktreeChanges(runner, path);
      if (!changes.ok) {
        return gitFailed(changes.failure);
      }
      if (changes.value !== "none") {
        return failed({ code: "worktreeDirty", path, reason: changes.value });
      }
      const moved = await switchDetached(runner, path, ref);
      if (!moved.ok) {
        return gitFailed(moved.failure);
      }
      change = "moved";
    }
  } else if (present) {
    return failed({ code: "worktreePathTaken", path });
  } else {
    if (registered !== undefined) {
      const cleared = await removeWorktree(runner, repoPath, path);
      if (!cleared.ok) {
        return gitFailed(cleared.failure);
      }
    }
    await mkdir(dirname(path), { recursive: true });
    const added = await addDetachedWorktree(runner, repoPath, path, ref);
    if (!added.ok) {
      return gitFailed(added.failure);
    }
    change = "created";
  }
  // Written for `current` too, which is idempotent, and is how a worktree made before the
  // placed ref existed gets one.
  //
  // A failure to write it is logged, not answered. By now the worktree is on `head`: answering a
  // failure would tell the reader it is not, and send them to retry a placement that already
  // happened. Nothing is unreachable yet either — `pullRequestRef` names `head` too, having just
  // been fetched. The ref only matters after the pull request is next *rewritten*; the next run
  // that finds the worktree `current` writes it again before then, and if a rewrite comes first,
  // what the missing ref costs is a refusal — the move or Remove answers `worktreeDirty`
  // (`commits`), the cautious direction — never a lost commit.
  const placed = await updateRef(runner, repoPath, placedWorktreeRef(pr), head);
  if (!placed.ok) {
    console.error(
      `The placed ref for ${path} could not be written; the next run that finds it current writes it:`,
      placed.failure,
    );
  }
  return { ok: true, value: change };
}

/** Steps 2 and 3: fetch the pull request's head into its ref and its base into the
 * remote-tracking ref, then put the worktree on that head.
 *
 * Both refspecs are forced (`+`): a pull request is force-pushed as a matter of course, and the
 * ref is a mirror of the remote's, not history of the reader's to protect. One fetch for both,
 * so a slow remote is paid once. `signal` is Cancel: it kills whichever git is running and the
 * answer is `cancelled`. */
export async function preparePullRequest(
  deps: PullRequestDeps,
  request: PullRequestPrepareRequest,
  signal?: AbortSignal,
): Promise<PullRequestResult<PreparedPullRequest>> {
  const { pullRequest: pr, base } = request;
  const checkout = await checkoutAt(deps.runner, pr, request.checkout.repoPath);
  if (!checkout.ok) {
    return checkout;
  }
  const remote = request.checkout.remote;
  if (!checkout.value.remotes.includes(remote)) {
    return failed({ code: "noMatchingRemote", repo: checkout.value.repo.path });
  }
  const repoPath = checkout.value.repo.path;
  const ref = pullRequestRef(pr);

  const fetched = await fetchRefspecs(
    deps.runner,
    repoPath,
    remote,
    [`+refs/pull/${pr.number}/head:${ref}`, `+refs/heads/${base}:refs/remotes/${remote}/${base}`],
    signal,
  );
  if (!fetched.ok) {
    return failed(fetchFailure(fetched.failure, pr, base));
  }
  const head = await resolveCommit(deps.runner, repoPath, ref);
  if (!head.ok) {
    return gitFailed(head.failure);
  }
  if (head.value === null) {
    // The fetch said it wrote the ref; a ref that then does not resolve is git disagreeing
    // with itself, not anything the reader can act on.
    return gitFailed({ code: "unexpected" });
  }

  const path = worktreeLocation(await deps.worktreesRoot(), pr);
  const placed = await placeWorktree(deps.runner, repoPath, pr, path, head.value);
  if (!placed.ok) {
    return placed;
  }
  // `<remote>/<base>` — both validated names, so the pair is a valid ref by the same rules.
  const baseRef = ReviewRef.safeParse(`${remote}/${base}`);
  if (!baseRef.success) {
    return gitFailed({ code: "unexpected" });
  }
  return {
    ok: true,
    value: { worktree: path, head: head.value, base: baseRef.data, change: placed.value },
  };
}

/** Remove worktree. Manual only — nothing removes one on its own, not when its pull request
 * merges or closes — and refused in each case where a removal could reach or lose something it
 * should not:
 *
 * - a path not laid out as one of this flow's worktrees, or one that is not really there — a
 *   symlink (its realpath differs), or a directory git does not register as a linked worktree
 *   at exactly this path: the removal must never follow a link to the reader's own checkout or
 *   another worktree of theirs;
 * - one a tab is reading;
 * - one holding work: files, or commits no ref holds (`worktreeChanges`) — checked here so the
 *   refusal is ours and typed, and again by git itself, which is never asked to `--force`.
 *
 * A worktree someone switched to a branch *is* removed: the branch, and every commit on it,
 * outlive the worktree. */
export async function removePullRequestWorktree(
  deps: PullRequestDeps,
  path: string,
): Promise<PullRequestRemoveWorktreeResponse> {
  const root = await deps.worktreesRoot();
  if (pullRequestOfWorktree(root, path) === null || (await realPath(path)) !== path) {
    return failed({ code: "notAWorktree", path });
  }
  if (deps.openRepoPaths().some((open) => open === path || isInside(path, open))) {
    return failed({ code: "worktreeOpen", path });
  }
  const repo = await repositoryOf(deps.runner, path);
  if (!repo.ok || repo.value.path === path) {
    return failed({ code: "notAWorktree", path });
  }
  const worktrees = await listWorktrees(deps.runner, repo.value.path);
  const registered = worktrees.ok ? registeredWorktree(worktrees.value, path) : undefined;
  if (registered === undefined) {
    return failed({ code: "notAWorktree", path });
  }
  if (registered.locked !== null) {
    return failed({
      code: "worktreeLocked",
      path,
      checkout: repo.value.path,
      reason: registered.locked,
    });
  }
  const changes = await worktreeChanges(deps.runner, path);
  if (!changes.ok) {
    return gitFailed(changes.failure);
  }
  if (changes.value !== "none") {
    return failed({ code: "worktreeDirty", path, reason: changes.value });
  }
  const removed = await removeWorktree(deps.runner, repo.value.path, path);
  if (!removed.ok) {
    return gitFailed(removed.failure);
  }
  if (removed.value === "dirty") {
    return failed({ code: "worktreeDirty", path, reason: "uncommitted" });
  }
  // The placed ref goes with the worktree it described. Best-effort: the worktree is already
  // gone, and a leftover ref only keeps one commit reachable until the next placement.
  const pullRequest = pullRequestOfWorktree(root, path);
  if (pullRequest !== null) {
    await deleteRef(deps.runner, repo.value.path, placedWorktreeRef(pullRequest));
  }
  // The owner's directory goes with its last worktree; `rmdir` refuses a non-empty one, which
  // is exactly the case where it should stay.
  await rmdir(dirname(path)).catch(() => {});
  return { ok: true, value: { path } };
}

/** The pull request's head as last fetched into `repoPath` — the sha its ref
 * (`pullRequestRef`) names there, which every worktree of the repository shares — or null when
 * nothing fetched it. */
export function readPullRequestHead(
  runner: GitRunner,
  repoPath: string,
  pr: PullRequest,
): ReturnType<typeof resolveCommit> {
  return resolveCommit(runner, repoPath, pullRequestRef(pr));
}
