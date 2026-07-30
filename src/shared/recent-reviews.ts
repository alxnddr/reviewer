import * as z from "zod";
import { ReviewRef } from "./git";
import { ReviewProgressSummary } from "./review-progress";

// What the app can say about the reviews sitting in rvw's managed directory without opening
// any of them. The renderer never touches the filesystem, so main reads the directory, peeks
// inside each artifact, and answers with this — a list built for a picker, not the artifacts
// themselves.
//
// The shape is deliberately lossy. A row has to answer "is this the review I am looking for"
// at a glance — which change, which repo, how long ago — and nothing more; the comments and
// layers arrive when the file is actually opened, through the same guard every other open
// crosses. So this carries a summary and a path, and the path is the only thing that travels
// back.

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
 * existing `invalidContent` failure, which is the honest answer. */
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
