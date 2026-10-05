import type { CommitSelection, CommitSha } from "../../../shared/git";
import type { GitHubDiffCheck, GitHubFailure } from "../../../shared/github-ipc";
import type { PullRequest } from "../../../shared/pull-request";
import { pullRequestUrl } from "../../../shared/pull-request";
import type { ReviewDiff, ReviewSide } from "../../../shared/review";
import { filesByAnchorPath, type PatchFile } from "../../../shared/diff/patch";
import { githubUncheckedReason } from "./github-failure-message";
import type { ReviewDrift } from "./review-drift";

// Where a comment lands on its pull request, and which diff on this machine may speak for the
// reviewed commit when its text and its link are built. (How the text's references are written
// is `shared/postable-comment.ts`'s, so main's poster (`main/github/posting.ts`) builds the identical body.)
// Everything here is pure string building over values the caller already has; the one async
// step — hashing a path, which the browser only offers as a promise — is `sha256Hex`, kept
// apart so the URL itself is built from a digest passed in and tested without awaiting
// anything. The card's "Copy & open on GitHub" (`components/CommentPostable.tsx`) is the edge
// that composes them.
//
// **The anchor, and how much of it was verified.** The Files view of a pull request is
// `https://github.com/<owner>/<repo>/pull/<n>/files`, and a line in it is the fragment
// `#diff-<hex sha256 of the file's path>R<line>` on the new side, `L<line>` on the old. That
// much was confirmed (2026-10-02) against the markup of the *classic* Files page, the one a
// logged-out visitor gets: the file's container is `<div id="diff-<sha>">` and its line cells
// are `diff-<sha>L1` / `diff-<sha>R10`; logged out, `/pull/<n>/changes` redirects to
// `/pull/<n>/files`. Three things were **not** confirmed:
//
//   - The *new* "Files changed" page, the default for logged-in users since 2026-01-22 (its
//     URL ends `/changes`, and a user can turn it off). Whether it honours this fragment needs
//     a logged-in browser, and nobody has looked. The link is built to `/files`, the address
//     the classic page answers to; if the new page ignores the fragment, the reader lands on
//     the right pull request's file list and has to find the line themselves.
//   - Ranges. `R40-R45` is inferred from GitHub's blob-view `#L40-L45` convention and from
//     the cell ids above; no range was seen in the Files page's own markup.
//   - Highlighting, as opposed to scrolling: that a fragment both scrolls to the line *and*
//     marks it was not observed on either page.
//
// So **the in-browser check is still owed**: open a real public pull request in the current
// UI, logged in, follow a link this module builds for a known path and line, and record here
// what it does. If the new page uses a different anchor, this is the one function to change.
//
// **Known limits, by design rather than by accident.**
//
//   - A multi-line comment still needs the reader to drag across the lines on GitHub before
//     pasting: the link can point at a range, it cannot select one for a comment.
//   - GitHub collapses large files behind "Load diff", and a link into one lands on the file's
//     header rather than the line.
//   - A line that is in *this* app's diff but outside GitHub's hunks opens the file and cannot
//     take a comment. The two diffs differ when the reader's `diff.algorithm` moves a hunk
//     boundary or a stale local base moves the merge base. B4 marks those comments: main places
//     each anchor against GitHub's own diff (`shared/diff/remote-diff.ts`, through
//     `github:check-diff`), the session holds the answer (`GitHubCheckState`), and the card reads
//     it through `outsideGitHubDiff` — a quiet note beside the button, not a refusal, because the
//     newer Files page lets a person comment on such a line by hand.
//
// **The path GitHub hashes** is the file's identity in its own diff: the new path, or the old
// one for a deletion — which is exactly `PatchFile.path`. A comment authored against a file's
// pre-rename name is resolved to that file first (`githubDiffPath`), because a digest of the
// old name would name no file on the page.
//
// **Which diff answers that — and the postable text's `absentAtHead`, which lives in
// `shared/postable-comment.ts` beside the rest of the rule — is the reviewed one** (`reviewedFilesFor`) — never simply the diff on screen. A refs review re-derives
// `base...<head now>`, and a narrowed one shows only the commits the reader picked, so the
// on-screen files can lack the commit that renamed or deleted a file the comment names. Where
// the screen cannot vouch for itself, both degrade: references leave inline, and the Files
// link hashes the path the comment was authored with. The residual risk is a comment authored
// against a file's *pre-rename* name in a review read narrowed or after its branch moved: its
// link then hashes the old name, which is on no file of the PR page, and the reader lands on
// the Files view without the jump — the right pull request, never a wrong line.
//
// **Head drift goes one step past the spec.** `next-features.md` defines "known to have moved"
// as `refs/rvw/pr/<n>` differing from `reviewedHead` (the ref is namespaced by owner and
// repository since, `pullRequestRef` says why). That ref exists only once Review Pull
// Request… has fetched the pull request into the review's repository; a review emitted from a
// branch the reader checked out by hand has none, and on its own the warning would never fire
// for it. The branch the review follows moving past `reviewedHead` (`lib/review-drift.ts`) is
// the nearest thing this machine knows then — a review emitted from a local branch of the PR
// moves when that branch is pulled — so `prHeadDrift` falls back to it when no PR ref is
// known, the ref outranks it once it is, and the tooltip says which of the two it is reporting.
//
// **And GitHub's own head joins them, once it has answered** (B4). The check against GitHub's
// diff reads the pull request's head from GitHub itself. Any known head of the pull request —
// GitHub's or the fetched ref — that differs from the reviewed commit is a move; the order
// (GitHub, then the ref, then the branch) only decides which the tooltip names, so one source
// can never vouch "same" over another that saw it move. The branch is consulted only when no
// head of the pull request is known. When GitHub was asked and could not answer (a private repository without a
// sign-in, a spent limit, no network), the local signals stand and the tooltip adds, quietly,
// that the comment was not checked against GitHub — nothing more alarming than that.

/** `R40` or `R40-R45` on the new side, `L…` on the old — the line half of a Files-view
 * fragment. A one-line span is written as one line, never `R40-R40`. */
export function diffLineFragment(side: ReviewSide, startLine: number, endLine: number): string {
  const letter = sideLetter(side);
  return startLine === endLine
    ? `${letter}${startLine}`
    : `${letter}${startLine}-${letter}${endLine}`;
}

/** GitHub's letter for a side: `R`ight is the new file, `L`eft the old. */
function sideLetter(side: ReviewSide): "R" | "L" {
  switch (side) {
    case "additions":
      return "R";
    case "deletions":
      return "L";
  }
}

/** The pull request's Files view with no line to land on — where the button goes when it has
 * no digest to anchor with. A value-returning switch on the host with no `default:`, so a
 * second host is a compile error here and in `githubFilesUrl`. */
export function githubFilesPageUrl(pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return `${pullRequestUrl(pr)}/files`;
  }
}

/** A comment's lines in the pull request's Files view. `pathDigest` is the lowercase hex
 * SHA-256 of the path `githubDiffPath` chose. */
export function githubFilesUrl(
  pr: PullRequest,
  pathDigest: string,
  lines: { side: ReviewSide; startLine: number; endLine: number },
): string {
  switch (pr.host) {
    case "github.com":
      return `${githubFilesPageUrl(pr)}#diff-${pathDigest}${diffLineFragment(lines.side, lines.startLine, lines.endLine)}`;
  }
}

/** What the session knows that decides whether its loaded diff is the reviewed one. */
export type ReviewedFilesInput = {
  /** The review's pin, or null once the reader navigated to a diff of their own. */
  reviewDiff: ReviewDiff | null;
  reviewSubrange: CommitSelection | null;
  reviewedHead: CommitSha | null;
  /** What the branch points at now — the newest commit of the loaded walk (`headShaOf`). */
  currentHead: CommitSha | null;
  /** The loaded diff's files, or null while it is not loaded. */
  files: readonly PatchFile[] | null;
};

/** The loaded diff's files when they *are* the diff at the reviewed commit, or null when the
 * screen cannot vouch for that — the input `postableReferencesFor` and `githubDiffPath` take.
 *
 * - A frozen pin renders the embedded patch, which is the diff the review was gated against,
 *   and it cannot be narrowed.
 * - A refs pin is the reviewed diff only whole (no `reviewSubrange`) and only while the branch
 *   still points at `reviewedHead`: past it, `base...head` carries commits the review never
 *   saw, and narrowed, it may lack the commit that renamed or deleted a file.
 * - No pin, nothing loaded, or no `reviewedHead` to compare with: null. */
export function reviewedFilesFor({
  reviewDiff,
  reviewSubrange,
  reviewedHead,
  currentHead,
  files,
}: ReviewedFilesInput): readonly PatchFile[] | null {
  if (reviewDiff === null || files === null) {
    return null;
  }
  switch (reviewDiff.kind) {
    case "frozenPatch":
      return files;
    case "refs":
      return reviewSubrange === null && reviewedHead !== null && currentHead === reviewedHead
        ? files
        : null;
  }
}

/** The path a comment's file goes by in the pull request's diff: the reviewed diff's own
 * `path` for it (new name, or old name for a deletion), reached through the same lookup that
 * seats a comment authored against a pre-rename name. Without the reviewed diff, or for a file
 * it does not carry, the name the comment was authored with — still the right pull request. */
export function githubDiffPath(anchorFile: string, files: readonly PatchFile[] | null): string {
  return (
    (files === null ? undefined : filesByAnchorPath(files).get(anchorFile)?.path) ?? anchorFile
  );
}

/** What GitHub said about a review's pull request when the session asked (B4) — derived state on
 * the session's slice, never persisted, null until it has answered (or for a review that is not
 * checked: no pull request, no `reviewedHead`, or no comment written for the author).
 *
 * - `checked`: GitHub answered. `check` says whether its head is the reviewed commit (`moved`),
 *   and if so which comments its diff does not carry (`compared`). `staleBecause` is set when a
 *   later re-check failed: the answer is kept — which comments GitHub's diff leaves out does not
 *   stop being true because one request was refused — but it is no longer *now*.
 * - `unchecked`: GitHub could not be asked or would not say, and never has this session; the
 *   local diff is trusted. */
export type GitHubCheckState =
  | { status: "checked"; check: GitHubDiffCheck; staleBecause: GitHubFailure | null }
  | { status: "unchecked"; failure: GitHubFailure };

/** The state after an answer to a check (`github:check-diff`): a fresh answer replaces whatever
 * was there; a failure keeps an earlier answer, marked stale, and only stands alone when there
 * was none. */
export function settleGitHubCheck(
  previous: GitHubCheckState | null,
  answer: { ok: true; value: GitHubDiffCheck } | { ok: false; failure: GitHubFailure },
): GitHubCheckState {
  if (answer.ok) {
    return { status: "checked", check: answer.value, staleBecause: null };
  }
  return previous?.status === "checked"
    ? { ...previous, staleBecause: answer.failure }
    : { status: "unchecked", failure: answer.failure };
}

/** Whether GitHub's own diff, at the reviewed commit, leaves this comment's lines out — so GitHub
 * would not take it as a line comment there. False whenever that is not known; a stale answer
 * still counts, since the reviewed commit's diff is what it was about. */
export function outsideGitHubDiff(state: GitHubCheckState | null, commentId: string): boolean {
  return (
    state?.status === "checked" &&
    state.check.kind === "compared" &&
    state.check.outside.includes(commentId)
  );
}

/** The pull request's head as GitHub reported it, or null when GitHub has not said — or said so
 * before a re-check failed: a head is the one fact a stale answer must not vouch for, because the
 * re-check came after a fetch that may have seen it move, and the fetched ref (`prHead`) knows
 * that better. */
export function githubHeadOf(state: GitHubCheckState | null): CommitSha | null {
  return state?.status === "checked" && state.staleBecause === null ? state.check.head : null;
}

/** The quiet sentence the tooltip adds about GitHub's answer, if any: never asked successfully,
 * or asked once and not again. */
export type GitHubCheckNote =
  | { kind: "unchecked"; failure: GitHubFailure }
  | { kind: "stale"; failure: GitHubFailure };

export function githubCheckNote(state: GitHubCheckState | null): GitHubCheckNote | null {
  if (state === null) {
    return null;
  }
  switch (state.status) {
    case "unchecked":
      return { kind: "unchecked", failure: state.failure };
    case "checked":
      return state.staleBecause === null ? null : { kind: "stale", failure: state.staleBecause };
  }
}

/** The note beside "Copy & open on GitHub" on a comment GitHub's diff leaves out. */
export const OUTSIDE_GITHUB_DIFF_NOTE = "Not in GitHub's diff";

/** Its tooltip: what the note means, and what still works. */
export const OUTSIDE_GITHUB_DIFF_HINT =
  "GitHub's diff of this pull request doesn't include these lines, so the link may not land on them and GitHub may not take a line comment there. Expanding the file on GitHub can reach them, or post it as a comment on the file.";

/** Whether the pull request is known to have moved past the commit the review read — and so
 * whether a comment's line numbers may no longer be the lines GitHub shows.
 *
 * - `github`: GitHub's own head for the pull request (`GitHubCheckState`) differs from
 *   `reviewedHead`. Named first: it is what the Files view showed when GitHub was last asked.
 * - `prRef`: the head of the pull request as last fetched — the sha of its ref (`pullRequestRef`) —
 *   differs from `reviewedHead`. The direct answer on this machine, once something fetches that
 *   ref.
 * - `branch`: no fetched PR head, but the branch the review follows has commits past the
 *   reviewed one (`lib/review-drift.ts`) — the fallback the header argues for. */
export type PrHeadDrift =
  | { kind: "same" }
  | { kind: "moved"; known: "github" | "prRef" | "branch" };

export type PrHeadDriftInput = {
  reviewedHead: CommitSha | null;
  /** The pull request's head as GitHub reported it (`githubHeadOf`), or null when it has not. */
  githubHead: CommitSha | null;
  /** The sha the pull request's ref (`pullRequestRef`) resolves to in the review's checkout, or null when nothing has
   * fetched it — the session's `prHead`, which Review Pull Request…'s fetch is what moves. */
  prHead: CommitSha | null;
  /** `reviewDrift(…)` for the review's session — null when the branch has not moved. */
  branchDrift: ReviewDrift | null;
};

export function prHeadDrift({
  reviewedHead,
  githubHead,
  prHead,
  branchDrift,
}: PrHeadDriftInput): PrHeadDrift {
  if (reviewedHead === null) {
    // A review that predates the field has no commit to have moved from: say nothing rather
    // than warn about every comment.
    return { kind: "same" };
  }
  // Every head of the pull request itself that is known counts, and any one that differs is a
  // move: precedence only picks which of them the tooltip names, it never lets one head hide
  // another's difference. (A GitHub head remembered from before a fetch said "same" while the
  // ref that fetch had just written said "moved"; the warning has to fire.)
  if (githubHead !== null && githubHead !== reviewedHead) {
    return { kind: "moved", known: "github" };
  }
  if (prHead !== null && prHead !== reviewedHead) {
    return { kind: "moved", known: "prRef" };
  }
  if (githubHead !== null || prHead !== null) {
    // A head of the pull request is known and agrees. The branch is not consulted: it may carry
    // the reader's own local commits, and the pull request's head is what GitHub's Files view
    // shows.
    return { kind: "same" };
  }
  return branchDrift === null ? { kind: "same" } : { kind: "moved", known: "branch" };
}

/** The button's name, as the spec spells it. */
export const OPEN_ON_GITHUB_LABEL = "Copy & open on GitHub";

/** The tooltip on "Copy & open on GitHub": what it does, and — when the pull request is known
 * to have moved — that the line it opens at may no longer be the one the comment is about,
 * naming which signal said so: GitHub, the fetched PR head, or only the local branch. When
 * GitHub's answer is missing or out of date (`githubCheckNote`), a last quiet sentence says so,
 * and why. */
export function openOnGitHubHint(drift: PrHeadDrift, note: GitHubCheckNote | null = null): string {
  const tail = note === null ? "" : `. ${checkNoteSentence(note)}`;
  switch (drift.kind) {
    case "same":
      return `${OPEN_ON_GITHUB_LABEL}${tail}`;
    case "moved":
      return `${OPEN_ON_GITHUB_LABEL} — ${movedBecause(drift.known)}, so the pull request's lines may have shifted${tail}`;
  }
}

function checkNoteSentence(note: GitHubCheckNote): string {
  switch (note.kind) {
    case "unchecked":
      return `Not checked against GitHub's diff: ${githubUncheckedReason(note.failure)}`;
    case "stale":
      return `Checked against GitHub's diff earlier; checking again failed: ${githubUncheckedReason(note.failure)}`;
  }
}

function movedBecause(known: "github" | "prRef" | "branch"): string {
  switch (known) {
    case "github":
      return "the pull request on GitHub has moved past the reviewed commit";
    case "prRef":
      return "the pull request's head, as last fetched, has moved past the reviewed commit";
    case "branch":
      return "the local branch has moved past the reviewed commit (the pull request's own head is not known here)";
  }
}

/** Lowercase hex SHA-256 of `text`'s UTF-8 bytes — the digest GitHub keys a file in its diff
 * by. Async only because WebCrypto is: the browser offers no synchronous hash, and pulling a
 * hashing library into the renderer for one call would be a dependency to buy a `.then`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
