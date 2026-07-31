import * as z from "zod";
import { GitFailure, ReviewRef } from "./git";
import { ReviewProgressSummary } from "./review-progress";
import { SessionId } from "./session";

// The wire contracts for the review channels: opening one, exporting one, and listing the ones
// already emitted. One file because they are one kind of thing — what the two sides say to each
// other *about* a review — and not what a review is: `review.ts` and `git.ts` are the domain
// schemas, and an envelope that reshapes without the domain changing (a new failure code, a new
// field on a picker row) has no business living next to them.
//
// Every failure here is typed rather than thrown: an fs error, a bad path, a malformed artifact
// all become a value the renderer can render, so a rejected promise never crosses the bridge.
//
// Kept apart from `review.ts` so an outcome can name a `SessionId` without `review.ts` importing
// `session.ts` (which imports `review.ts` in turn).

// Open — the three entry points (dialog, drop, CLI/`open-file`) all cross one main-side guard,
// and a file path, from a renderer drop or from argv, is untrusted until main has validated it.
// Every bad input lands in one of these typed failures rather than a throw across IPC.

/** Why a path could not become an open review. Ordered as the open path checks
 * them: extension → existence/kind → size → readability → content → the repo the
 * artifact names. Each is a distinct visible state, never a crash. */
export const ReviewOpenFailure = z.discriminatedUnion("code", [
  z.object({ code: z.literal("wrongExtension") }),
  z.object({ code: z.literal("fileNotFound") }),
  z.object({ code: z.literal("tooLarge") }),
  z.object({ code: z.literal("unreadable") }),
  /** The file was read and is not a review. `reason` is the first thing the schema objected
   * to (`importReview`), carried so the banner over a hand-edited artifact names the field
   * that is wrong instead of saying only that the file will not open — the same reason
   * `repoUnavailable` carries the git layer's own answer. Not the same class of leak as a
   * subprocess's stderr, which `GitFailure` deliberately drops: this sentence is about the
   * reader's own file, checked against the app's own schema. */
  z.object({ code: z.literal("invalidContent"), reason: z.string() }),
  /** The artifact parsed, but the repo *it* chose is not a git work tree this
   * machine can open. Carries the git layer's own reason so the banner can say
   * which path was refused instead of a generic "could not open". */
  z.object({ code: z.literal("repoUnavailable"), reason: GitFailure }),
]);
export type ReviewOpenFailure = z.infer<typeof ReviewOpenFailure>;

/** The success shape a dialog/drop invoke answers with: an opened review names
 * the session main created for it; `canceled` is the dialog's dismiss (drop and
 * CLI never cancel — they either open or fail).
 *
 * `created` false is the one-tab-per-artifact case: the review was already open, and this
 * names the session it is open in. A flag on the same arm rather than an arm of its own,
 * because every caller does the same thing with the id either way (go to that tab) and only
 * the feedback differs — a new tab announces itself by appearing, an existing one has to be
 * pointed at. */
export const ReviewOpenOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), sessionId: SessionId, created: z.boolean().default(true) }),
  z.object({ kind: z.literal("canceled") }),
]);
export type ReviewOpenOutcome = z.infer<typeof ReviewOpenOutcome>;

/** Response envelope for the dialog/drop channels: like `GitResultOf`, the
 * renderer always receives a discriminated result, never a rejected promise. */
export const ReviewOpenResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ReviewOpenOutcome }),
  z.object({ ok: z.literal(false), failure: ReviewOpenFailure }),
]);
export type ReviewOpenResponse = z.infer<typeof ReviewOpenResponse>;

/** The drop path's request: the renderer resolves a dropped File to its disk
 * path (preload `webUtils`) and hands it here. Untrusted — the main guard
 * normalizes and re-checks it before a single byte is read. */
export const ReviewOpenPathRequest = z.object({ path: z.string().min(1) });
export type ReviewOpenPathRequest = z.infer<typeof ReviewOpenPathRequest>;

// Save — the renderer serializes the curated review to a string (pure generators) and hands it
// here; main owns the native save sheet and the disk write, so no fs API and no file path is
// reachable from the sandboxed renderer. Every fs error is mapped to a typed failure — a raw
// error never crosses IPC, mirroring the git and open envelopes above.

/** A save request: the already-serialized artifact/markdown plus a suggested
 * filename. `defaultName` is only the sheet's pre-fill — the user picks the real
 * path — but it is renderer-supplied and untrusted, so it is constrained to a
 * bare filename (no path separators or NULs) rather than allowing a directory
 * traversal to preselect a location outside the picker's intent. */
export const ReviewSaveRequest = z.object({
  content: z.string(),
  defaultName: z
    .string()
    .min(1)
    .refine((name) => !name.includes("/") && !name.includes("\\") && !name.includes("\0"), {
      error: "Default filename must not contain a path separator",
    }),
});
export type ReviewSaveRequest = z.infer<typeof ReviewSaveRequest>;

/** The success shape: a written file names the chosen path; a dismissed sheet is
 * `canceled`, which writes nothing (not a failure). */
export const ReviewSaveOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), path: z.string() }),
  z.object({ kind: z.literal("canceled") }),
]);
export type ReviewSaveOutcome = z.infer<typeof ReviewSaveOutcome>;

/** Why a save could not complete. A single code today (any fs error maps here);
 * the union keeps the shape extensible without reshaping the wire, like GitFailure. */
export const ReviewSaveFailure = z.discriminatedUnion("code", [
  z.object({ code: z.literal("writeFailed") }),
]);
export type ReviewSaveFailure = z.infer<typeof ReviewSaveFailure>;

/** Response envelope: the renderer always receives a discriminated result, never a
 * rejected promise carrying a stringified fs error. */
export const ReviewSaveResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ReviewSaveOutcome }),
  z.object({ ok: z.literal(false), failure: ReviewSaveFailure }),
]);
export type ReviewSaveResponse = z.infer<typeof ReviewSaveResponse>;

// Recents — what the app can say about the reviews sitting in rvw's managed directory without
// opening any of them. The renderer never touches the filesystem, so main reads the directory, peeks
// inside each artifact, and answers with this — a list built for a picker, not the artifacts
// themselves.
//
// The shape is deliberately lossy. A row has to answer "is this the review I am looking for"
// at a glance — which change, which repo, how long ago — and nothing more; the comments and
// layers arrive when the file is actually opened, through the same guard every other open
// crosses. So this carries a summary and a path, and the path is the only thing that travels
// back.
//
// It is also the one review channel that answers plainly rather than in an `ok`/`failure`
// envelope: "the directory would not open" is a field on the answer, because a picker with no
// rows still has a directory to name.

/** What an artifact says about itself, when it could be read at all. Everything here is
 * derived from the file's own content, so a row can name the change rather than the filename
 * `rvw emit` happened to slug for it.
 *
 * `title` is the overview's, absent on an artifact that carries no tour doc — most rows have
 * one, and the ones that do not fall back to their range, which is always there. `portable`
 * says the diff rides inside the file: the one fact about a *stale* row that changes what
 * happens on click, since a refs-only artifact whose repo has moved will not open. */
export const RecentReviewSummary = z.object({
  repoPath: z.string(),
  repoName: z.string(),
  base: ReviewRef,
  head: ReviewRef,
  title: z.string().nullable(),
  comments: z.number().int().nonnegative(),
  layers: z.number().int().nonnegative(),
  portable: z.boolean(),
});
export type RecentReviewSummary = z.infer<typeof RecentReviewSummary>;

/** One row. `summary` is null for a file that is named like an artifact and is not one — a
 * half-written emit, something hand-edited into invalid JSON, a stray rename. Those are listed
 * rather than hidden: a reader who knows they emitted a review and cannot find it in this list
 * is worse off than one who sees it here and is told it will not open. Clicking it lands in the
 * existing `invalidContent` failure, which is the honest answer — and now says which part of
 * the file it choked on. */
export const RecentReview = z.object({
  path: z.string().min(1),
  /** Filesystem mtime, ISO. The list's sort key and the only date on the row: an artifact
   * carries no authored timestamp, and inventing one from the filename's stamp would be
   * reading an implementation detail of `reviewFileName` back out of a string. */
  modified: z.iso.datetime(),
  summary: RecentReviewSummary.nullable(),
  /** How far through this review its reader got, from the app's own progress store — the
   * only thing on a row that is not derived from the artifact, because it is the only thing
   * the artifact does not know. Null for a review nobody has started, which is most of them
   * and draws nothing.
   *
   * A *cached* ratio: the denominator was the file count of the diff the last time marks were
   * made, and a refs-only review whose branch moved since will have a different one. Listing
   * the directory cannot afford to re-derive a diff per row to find out, so the row shows the
   * last honest answer and opening the review recomputes. That is also why a row renders the
   * counts and never a bare percentage — "12/30" invites the reading "as of when I last read
   * it" in a way "40%" does not. */
  progress: ReviewProgressSummary.nullable().default(null),
});
export type RecentReview = z.infer<typeof RecentReview>;

/** The whole answer. `dir` rides along so the lists can name the place it looked —
 * "nothing here" is a much better sentence when it says where "here" is, and the directory is
 * a thing a reader can go and look at.
 *
 * `truncated` is how many artifacts were left off the end of an over-long list. Reporting it is
 * the same rule the CLI follows about silently capping anything: a list that quietly stops at
 * N reads as "that is all of them".
 *
 * `unreadable` distinguishes "the directory is not there / is empty" from "the directory is
 * there and would not open". Both produce no rows, and only one of them is the reader's
 * problem to know about — a permissions failure reported as "no reviews yet" is a lie that
 * sends them off to re-run an emit that already worked. */
export const RecentReviewsResponse = z.object({
  dir: z.string().min(1),
  reviews: z.array(RecentReview),
  truncated: z.number().int().nonnegative(),
  unreadable: z.boolean(),
});
export type RecentReviewsResponse = z.infer<typeof RecentReviewsResponse>;
