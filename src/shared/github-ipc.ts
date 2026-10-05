import * as z from "zod";
import { BranchName, CommitSha } from "./git";
import { GitHubOwner, GitHubPullRequest, PullRequest } from "./pull-request";
import { ReviewSide } from "./review";

// The wire contracts for what main asks GitHub's API on the reader's behalf (`main/github/`):
// the pull requests waiting on the reader's review (`next-features.md`, B5), one pull request's
// title, state and base (B3's prefill), and whether GitHub's own diff of a pull request carries
// each comment's lines (B4). Each is asked anonymously unless the reader gave main a token for the
// pull request's owner (Layer C, `shared/github-posting.ts`), which reaches private repositories
// and a higher limit; nothing here changes shape for it except `rateLimited.scope`.
//
// **The renderer never talks to GitHub.** It names a login or a pull request, main builds the
// URL against an allowlist of exactly `https://api.github.com`, and what crosses back is the
// parsed answer or a code. No response here carries a header, a GitHub error text or a URL
// GitHub chose — which is also what keeps a credential out of every one of them once there is
// one (`main/github/client.ts` states the rule).

/** Why a question to GitHub got no usable answer. Codes, with the sentences composed in the
 * renderer (`lib/github-failure-message.ts`, closed by `assertNever`), so Layer C's posting
 * failures — an expired token, a line outside the diff — are new arms there and here, and a
 * compile error at every place that has to say something about them.
 *
 * - `rateLimited`: the limit `scope` counts against is spent. `resetAt` is when it refills, in
 *   epoch milliseconds on *this* machine's clock — GitHub's `x-ratelimit-reset` (or
 *   `retry-after`, for a secondary limit) translated through its `Date` header and clamped to an
 *   hour (`main/github/client.ts`'s `resetAtFrom`). `scope` is which kind of limit it is:
 *   `anonymous` (per network address) or `token` (the reader's own token, Layer C); a closed
 *   switch in the renderer gives each its own sentence — "without a sign-in" is wrong for a
 *   token. Never *which* token: the wire carries the kind, main keeps the key. Main also stops
 *   asking until then, so a Refresh pressed in the meantime costs nothing.
 * - `notFound`: no such repository or pull request *visible to whoever asked* — which is what a
 *   private repository looks like to an unauthenticated call, and to a token not granted it, so
 *   the copy never claims the pull request does not exist.
 * - `unauthorized` / `forbidden`: 401 / a 403 that is not a rate limit.
 * - `unprocessable`: 422 — the search names a user GitHub does not know.
 * - `tooLarge`: past the response cap main reads up to, or GitHub's own "diff too large" (406).
 * - `unavailable`: GitHub answered 5xx.
 * - `timeout` / `network`: no answer in time / no answer at all (offline, DNS, TLS, a proxy).
 * - `badResponse`: an answer that is not what the API documents — an unexpected status, a
 *   redirect off the allowlist, or (with `status: null`) a body that is not the documented
 *   type or does not parse against its schema.
 * - `unexpected`: not GitHub's doing — a throw in main, or the IPC call itself failing in the
 *   renderer. Logged where it happened; the reader is told it failed and to try again. */
export const GitHubFailure = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("rateLimited"),
    resetAt: z.int().nonnegative(),
    scope: z.enum(["anonymous", "token"]),
  }),
  z.object({ code: z.literal("notFound") }),
  z.object({ code: z.literal("unauthorized") }),
  z.object({ code: z.literal("forbidden") }),
  z.object({ code: z.literal("unprocessable") }),
  z.object({ code: z.literal("tooLarge") }),
  z.object({ code: z.literal("unavailable"), status: z.int() }),
  z.object({ code: z.literal("timeout") }),
  z.object({ code: z.literal("network") }),
  z.object({ code: z.literal("badResponse"), status: z.int().nullable() }),
  z.object({ code: z.literal("unexpected") }),
]);
export type GitHubFailure = z.infer<typeof GitHubFailure>;

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; failure: GitHubFailure };

/** Every answer of these channels: the value, or a typed failure — never a rejected promise. */
export function GitHubResultOf<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), failure: GitHubFailure }),
  ]);
}

/** A title as the dialog shows it. GitHub caps a pull request's title at 256 characters; the
 * wire takes four times that so a longer one is truncated in main (`main/github/rest.ts`)
 * rather than failing the whole answer here. */
export const TITLE_MAX = 1024;

// --- B5: the inbox -------------------------------------------------------------------------

/** The inbox's request: the login the reader typed into Settings. Validated again here — main
 * writes it into a search query, and the schema's charset (letters, digits, `-`, `_`) is what
 * makes it one token there that cannot add a qualifier of its own. */
export const GitHubInboxRequest = z.object({ login: GitHubOwner });
export type GitHubInboxRequest = z.infer<typeof GitHubInboxRequest>;

/** One open pull request that requests the reader's review. `pullRequest` is read back out of
 * the result's own address with the parser a paste goes through (`parsePullRequestArg`), so a
 * row picked from the list and a pasted URL are the same value. `author` is a display string,
 * not a `GitHubOwner`: an app's login (`dependabot[bot]`) is outside the user charset. */
export const GitHubInboxItem = z.object({
  pullRequest: GitHubPullRequest,
  title: z.string().max(TITLE_MAX),
  author: z.string().max(128).nullable(),
  /** GitHub's `updated_at`. */
  updatedAt: z.iso.datetime(),
  draft: z.boolean(),
});
export type GitHubInboxItem = z.infer<typeof GitHubInboxItem>;

/** The search's answer: newest first, at most one page. `total` is GitHub's count of matches,
 * which can exceed the rows; `incomplete` is GitHub saying the search timed out on its side and
 * the rows may be missing some. */
export const GitHubInbox = z.object({
  items: z.array(GitHubInboxItem),
  total: z.int().nonnegative(),
  incomplete: z.boolean(),
});
export type GitHubInbox = z.infer<typeof GitHubInbox>;

export const GitHubInboxResponse = GitHubResultOf(GitHubInbox);
export type GitHubInboxResponse = GitHubResult<GitHubInbox>;

// --- B3's prefill: one pull request ---------------------------------------------------------

export const GitHubPullRequestRequest = z.object({ pullRequest: PullRequest });
export type GitHubPullRequestRequest = z.infer<typeof GitHubPullRequestRequest>;

/** A pull request as the API describes it, cut to what the app uses. `state` folds GitHub's
 * `state` and `merged` into the three a person tells apart; a closed or merged pull request is
 * still reviewable, and the dialog only says which it is. `base` is null when GitHub's branch
 * name is not one this app's git would accept as a branch (`BranchName`) — then the dialog keeps
 * the local guess rather than prefilling a name the fetch would refuse. */
export const GitHubPullRequestInfo = z.object({
  title: z.string().max(TITLE_MAX),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  base: BranchName.nullable(),
  head: CommitSha,
});
export type GitHubPullRequestInfo = z.infer<typeof GitHubPullRequestInfo>;

export const GitHubPullRequestResponse = GitHubResultOf(GitHubPullRequestInfo);
export type GitHubPullRequestResponse = GitHubResult<GitHubPullRequestInfo>;

// --- B4: GitHub's diff against the review's anchors -----------------------------------------

/** The most anchors one check carries — far past any review a person reads, and a bound on
 * what main parses off the wire. */
export const DIFF_CHECK_MAX_ANCHORS = 5000;

/** A comment's anchor, named by the comment's id so the answer can say which comments it is
 * about. The anchor's own fields, with `ReviewAnchor`'s bounds — the anchors come from comments
 * that already passed it, so a looser bound here would only be a second rule to keep in step. */
export const DiffCheckAnchor = z.object({
  id: z.string().min(1).max(64),
  file: z.string().min(1),
  side: ReviewSide,
  startLine: z.int().positive(),
  endLine: z.int().positive(),
});
export type DiffCheckAnchor = z.infer<typeof DiffCheckAnchor>;

/** Check a review's anchors against GitHub's diff of its pull request — only meaningful at the
 * commit the review read, so `reviewedHead` is required: a review that predates the field is
 * never checked. */
export const GitHubDiffCheckRequest = z.object({
  pullRequest: PullRequest,
  reviewedHead: CommitSha,
  anchors: z.array(DiffCheckAnchor).max(DIFF_CHECK_MAX_ANCHORS),
  /** Read the pull request's head from GitHub now, not from main's minute-long memo — for the
   * check right after a fetch, when a remembered head would hide that it moved. */
  fresh: z.boolean().optional(),
});
export type GitHubDiffCheckRequest = z.infer<typeof GitHubDiffCheckRequest>;

/** What the check found:
 *
 * - `moved`: GitHub's head of the pull request is not `reviewedHead`. Nothing was compared —
 *   GitHub's diff at another commit says nothing about the reviewed lines — and the head is the
 *   strongest drift signal the app has (`lib/github-links.ts`'s `prHeadDrift`).
 * - `compared`: the heads agree, and `outside` names the anchors GitHub's diff does not carry
 *   in one hunk — the comments GitHub would not take as a line comment (`shared/diff/
 *   remote-diff.ts` decides it). */
export const GitHubDiffCheck = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("moved"), head: CommitSha }),
  z.object({
    kind: z.literal("compared"),
    head: CommitSha,
    outside: z.array(z.string().max(64)).max(DIFF_CHECK_MAX_ANCHORS),
  }),
]);
export type GitHubDiffCheck = z.infer<typeof GitHubDiffCheck>;

export const GitHubDiffCheckResponse = GitHubResultOf(GitHubDiffCheck);
export type GitHubDiffCheckResponse = GitHubResult<GitHubDiffCheck>;
