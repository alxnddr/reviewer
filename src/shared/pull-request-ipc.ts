import * as z from "zod";
import {
  BranchName,
  CommitSha,
  GitFailure,
  isGitBranchName,
  RepoInfo,
  RepoPath,
  ReviewRef,
} from "./git";
import { GitHubPullRequest, PullRequest } from "./pull-request";

// The wire contracts for Review Pull Request… (`next-features.md`, B3): finding a checkout of
// a pull request's repository, fetching the pull request into it, giving it a worktree, and
// listing and removing those worktrees. Apart from `review-ipc.ts` because none of it is about
// a review yet — this is what happens *before* the agent writes one — and apart from `git.ts`
// because the requests name pull requests, not refs.
//
// Main does all of it: the renderer never names a directory it made up, never builds a
// refspec, and never learns more about a checkout than the path a reader will read in the
// dialog anyway. Every request is re-checked in main against git — a checkout the renderer
// hands back is validated as a repository again, and its remote is matched against the pull
// request again — because a renderer-supplied path is exactly as untrusted here as on every
// other channel.

/** A git remote's name. git holds remote names to its refname rules, which are `BranchName`'s
 * deny-list; that is also exactly what makes one safe as an argv element (no leading `-`) and
 * inside a refspec (no `:`, no `*`, no whitespace) — `refs/remotes/<remote>/<base>`. */
export const RemoteName = BranchName;
export type RemoteName = z.infer<typeof RemoteName>;

/** The base branch the reader typed: a name git itself would accept as a branch
 * (`isGitBranchName`), which is stricter than `BranchName`. Checked here so the dialog refuses
 * `a/.b` as a field error before anything is fetched, rather than the fetch failing with the
 * remote's own complaint — and so main, which parses this, never builds a refspec from one. */
export const PullRequestBase = BranchName.refine(isGitBranchName, {
  error: "Not a branch name git accepts",
});
export type PullRequestBase = z.infer<typeof PullRequestBase>;

/** A checkout of the pull request's repository, and the remote in it that names that
 * repository. The remote is part of the answer rather than assumed to be `origin`: in a fork
 * workflow `origin` is the reader's fork and the pull request's repository is `upstream`, and
 * `pull/<n>/head` exists only on the latter. */
export const PullRequestCheckout = z.object({ repo: RepoInfo, remote: RemoteName });
// `repo` is the repository's main working tree — or, for a bare repository whose working trees
// are all worktrees (the `repo.git` + worktrees layout), the bare directory itself, which is
// where git's worktree commands run from (`main/pull-request/flow.ts`'s `resolveRepository`).
export type PullRequestCheckout = z.infer<typeof PullRequestCheckout>;

/** The base branch the dialog suggests, and where the suggestion came from, so the dialog can
 * say how sure it is. A pull request's address does not carry its base, so on this machine it
 * is a guess the reader may correct:
 *
 * - `remoteHead`: the branch the remote's HEAD names (`refs/remotes/<remote>/HEAD`) — the
 *   repository's default branch, which is what most pull requests target.
 * - `localDefault`: no remote HEAD recorded, so the checkout's own default-branch detection
 *   (`main/git/ops.ts`'s `listBranches` order).
 * - `api`: GitHub's own answer (`base.ref`, `github:pull-request`) — not a guess but the branch
 *   the pull request targets, so it outranks both. Main's locate never answers it; the dialog's
 *   store puts it in place of the local guess when GitHub's answer arrives
 *   (`stores/pull-request.ts`'s `suggestedBase`), and it is here so the one type carries every
 *   source and the dialog's sentence for it is a closed switch arm. */
export const BaseSuggestion = z.object({
  name: BranchName,
  from: z.enum(["remoteHead", "localDefault", "api"]),
});
export type BaseSuggestion = z.infer<typeof BaseSuggestion>;

/** What looking for a checkout found. `notFound` is an answer, not a failure: it is what
 * offers Locate Repository… and the clone fallback. `canceled` is a picker dismissed. */
export const PullRequestLocateOutcome = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("found"),
    checkout: PullRequestCheckout,
    base: BaseSuggestion.nullable(),
  }),
  z.object({ kind: z.literal("notFound") }),
  z.object({ kind: z.literal("canceled") }),
]);
export type PullRequestLocateOutcome = z.infer<typeof PullRequestLocateOutcome>;

/** Why a step of the flow could not complete. Codes, with the sentences composed in the
 * renderer (`lib/pull-request-failure-message.ts`); a git failure rides inside, whole, so its
 * sentence is the one every other git errand shows (`lib/git-failure-message.ts`). */
export const PullRequestFailure = z.discriminatedUnion("code", [
  z.object({ code: z.literal("git"), failure: GitFailure }),
  /** A checkout the reader located, or one the app remembered, has no remote for the pull
   * request's repository — so `pull/<n>/head` cannot be fetched into it. */
  z.object({ code: z.literal("noMatchingRemote"), repo: RepoPath }),
  /** The remote has no `refs/pull/<n>/head`: no such pull request on that repository. */
  z.object({ code: z.literal("prNotFound") }),
  /** The remote has no branch of that name to compare against. */
  z.object({ code: z.literal("baseNotFound"), base: BranchName }),
  /** The worktree holds work a move or a removal would lose, so it was left exactly as it is:
   * `uncommitted` — modified, staged or untracked files; `commits` — commits on its detached
   * HEAD that no branch, tag, remote-tracking or `refs/rvw` ref holds (an agent that committed
   * there). */
  z.object({
    code: z.literal("worktreeDirty"),
    path: RepoPath,
    reason: z.enum(["uncommitted", "commits"]),
  }),
  /** Someone switched the worktree to a branch of their own, so it is theirs now: it is not
   * moved off that branch to the pull request's new head. Removing it is still allowed — the
   * branch outlives the worktree. */
  z.object({ code: z.literal("worktreeOnBranch"), path: RepoPath, branch: z.string().max(255) }),
  /** git holds a lock on the worktree — most often `initializing`, the lock `worktree add`
   * holds while it writes, left behind by a checkout that was killed or crashed before it
   * finished. Such a tree may be truncated, so it is never reported as ready, moved or removed;
   * the reader is told how to clear it, in `checkout`, by hand. `reason` is git's, `""` for a
   * lock without one. */
  z.object({
    code: z.literal("worktreeLocked"),
    path: RepoPath,
    checkout: RepoPath,
    reason: z.string().max(512),
  }),
  /** Something that is not this repository's worktree already sits where the worktree goes. */
  z.object({ code: z.literal("worktreePathTaken"), path: RepoPath }),
  /** A tab is reading the worktree, so it is not removed out from under it. */
  z.object({ code: z.literal("worktreeOpen"), path: RepoPath }),
  /** The path asked to be removed is not one of the worktrees Review Pull Request… made. */
  z.object({ code: z.literal("notAWorktree"), path: z.string().max(4096) }),
  /** The clone's directory already exists in the folder the reader picked. */
  z.object({ code: z.literal("cloneTargetExists"), path: RepoPath }),
  /** The reader pressed Cancel while a fetch or clone was running (a checkout is let finish:
   * `main/pull-request/handlers.ts`); the child was stopped. A fetched ref it had already
   * written stays; a clone's partial directory is removed (`cloneCheckout`). */
  z.object({ code: z.literal("cancelled") }),
]);
export type PullRequestFailure = z.infer<typeof PullRequestFailure>;

/** Every answer of these channels: the value, or a typed failure — never a rejected promise. */
function resultOf<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), failure: PullRequestFailure }),
  ]);
}

export type PullRequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: PullRequestFailure };

/** The three ways to find the checkout all name only the pull request: main matches it against
 * the checkouts it knows, or shows the picker, or clones — and answers with what it found. */
export const PullRequestRequest = z.object({ pullRequest: PullRequest });
export type PullRequestRequest = z.infer<typeof PullRequestRequest>;

export const PullRequestLocateResponse = resultOf(PullRequestLocateOutcome);
export type PullRequestLocateResponse = PullRequestResult<PullRequestLocateOutcome>;

/** Fetch the pull request and give it a worktree. `checkout` is what an earlier locate
 * answered — untrusted on the way back in, so main validates the path and re-matches the remote
 * before it fetches anything. `base` is the reader's, prefilled from the suggestion. */
export const PullRequestPrepareRequest = z.object({
  pullRequest: PullRequest,
  checkout: z.object({ repoPath: RepoPath, remote: RemoteName }),
  base: PullRequestBase,
});
export type PullRequestPrepareRequest = z.infer<typeof PullRequestPrepareRequest>;

/** What the worktree step did:
 *
 * - `created`: a new worktree on the pull request's head.
 * - `moved`: the worktree already existed and was clean, and now stands on the newly fetched
 *   head.
 * - `current`: the worktree already stood on that head; nothing moved. */
export const WorktreeChange = z.enum(["created", "moved", "current"]);
export type WorktreeChange = z.infer<typeof WorktreeChange>;

/** A pull request ready to review: the worktree, the commit it stands on, and the base to
 * compare against, spelled as the remote-tracking ref the fetch just updated
 * (`<remote>/<base>`), because that is the name that is fresh — a local `main` may be weeks
 * old — and that resolves in the worktree and in the checkout alike. These are the prompt's
 * `{worktree}`, `{head}` and `{base}`. */
export const PreparedPullRequest = z.object({
  worktree: RepoPath,
  head: CommitSha,
  base: ReviewRef,
  change: WorktreeChange,
});
export type PreparedPullRequest = z.infer<typeof PreparedPullRequest>;

export const PullRequestPrepareResponse = resultOf(PreparedPullRequest);
export type PullRequestPrepareResponse = PullRequestResult<PreparedPullRequest>;

/** What a worktree holds that a removal would lose: nothing, files (`uncommitted`), or
 * commits no ref holds (`commits`) — the two reasons `worktreeDirty` names, said apart because
 * what the reader does about each is different. */
export const WorktreeChanges = z.enum(["none", "uncommitted", "commits"]);
export type WorktreeChanges = z.infer<typeof WorktreeChanges>;

/** One worktree Review Pull Request… made, as the dialog lists it. `pullRequest` is read back
 * from the directory's name, which is lowercased (`main/pull-request/worktrees.ts` says why),
 * so it is the pull request's address in GitHub's case-insensitive sense, not its display
 * case. `checkout` is the repository it belongs to, or null when git no longer recognizes it
 * as one of that repository's worktrees; `changes` is what decides whether Remove is offered,
 * and `branch` is a branch someone switched it to (null while it is detached, as it is made). */
export const PullRequestWorktree = z.object({
  path: RepoPath,
  pullRequest: GitHubPullRequest,
  checkout: RepoPath.nullable(),
  head: CommitSha.nullable(),
  changes: WorktreeChanges,
  branch: z.string().max(255).nullable(),
  /** git's lock on it and the reason (`worktreeLocked`), or null. A locked row offers no Remove. */
  locked: z.string().max(512).nullable(),
});
export type PullRequestWorktree = z.infer<typeof PullRequestWorktree>;

/** The list answers plainly, like `reviews:recent`: a worktree git cannot read is a row that
 * says so (`checkout: null`), not a failed call. */
export const PullRequestWorktreesResponse = z.object({
  worktrees: z.array(PullRequestWorktree),
});
export type PullRequestWorktreesResponse = z.infer<typeof PullRequestWorktreesResponse>;

export const PullRequestRemoveWorktreeRequest = z.object({ path: RepoPath });
export type PullRequestRemoveWorktreeRequest = z.infer<typeof PullRequestRemoveWorktreeRequest>;

export const PullRequestRemoveWorktreeResponse = resultOf(z.object({ path: RepoPath }));
export type PullRequestRemoveWorktreeResponse = PullRequestResult<{ path: RepoPath }>;

/** The sha the pull request's ref (`pullRequestRef`, `refs/rvw/pr/<owner>/<repo>/<n>`) resolves
 * to in a review's repository — its head as last fetched — for Copy & open on GitHub's drift
 * warning. Null when nothing has fetched it. */
export const PullRequestHeadRequest = z.object({
  repoPath: RepoPath,
  pullRequest: PullRequest,
});
export type PullRequestHeadRequest = z.infer<typeof PullRequestHeadRequest>;
