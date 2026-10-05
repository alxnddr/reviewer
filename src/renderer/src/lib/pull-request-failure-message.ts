import { assertNever } from "../../../shared/assert";
import type { PullRequestParseFailure } from "../../../shared/pull-request";
import type { PullRequestFailure } from "../../../shared/pull-request-ipc";
import { gitFailureMessage } from "./git-failure-message";

// The sentences Review Pull Request… shows, composed here from the codes main answers with —
// the rule every failure in the app follows (`lib/git-failure-message.ts`,
// `lib/review-open-failure-message.ts`). Each says what happened and, where there is one, what
// to do next; none of them guesses at a cause the code does not carry.

/** Why a pasted text names no pull request the dialog can act on. `number` is the dialog's own
 * case on top of the shared parse's two: `rvw emit --pr 12` can complete a bare number from the
 * checkout it runs in, but the dialog has no checkout yet — finding one is what the pull
 * request's `owner/repo` is *for* — so a number alone is refused with the spellings that work. */
export type PullRequestInputProblem = PullRequestParseFailure | "number";

export function pullRequestInputMessage(problem: PullRequestInputProblem): string {
  switch (problem) {
    case "number":
      return "A number alone does not say which repository — paste the pull request's address, or owner/repo#123.";
    case "notGitHub":
      return "Only pull requests on github.com can be reviewed here.";
    case "unparseable":
      return "That is not a pull request's address. Paste one like https://github.com/owner/repo/pull/123, or owner/repo#123.";
    default:
      return assertNever(problem);
  }
}

export function pullRequestFailureMessage(failure: PullRequestFailure): string {
  switch (failure.code) {
    case "git":
      return gitFailureMessage(failure.failure);
    case "noMatchingRemote":
      return `${failure.repo} has no remote for this pull request's repository, so the pull request cannot be fetched into it. Locate a checkout cloned from that repository, or add it as a remote.`;
    case "prNotFound":
      return "The repository has no pull request with that number.";
    case "baseNotFound":
      return `The repository has no branch named ${failure.base} to compare against. Correct the base and try again.`;
    case "worktreeDirty":
      return worktreeDirtyMessage(failure.path, failure.reason);
    case "worktreeOnBranch":
      return `${failure.path} has been switched to the branch ${failure.branch}, so it was left on it rather than moved to the pull request's new head. Switch it back to a detached HEAD, or remove it — the branch is kept.`;
    case "worktreeLocked":
      return worktreeLockedMessage(failure.path, failure.checkout, failure.reason);
    case "worktreePathTaken":
      return `${failure.path} already exists and is not a worktree of this checkout, so nothing was written there. Move it aside and try again.`;
    case "worktreeOpen":
      return "A tab is reading this worktree. Close that review first, then remove it.";
    case "notAWorktree":
      return `${failure.path} is not a worktree git can still remove. If it is no longer needed, delete the folder by hand.`;
    case "cloneTargetExists":
      return `${failure.path} already exists. Pick another folder, or locate that checkout instead.`;
    case "cancelled":
      return "Cancelled.";
    default:
      return assertNever(failure);
  }
}

/** The two kinds of work a worktree can hold, told apart because what to do about each
 * differs: files are committed, stashed or discarded; commits need a branch to live on. */
function worktreeDirtyMessage(path: string, reason: "uncommitted" | "commits"): string {
  switch (reason) {
    case "uncommitted":
      return `${path} has uncommitted or untracked changes, so it was left exactly as it is. Commit, stash or discard them there, then try again.`;
    case "commits":
      return `${path} has commits that are not on any branch, so it was left exactly as it is. Put them on a branch there (git branch <name>) if they are worth keeping, then try again.`;
  }
}

/** A worktree git holds locked, told apart by the lock's reason. `initializing` is the lock
 * `worktree add` holds while it writes the tree, so one still held is a checkout that never
 * finished: its files may be truncated, and the way out is to remove it. Any other lock — or a
 * bare one — was put there by someone on purpose (`git worktree lock`, say for a worktree on a
 * removable drive), and nothing about it says the tree is incomplete, so it is not the app's to
 * suggest deleting: the sentence says how to unlock it, and stops. The commands name the real
 * paths, quoted, and run from the checkout with `-C`, so each pastes into a terminal as it is —
 * the worktrees live under `~/Library/Application Support`, whose space a bare path would split. */
function worktreeLockedMessage(path: string, checkout: string, reason: string): string {
  const git = `git -C ${shellWord(checkout)} worktree`;
  if (reason === "initializing") {
    return `git has ${path} locked because a checkout into it never finished, so it was left alone — its files may be incomplete. If nothing in it is yours, remove it with: ${git} unlock ${shellWord(path)} && ${git} remove --force ${shellWord(path)}. Then try again.`;
  }
  return `git has ${path} locked${reason === "" ? "" : ` (${reason})`}, so it was left alone. If it no longer needs to be, unlock it with: ${git} unlock ${shellWord(path)}. Then try again.`;
}

/** `word` as one POSIX shell word: single-quoted, with each `'` closed, escaped and reopened. */
function shellWord(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}
