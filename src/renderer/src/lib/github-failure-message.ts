import { assertNever } from "../../../shared/assert";
import type { GitHubFailure } from "../../../shared/github-ipc";
import type { GitHubPostFailure, GitHubTokenRefusal } from "../../../shared/github-posting";

// The sentences for what GitHub's API answered instead of a value, composed here from the codes
// main sends (`shared/github-ipc.ts`) — the rule every failure in the app follows
// (`lib/git-failure-message.ts`). Two registers, each a closed switch, so a code Layer C adds (an
// expired token, a line outside the diff) is a compile error in both until it is said:
//
//   - `githubFailureMessage`: a whole sentence, for a surface whose job was the answer — the
//     inbox. It says what happened and what the reader can do.
//   - `githubUncheckedReason`: a clause, for a surface where GitHub's answer was a refinement the
//     app does without — the base prefill, the drift tooltip. It says why, quietly, and never
//     reads as an error, because the local answer is still there.
//
// And two for Layer C, each its own closed switch over its own union, because the same code
// means something else once the reader's token asked: `notFound` with a token is a repository
// the token was not granted, not one hidden from a stranger.
//
//   - `githubPostFailureMessage`: why posting, or removing a draft, did not happen — and, for an
//     answer that never arrived, that posting again cannot make a second copy.
//   - `tokenRefusalMessage`: why a pasted token was not accepted. Never quotes the token.
//
// **Nothing here says a pull request does not exist.** An unauthenticated call sees a private
// repository as `notFound`, and so does a token that was not granted it, so that code always
// names both readings — and says nothing about a sign-in, since the ask may have used a token.

type RateLimited = Extract<GitHubFailure, { code: "rateLimited" }>;

/** Whose limit is spent, said so the reader knows what it is about: the limit for asking
 * without a sign-in, which GitHub counts per network address, or the reader's own token's. A
 * closed switch on the scope — "without a sign-in" would be false for a token. */
function spentLimit(failure: RateLimited): string {
  switch (failure.scope) {
    case "anonymous":
      return "GitHub's limit for requests without a sign-in is used up on this network";
    case "token":
      return "GitHub's limit for your token is used up";
  }
}

/** A reset as the reader's wall-clock time, `14:32` — what they compare with a clock. */
export function resetTime(resetAt: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(resetAt),
  );
}

export function githubFailureMessage(failure: GitHubFailure): string {
  switch (failure.code) {
    case "rateLimited":
      return `${spentLimit(failure)}. It resets at ${resetTime(failure.resetAt)}.`;
    case "notFound":
      return "GitHub showed Reviewer nothing at that address — it may be private, renamed or deleted.";
    case "unauthorized":
      return "GitHub refused the request as unauthorized.";
    case "forbidden":
      return "GitHub refused the request.";
    case "unprocessable":
      return "GitHub could not run that request as asked.";
    case "tooLarge":
      return "GitHub's answer was too large to read.";
    case "unavailable":
      return `GitHub is having trouble (it answered ${failure.status}). Try again in a little while.`;
    case "timeout":
      return "GitHub did not answer in time. Try again.";
    case "network":
      return "GitHub could not be reached. Check the network connection and try again.";
    case "badResponse":
      return "GitHub answered with something Reviewer does not understand.";
    case "unexpected":
      return "Asking GitHub failed unexpectedly. Try again; if it keeps failing, quit and reopen Reviewer.";
    default:
      return assertNever(failure);
  }
}

/** Why GitHub's answer is missing, as the tail of a quiet note: "…: <reason>". */
export function githubUncheckedReason(failure: GitHubFailure): string {
  switch (failure.code) {
    case "rateLimited":
      return `${spentLimit(failure)} until ${resetTime(failure.resetAt)}`;
    case "notFound":
      return "GitHub did not show it to Reviewer — it may be private, renamed or deleted";
    case "unauthorized":
    case "forbidden":
      return "GitHub refused the request";
    case "unprocessable":
    case "badResponse":
      return "GitHub's answer was not one Reviewer understands";
    case "tooLarge":
      return "GitHub's diff of it is too large";
    case "unavailable":
      return "GitHub is having trouble";
    case "timeout":
      return "GitHub did not answer in time";
    case "network":
      return "GitHub could not be reached";
    case "unexpected":
      return "asking GitHub failed unexpectedly";
    default:
      return assertNever(failure);
  }
}

/** The inbox's sentence: the one place a 422 has a known meaning — the search names a user GitHub
 * does not have — so it says that, naming the login from Settings; everything else is the general
 * sentence. */
export function inboxFailureMessage(failure: GitHubFailure, login: string): string {
  return failure.code === "unprocessable"
    ? `GitHub has no user named ${login}. Check the GitHub username in Settings.`
    : githubFailureMessage(failure);
}

/** Said for `debuggingEnabled` wherever it comes up. */
const DEBUGGING_SENTENCE =
  "Reviewer was started with debugging or network-logging switches, which would let another program read this window or its traffic. Tokens and posting are off until you quit Reviewer and open it normally.";

/** Why posting comments — or removing a pending draft — did not happen. The base codes take the
 * general sentence except where the reader's token changes what they mean. */
export function githubPostFailureMessage(failure: GitHubPostFailure): string {
  switch (failure.code) {
    case "noToken":
      return "Reviewer has no GitHub token for this pull request's owner. Add one in Settings ▸ GitHub.";
    case "tokenExpired":
      return "Your GitHub token has expired. Make a new one and paste it in Settings ▸ GitHub.";
    case "unauthorized":
      return "GitHub did not accept your token — it may have been revoked or expired. Paste a new one in Settings ▸ GitHub.";
    case "forbidden":
      return "GitHub refused. Your token may not cover this repository with Pull requests: Read and write, or the organization has not approved it yet. For a public repository of an organization you don't belong to, use a classic token with only public_repo.";
    case "notFound":
      return "GitHub has nothing there that your token can see — the token may not cover this repository, or the pull request was moved or deleted.";
    case "headMoved":
      return "The pull request has moved past the commit this review read.";
    case "pendingReviewConflict":
      return "You already have a pending review on this pull request that Reviewer cannot add to (started at another commit). Submit or discard it on GitHub, then post again.";
    case "lineNotInDiff":
      return "GitHub's diff does not carry these lines, so GitHub would not take this as a line comment. Copy it and comment by hand instead.";
    case "notPullRequest":
      return "This review does not name a pull request and the commit it read, so there is nowhere to post it.";
    case "notPostable":
      return "This comment has no text for the author to post.";
    case "changedSinceShown":
      return "The text was still being saved. Nothing was posted; post again.";
    case "alreadySubmitted":
      return "This comment went out with a review you already submitted.";
    case "notPending":
      return "This comment is not a pending draft on GitHub any more.";
    case "noRecord":
      return "This review was opened before Reviewer kept a record of what it posts. Close the tab and open the review file again, then post.";
    case "recordUnreadable":
      return "Reviewer cannot read this review's record of what it posted (damaged, or written by a newer Reviewer), so it posts nothing rather than risk posting twice.";
    case "debuggingEnabled":
      return DEBUGGING_SENTENCE;
    case "pendingReviewFull":
      return "Your pending review on GitHub holds more comments than Reviewer reads back, so it cannot tell what is already there. Submit it or remove some on GitHub, then post again.";
    case "bodyTooLong":
      return "This comment is longer than GitHub takes (65,536 characters, evidence included). Shorten it, or turn off copying evidence in Settings.";
    case "submittedMeanwhile":
      return "Your pending review was submitted on GitHub while Reviewer was adding to it. This comment went out with it; Reviewer stopped there.";
    case "timeout":
      return "GitHub did not answer in time. The comment may still have been posted; posting again will not post it twice.";
    case "network":
      return "GitHub could not be reached. If the comment got through, posting again will not post it twice.";
    case "unavailable":
      return `GitHub is having trouble (it answered ${failure.status}). Posting again will not post anything twice.`;
    case "rateLimited":
    case "unprocessable":
    case "tooLarge":
    case "badResponse":
    case "unexpected":
      return githubFailureMessage(failure);
    default:
      return assertNever(failure);
  }
}

/** Why a pasted token was not accepted. Names the kind or the scopes it found, never the token. */
export function tokenRefusalMessage(failure: GitHubTokenRefusal): string {
  switch (failure.code) {
    case "malformed":
      return "That is not a GitHub token. Paste the whole token, with nothing around it.";
    case "unsupportedKind":
      return unsupportedTokenMessage(failure.kind);
    case "classicScopes":
      return failure.scopes.length === 0
        ? "This classic token has no scopes, so it cannot comment. Give it public_repo — and only that."
        : `This classic token has ${failure.scopes.join(", ")}. Reviewer takes a classic token only when its one scope is public_repo; anything wider reaches more than posting comments needs.`;
    case "classicScopesUnknown":
      return "GitHub did not say what this classic token can do, so Reviewer cannot take it.";
    case "debuggingEnabled":
      return DEBUGGING_SENTENCE;
    case "unauthorized":
      return "GitHub did not accept this token — check it was copied whole, and that it has not expired or been revoked.";
    case "rateLimited":
    case "notFound":
    case "forbidden":
    case "unprocessable":
    case "tooLarge":
    case "unavailable":
    case "timeout":
    case "network":
    case "badResponse":
    case "unexpected":
      return githubFailureMessage(failure);
    default:
      return assertNever(failure);
  }
}

function unsupportedTokenMessage(
  kind: Extract<GitHubTokenRefusal, { code: "unsupportedKind" }>["kind"],
): string {
  switch (kind) {
    case "oauth":
      return "This is an OAuth token (gho_), the kind the gh CLI and OAuth apps hold. Its scopes cannot be narrowed, so it reaches far more than posting comments needs. Make a fine-grained token instead.";
    case "appUser":
    case "installation":
    case "refresh":
      return "This is a GitHub App token. Reviewer takes a fine-grained personal access token, or a classic one with only public_repo.";
    case "unknown":
      return "Reviewer does not recognise this kind of token. Make a fine-grained personal access token (it starts github_pat_).";
  }
}
