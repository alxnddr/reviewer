import * as z from "zod";
import { fnv1a } from "./fingerprint";
import { CommitSha } from "./git";
import { GitHubFailure } from "./github-ipc";
import { GitHubOwner, PullRequest } from "./pull-request";

// Layer C's wire and disk contracts (`next-features.md`, C1–C3): the reader's GitHub token as main
// describes it back, posting a review's comments to its pull request as *pending* review comments,
// and the record of what was posted. Main does every step (`main/github/posting.ts`); the renderer
// names a session and comment ids and draws what comes back.
//
// **The token goes one way.** `github:set-token` is the only message that carries it, renderer to
// main, once, from a password field that clears itself. Nothing defined here has a field a token
// could ride back in: a token is described by its kind, its login, the owner it covers and its
// expiry, all of which GitHub tells anyone who asks. `main/github/credentials.ts` holds it in a
// closure and nowhere else.
//
// **Posting names comments, never text.** `github:post-comments` carries comment ids and a digest
// of the postable text the reader was looking at — never a body. Main builds every body itself
// from the session it persists (`shared/postable-comment.ts`, the function Copy uses), so what is
// posted is what the app holds, not what a message claimed; the digest is how main proves the
// reader saw that same text (an edit still on its way through the write-back would otherwise post
// the words before it).
//
// **Never submit.** Nothing in this file, and nothing that reads it, can ask GitHub to submit,
// approve or request changes: a pending review becomes a review only when the reader presses
// Submit on GitHub. `main/github/never-submit.test.ts` holds that against the source.

// --- tokens (C1, C2) ---------------------------------------------------------------------

/** The two kinds of personal access token the app accepts (C1). A fine-grained token
 * (`github_pat_`) covers one resource owner's selected repositories with the permissions it was
 * made with; a classic one (`ghp_`) is accepted only when its single scope is `public_repo` —
 * every public repository, nothing private anywhere. */
export const GitHubTokenKind = z.enum(["fineGrained", "classic"]);
export type GitHubTokenKind = z.infer<typeof GitHubTokenKind>;

/** GitHub caps a token at 255 characters; the request takes no more, so a pasted paragraph is
 * refused by the schema before main reads it. */
export const TOKEN_MAX = 255;

/** A token as the reader pastes it, and which account or organisation it is for. `owner` is
 * asked because a fine-grained token's resource owner cannot be read back from GitHub; absent, it
 * is the token's own login. A classic `public_repo` token covers every owner and ignores it.
 *
 * The schema refuses on length and type only, and zod v4 does not copy the input into an issue,
 * so a refused request's error carries no part of the token (`credentials.test.ts` checks). */
export const GitHubSetTokenRequest = z.object({
  token: z.string().min(1).max(TOKEN_MAX),
  owner: GitHubOwner.optional(),
});
export type GitHubSetTokenRequest = z.infer<typeof GitHubSetTokenRequest>;

/** One token as main describes it, with no part of the token in it. `owner` is the account or
 * organisation it covers, or null for a classic `public_repo` token (every owner's public
 * repositories). `expiresAt` is what GitHub's `github-authentication-token-expiration` header
 * said, when it said anything — advisory: it is known to be unreliable for fine-grained tokens. */
export const GitHubTokenStatus = z.object({
  kind: GitHubTokenKind,
  login: GitHubOwner,
  owner: GitHubOwner.nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
export type GitHubTokenStatus = z.infer<typeof GitHubTokenStatus>;

/** Bounds the status list; one token per owner, and nobody reviews in thirty-two organisations. */
export const TOKENS_MAX = 32;

/** A command-line switch or environment variable, by name only (`remote-debugging-port`,
 * `SSLKEYLOGFILE`) — never its value. */
export const ExposingSwitch = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u)
  .max(64);

/** What `github:status` answers: the tokens main holds, and the switches this packaged app was
 * started with that would let another program read its window or its network traffic (`main/github/exposure.ts`) —
 * while there are any, adding a token and posting are refused (`debuggingEnabled`), and Settings
 * says which. */
export const GitHubStatus = z.object({
  tokens: z.array(GitHubTokenStatus).max(TOKENS_MAX),
  exposedBy: z.array(ExposingSwitch).max(32),
});
export type GitHubStatus = z.infer<typeof GitHubStatus>;

/** A classic token scope as `X-OAuth-Scopes` lists it (`public_repo`, `repo:status`,
 * `admin:org`). Only ever a name GitHub defines — never a value derived from the token. */
export const GitHubScopeName = z
  .string()
  .regex(/^[a-z][a-z0-9_:]*$/u)
  .max(64);

/** Why a pasted token was not accepted, before or after asking GitHub about it:
 *
 * - `malformed`: not a token at all — a character no GitHub token has, or far too short.
 * - `unsupportedKind`: a token GitHub issues, but not one the app takes: `oauth` (`gho_`, what
 *   `gh` and OAuth apps hold — as broad as the reader's whole account), `appUser` (`ghu_`),
 *   `installation` (`ghs_`), `refresh` (`ghr_`), or `unknown` (no prefix GitHub uses today,
 *   which includes a 40-character classic token from before 2021).
 * - `classicScopes`: a classic token whose scopes are not exactly `public_repo`; `scopes` names
 *   what it has, so the reader can see why (`repo` is every private repository).
 * - `classicScopesUnknown`: a classic token GitHub answered for without saying its scopes, so
 *   the app cannot tell how much it can do.
 *
 * Plus every `GitHubFailure` the check against `GET /user` can answer — `unauthorized` is a token
 * GitHub does not accept (mistyped, revoked or expired). */
export const GitHubTokenRefusal = z.discriminatedUnion("code", [
  z.object({ code: z.literal("malformed") }),
  z.object({
    code: z.literal("unsupportedKind"),
    kind: z.enum(["oauth", "appUser", "installation", "refresh", "unknown"]),
  }),
  z.object({ code: z.literal("classicScopes"), scopes: z.array(GitHubScopeName).max(64) }),
  z.object({ code: z.literal("classicScopesUnknown") }),
  z.object({ code: z.literal("debuggingEnabled") }),
  ...GitHubFailure.options,
]);
export type GitHubTokenRefusal = z.infer<typeof GitHubTokenRefusal>;

/** `github:set-token`'s answer: the token as described back (no part of it), or why not.
 * `clipboardCleared`, on both arms, says main found the very text it was handed on the clipboard
 * and emptied it — on receipt, whatever came of the token: a refused paste is a secret too, and
 * would otherwise sit there for the next program that reads it (`credentials.ts`). */
export const GitHubSetTokenResponse = z.discriminatedUnion("ok", [
  GitHubTokenStatus.extend({ ok: z.literal(true), clipboardCleared: z.boolean() }),
  z.object({ ok: z.literal(false), failure: GitHubTokenRefusal, clipboardCleared: z.boolean() }),
]);
export type GitHubSetTokenResponse = z.infer<typeof GitHubSetTokenResponse>;

/** Forget one token: the one for `owner`, or the classic one (`null`). */
export const GitHubForgetTokenRequest = z.object({ owner: GitHubOwner.nullable() });
export type GitHubForgetTokenRequest = z.infer<typeof GitHubForgetTokenRequest>;

// --- posting (C3) ------------------------------------------------------------------------

/** Why posting — or one comment of it — did not happen. `GitHubFailure`'s codes, plus:
 *
 * - `noToken`: main holds no token that covers the pull request's owner.
 * - `tokenExpired`: GitHub refused the token (401) after the expiry it reported has passed.
 * - `headMoved`: the pull request's head is not the reviewed commit. Nothing was posted; the
 *   renderer asks, and a confirmed re-request names `head` as accepted (`acceptHead`) — the
 *   comments then pin to the reviewed commit and GitHub shows them as outdated.
 * - `pendingReviewConflict`: the reader already has a pending review on this pull request that
 *   the app cannot add to — begun at another commit (its lines would land against the wrong
 *   diff), or more than one. Submit or discard it on GitHub first.
 * - `lineNotInDiff`: GitHub's diff at the reviewed commit does not carry the comment's lines in
 *   one hunk, so GitHub would not take it as a line comment (checked before posting, and what
 *   GitHub's own `thread: null` answer means).
 * - `notPullRequest`: the session is not a review of a pull request with a reviewed commit.
 * - `notPostable`: a comment with no text for the author, or no longer in the session.
 * - `changedSinceShown`: the postable text main holds is not the text the reader was shown — an
 *   edit not yet written back. Nothing was posted; asking again posts the current text.
 * - `alreadySubmitted`: the comment went out with a review the reader has since submitted.
 * - `notPending`: removing a draft that is not pending on GitHub.
 * - `noRecord`: the review was opened before the app kept per-review records; reopen its file.
 * - `recordUnreadable`: the review's progress record is on disk but this build cannot read it
 *   (damaged, or from a newer build). Nothing is posted: posting would have to write a record over
 *   one it cannot read, and the record is what keeps a comment from going out twice.
 * - `debuggingEnabled`: this packaged app was started with a switch that lets another program read
 *   its window or its traffic (`main/github/exposure.ts`); quit and open it normally.
 * - `pendingReviewFull`: the reader's pending review holds more comments than Reviewer reads back
 *   (a hundred), so it could not tell what is already there. Submit or trim it on GitHub first.
 * - `bodyTooLong`: the text, evidence included, is past GitHub's 65,536-character limit.
 * - `submittedMeanwhile`: the pending review was submitted on GitHub while Reviewer was adding to
 *   it; the comment GitHub took went out with it, and the batch stopped. */
export const GitHubPostFailure = z.discriminatedUnion("code", [
  ...GitHubFailure.options,
  z.object({ code: z.literal("noToken") }),
  z.object({ code: z.literal("tokenExpired") }),
  z.object({ code: z.literal("headMoved"), head: CommitSha }),
  z.object({ code: z.literal("pendingReviewConflict") }),
  z.object({ code: z.literal("lineNotInDiff") }),
  z.object({ code: z.literal("notPullRequest") }),
  z.object({ code: z.literal("notPostable") }),
  z.object({ code: z.literal("changedSinceShown") }),
  z.object({ code: z.literal("alreadySubmitted") }),
  z.object({ code: z.literal("notPending") }),
  z.object({ code: z.literal("noRecord") }),
  z.object({ code: z.literal("recordUnreadable") }),
  z.object({ code: z.literal("debuggingEnabled") }),
  z.object({ code: z.literal("pendingReviewFull") }),
  z.object({ code: z.literal("bodyTooLong") }),
  z.object({ code: z.literal("submittedMeanwhile") }),
]);
export type GitHubPostFailure = z.infer<typeof GitHubPostFailure>;

/** A digest of a comment's postable text, as the renderer showed it (`postableDigest`). */
export const PostableDigest = z.string().regex(/^[0-9a-f]{8}$/u);

/** The digest the post request carries for each comment: FNV-1a over the postable text, the
 * hash `fingerprint.ts` already keeps byte-stable. Not a security measure — the renderer is
 * trusted to say what it showed — but a check that main and the screen agree on the words. */
export function postableDigest(postable: string): string {
  return fnv1a(postable).toString(16).padStart(8, "0");
}

/** The most comments one request posts — and so the most one Post all sends
 * (`lib/github-posting.ts`'s `postAllBatch`). A review's worth; a bound on what main parses. */
export const POST_BATCH_MAX = 100;

/** GitHub's limit on a comment's text: its API refuses a longer body ("Body is too long (maximum
 * is 65536 characters)"). Counted here in UTF-16 units, which is never fewer than GitHub's
 * characters, so the check can only err towards refusing. */
export const POSTED_BODY_MAX = 65_536;

export const GitHubPostRequest = z.object({
  sessionId: z.uuid(),
  comments: z
    .array(z.object({ id: z.uuid(), postable: PostableDigest }))
    .min(1)
    .max(POST_BATCH_MAX),
  /** The pull request head the reader agreed to post over, after a `headMoved` answer. Only
   * that head: if it moved again in between, main asks again. */
  acceptHead: CommitSha.optional(),
});
export type GitHubPostRequest = z.infer<typeof GitHubPostRequest>;

/** Where a comment stands on GitHub, as far as the app knows: `pending` (a draft in the reader's
 * pending review, visible only to them) or `submitted` (the reader submitted that review on
 * GitHub). A comment with no entry is not posted. */
export const PostedCommentState = z.enum(["pending", "submitted"]);
export type PostedCommentState = z.infer<typeof PostedCommentState>;

/** One comment on GitHub: where it stands, and a digest of the postable text that went (null for
 * a record written without one), so the card can tell when the text on screen has been edited
 * since — GitHub still has the old words. */
export const PostedComment = z.object({
  state: PostedCommentState,
  postable: PostableDigest.nullable(),
});
export type PostedComment = z.infer<typeof PostedComment>;

/** The posted state of a session's comments, by comment id. `unverified` is why the states were
 * not checked against GitHub just now — no token, a failed request — and null when they were;
 * unverified states are the record's last word, still shown, and said to be so. */
export const GitHubPostedState = z.object({
  comments: z.record(z.uuid(), PostedComment),
  unverified: GitHubPostFailure.nullable(),
});
export type GitHubPostedState = z.infer<typeof GitHubPostedState>;

/** What happened to one comment of a post:
 *
 * - `posted`: now a draft in the reader's pending review.
 * - `alreadyPending`: it was already there — recorded, or found by its path, line and text after
 *   an answer that never arrived — so nothing was posted again.
 * - `failed`: not posted, and why.
 * - `skipped`: not tried; an earlier failure in the batch stopped it (no network, a refused
 *   token), and trying the rest would only fail the same way. `because` is that failure. */
export const GitHubPostOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("posted") }),
  z.object({ kind: z.literal("alreadyPending") }),
  z.object({ kind: z.literal("failed"), failure: GitHubPostFailure }),
  z.object({ kind: z.literal("skipped"), because: GitHubPostFailure }),
]);
export type GitHubPostOutcome = z.infer<typeof GitHubPostOutcome>;

/** A post's answer: each comment's outcome, the posted states after it, and — when the batch
 * stopped partway — what stopped it. */
export const GitHubPostResult = z.object({
  outcomes: z.record(z.uuid(), GitHubPostOutcome),
  state: GitHubPostedState,
  stoppedBy: GitHubPostFailure.nullable(),
});
export type GitHubPostResult = z.infer<typeof GitHubPostResult>;

/** Every posting answer: a value, or a failure that stopped it before any comment was tried. */
export function GitHubPostResultOf<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), failure: GitHubPostFailure }),
  ]);
}

export type GitHubPostAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; failure: GitHubPostFailure };

export const GitHubPostResponse = GitHubPostResultOf(GitHubPostResult);
export type GitHubPostResponse = GitHubPostAnswer<GitHubPostResult>;

/** The posted state of one session — re-checked against GitHub when there is something to check
 * and a token to check it with (C3 step 5). */
export const GitHubPostedRequest = z.object({ sessionId: z.uuid() });
export type GitHubPostedRequest = z.infer<typeof GitHubPostedRequest>;

export const GitHubPostedResponse = GitHubPostResultOf(GitHubPostedState);
export type GitHubPostedResponse = GitHubPostAnswer<GitHubPostedState>;

/** Remove one pending draft (C3 step 6). */
export const GitHubDeletePendingRequest = z.object({ sessionId: z.uuid(), commentId: z.uuid() });
export type GitHubDeletePendingRequest = z.infer<typeof GitHubDeletePendingRequest>;

export const GitHubDeletePendingResponse = GitHubPostResultOf(GitHubPostedState);
export type GitHubDeletePendingResponse = GitHubPostAnswer<GitHubPostedState>;

// --- the record (C3 step 4) --------------------------------------------------------------

/** A GitHub GraphQL node id (`PRR_kwDO…`, or a legacy base64 one). Opaque; held to a charset
 * and a length so a hand-edited record cannot put anything else into a query variable. */
export const GitHubNodeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_=+/-]+$/u);

/** One posted comment: the pending review it went into, the thread and comment GitHub made for
 * it (the thread is null for one found by its text after a lost answer — GitHub's comment does
 * not name its thread), whether that review is still pending or was submitted, and a digest of
 * the postable text that went. */
export const GitHubPostedRecordEntry = z.object({
  reviewId: GitHubNodeId,
  threadId: GitHubNodeId.nullable(),
  commentId: GitHubNodeId,
  state: PostedCommentState,
  /** `postableDigest` of the postable text that went. */
  postable: PostableDigest,
});
export type GitHubPostedRecordEntry = z.infer<typeof GitHubPostedRecordEntry>;

/** What was posted from one review, kept in its progress record (`shared/review-progress.ts`,
 * `main/review/progress.ts`) beside the read marks — reader state, never the artifact's.
 *
 * Keyed by `commentFingerprint`, like the resolution marks, because a comment's id is minted
 * fresh at every import and the record has to survive closing and reopening the review. The
 * fingerprint leaves `postable` out, so editing the text after posting keeps the record; editing
 * the *finding* does not (`fingerprint.ts` says why) — and then the content match in
 * `main/github/posting.ts` is what still stops a second copy.
 *
 * `pullRequest` and `reviewedHead` say what the record is about: a record left from another pull
 * request or another reviewed commit is not this review's and is ignored, not merged. Only main
 * writes it; the session write-back carries it through untouched. */
export const GitHubPostRecord = z.object({
  pullRequest: PullRequest,
  reviewedHead: CommitSha,
  comments: z.record(z.string().regex(/^[0-9a-f]{8}$/u), GitHubPostedRecordEntry),
});
export type GitHubPostRecord = z.infer<typeof GitHubPostRecord>;
