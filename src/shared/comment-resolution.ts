import type { Comment } from "./review";
import type { CommentResolution } from "./review-progress";
import { commentFingerprint } from "./fingerprint";

// What the reader decided about each finding, as the app works with it.
//
// Shared rather than renderer-side, unlike its sibling `lib/read-progress.ts`, for one
// reason: `diff/comment-annotations.ts` has to fold a comment's mark into the item `version`
// CodeView reconciles on, so the boundary crosses here. `resolutionOf` is then the single
// place a comment becomes a key, which is what stops the surface and the rail keying on
// two different things.
//
// Otherwise it follows that sibling's shape of argument exactly. There, the
// file is the only atom and a mark is made against the file's *content* (`fileSignature`),
// so a mark can never outlive the code it was made about. Here the finding is the atom and
// a mark is made against the comment's *claim* (`commentFingerprint`), for exactly the same
// reason: edit the body and the mark is gone, because the thing answered is no longer the
// thing on screen. Neither module stores a derived answer, and neither prunes on a miss.
//
// **The mark is the reader's and only the reader's.** Every shipping reviewer has the
// state and most of them guess at it — Greptile infers `addressed` from a later commit
// touching the file, Baz decides Accepted "not based on UI interaction". Reviewer already
// computes that mechanical signal as an anchor's `outdated` status and shows it beside a
// mark as a hint; nothing here is ever written by the app.
//
// The vocabulary is `CommentResolution` (shared/review-progress.ts) and is deliberately the
// three words the fix prompt asks an agent to report back, so the reader is transcribing an
// answer rather than translating one.

/** A comment's fingerprint → the reader's mark. A `Map` because that is what the app reads
 * it as; the record it persists to is the transport (`persistedSession`). */
export type CommentResolutions = ReadonlyMap<string, CommentResolution>;

/** The shared empty map: a stable reference, so a session where nothing is resolved hands
 * every selector and `useMemo` the same identity instead of a fresh `new Map()` per render —
 * the same contract `NO_READ_FILES` keeps. */
export const NO_RESOLUTIONS: CommentResolutions = new Map();

/** The mark on one comment, or null for one the reader has not answered. The single place
 * a comment is turned into its key, so no surface can key on anything else. */
export function resolutionOf(
  resolutions: CommentResolutions,
  comment: Comment,
): CommentResolution | null {
  return resolutions.get(commentFingerprint(comment)) ?? null;
}

export function isResolved(resolutions: CommentResolutions, comment: Comment): boolean {
  return resolutions.has(commentFingerprint(comment));
}

/** Set or clear one comment's mark, returning the SAME map when nothing changed so a no-op
 * gesture — re-picking the word already on the comment — costs no re-render and no disk
 * write downstream. `markFilesRead`'s contract, for the same reason. */
export function withResolution(
  resolutions: CommentResolutions,
  comment: Comment,
  resolution: CommentResolution | null,
): CommentResolutions {
  const key = commentFingerprint(comment);
  if (resolution === null) {
    if (!resolutions.has(key)) {
      return resolutions;
    }
    const next = new Map(resolutions);
    next.delete(key);
    return next;
  }
  if (resolutions.get(key) === resolution) {
    return resolutions;
  }
  return new Map(resolutions).set(key, resolution);
}

/** How much of a comment set is still open. `open` is what the rail counts down, so it is
 * derived from the marks rather than stored beside them — the same rule `progressSummary`
 * follows for files, and the reason the two numbers can never disagree. */
export type ResolutionTally = { open: number; total: number };

export function tallyResolutions(
  comments: readonly Comment[],
  resolutions: CommentResolutions,
): ResolutionTally {
  let open = 0;
  for (const comment of comments) {
    if (!isResolved(resolutions, comment)) {
      open += 1;
    }
  }
  return { open, total: comments.length };
}

/** Only the marks some comment in `comments` still answers to.
 *
 * Called once, at the persistence seam, and it is what keeps "editing a body drops the
 * mark" honest rather than merely invisible. Without it an edited or discarded comment
 * leaves its fingerprint in the record forever, and editing a body back to what it said
 * before would raise the old mark from the dead — a mark the reader would have no way to
 * know was still there. The other half of the same argument is why this is *not* applied on
 * read: a record is pruned against the comments it is being stored beside, never against
 * whatever happens to be loaded at the moment it is read.
 *
 * Answers the SAME map when every key is still live, which is the overwhelmingly common
 * case — the write-back fires on every scroll, and re-serializing an unchanged record would
 * defeat the progress store's own staleness check. */
export function pruneResolutions(
  resolutions: CommentResolutions,
  comments: readonly Comment[],
): CommentResolutions {
  if (resolutions.size === 0) {
    return resolutions;
  }
  const live = new Set(comments.map((comment) => commentFingerprint(comment)));
  const next = new Map<string, CommentResolution>();
  for (const [key, resolution] of resolutions) {
    if (live.has(key)) {
      next.set(key, resolution);
    }
  }
  return next.size === resolutions.size ? resolutions : next;
}
