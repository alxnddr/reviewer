import type { ReviewComment } from "./review";

// Identity for a comment *across* imports, which is the one thing `Comment.id` cannot be.
//
// `importReview` stamps a fresh uuid on every comment at every import, deliberately:
// identity is app-assigned, never authored (review.ts's header states it). That makes the
// uuid perfect inside a session and useless between two — reopen the review and every id
// is new, so nothing the reader does to a comment can be keyed to it. A fingerprint
// derived from what the comment *says* closes that gap without putting an id on the wire,
// which the artifact's "only decisions a reviewer actually made" rule forbids.
//
// This is the trade every interchange format already makes — SARIF's `partialFingerprints`,
// GitHub's `primaryLocationLineHash`, GitLab Code Quality's required `fingerprint` — and it
// is the reason a reader mark is *lost* rather than *moved* when a finding is re-anchored.

/** 32-bit FNV-1a over a content string. Lives here rather than beside its first caller
 * because two features now hash content for identity — the annotation `version` CodeView
 * reconciles on, and `commentFingerprint` below — and a second hashing idiom is a second
 * thing to keep byte-stable. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- FNV-1a folds fixed-width units and this loop is indexed by `input.length` (UTF-16 units); `codePointAt` would change every hash
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `>>> 0` is the uint32 coercion FNV-1a ends on; `Math.trunc` would leave the sign bit and return a negative
  return hash >>> 0;
}

/** What a fingerprint is taken over: the four anchor fields and the body. Structural
 * rather than `ReviewComment` itself, so the wire comment, the in-app `Comment` and a
 * hand-built test fixture all satisfy it — and so adding a field to `ReviewComment` never
 * silently widens what is hashed. */
export type FingerprintedComment = Pick<
  ReviewComment,
  "file" | "side" | "startLine" | "endLine" | "body"
>;

/** A stable key for "this finding", derived from the comment rather than authored on it.
 *
 * **What it hashes:** `file`, `side`, `startLine`, `endLine`, `body` — the authored anchor
 * and the claim. `body` goes last so a `|` inside it cannot shift a later field and make
 * two different comments collide.
 *
 * **What it deliberately leaves out:** `tag`, `severity` and `evidence`. Those are the
 * author's labels on the same finding; a re-labelled comment is not a new finding, and
 * hashing them would drop the reader's mark every time an author adjusts a pill. The
 * app-assigned `id` is out for the opposite reason — it is what this exists to replace.
 *
 * **What breaks it, and this is the property callers will be surprised by:** any edit to
 * the body, and any drift in the anchor, produce a different fingerprint. A comment the
 * reader marked resolved and then edits reads as unmarked; a re-emitted review whose
 * finding moved three lines down is a different finding here. That is the same trade
 * GitHub makes with `primaryLocationLineHash`, and it is the honest one: a mark silently
 * carried onto a changed claim is worse than a mark lost. Note that the *placed* line
 * never enters this — anchors are hashed as authored, so re-deriving the diff against a
 * moved file does not disturb a single fingerprint.
 *
 * **Not a React key and not a DOM id.** The uuid is identity inside the app; this is
 * identity across imports. Conflating them ends in a collision nobody expects — two
 * identical comments on the same lines are one fingerprint and two uuids, which is correct
 * for a reader mark and wrong for a list key.
 *
 * 32 bits, rendered as eight hex characters. A review holds tens of comments, not tens of
 * thousands, so the birthday odds of two findings colliding are a few in ten million —
 * far below the rate at which an anchor drifts and loses the mark honestly. */
export function commentFingerprint(comment: FingerprintedComment): string {
  const { file, side, startLine, endLine, body } = comment;
  return fnv1a(`${file}|${side}|${startLine}|${endLine}|${body}`).toString(16).padStart(8, "0");
}
