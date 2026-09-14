import * as z from "zod";
import { BranchName, CommitSelection, RepoInfo } from "./git";
import { Comment, ReviewDiff, ReviewLayer, ReviewOrigin, ReviewOverview } from "./review";
import { ReadProgress } from "./review-progress";

// The Session domain contract: main owns the persisted per-repo review
// state; the renderer holds a hydrated copy and writes back over IPC. Persisted
// data is attacker-writable JSON on disk, so every ref-bearing field reuses the
// git.ts schemas — a tampered value fails the same validation that guards spawns.
// Sessions are keyed by id, never by window (a tear-off stays open).

/** Assigned by main via crypto.randomUUID(); never renderer-chosen. */
export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;

/** Where the session's diff comes from. Single-arm on purpose: the union is the
 * seam a `github` arm plugs into without reshaping persisted data. */
export const SessionSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), repo: RepoInfo }),
]);
export type SessionSource = z.infer<typeof SessionSource>;

/** Persisted inputs only — log, branches, and the patch are re-derived from git on load
 * so the diff reflects the repo now.
 *
 * There is no mode: a session lists one branch's commits (`head`, or the checked-out
 * one when null) and, when `base` is set, lists only what `head` adds over it — the
 * same range a pull request shows. Which of those the diff renders follows from how
 * much of that list is brushed, so there is no second flag that could disagree with the
 * list on screen. The commit selection anchors to SHAs, never brush indices (indices
 * drift when the repo gains commits). */
export const Session = z.object({
  id: SessionId,
  source: SessionSource,
  // The branch whose commits the picker lists, or null for whichever is checked out —
  // the walk that also carries the working tree. Persisted, because the commit
  // selection anchors to SHAs: a session restored against the wrong log could not
  // re-locate the very range it was reviewing.
  head: BranchName.nullable(),
  // What to compare `head` against, or null to list its own history instead. Set, the
  // list holds exactly the commits `head` adds over `base`, and brushing narrows within
  // them. `.default(null)` lets a session written before this meaning parse strictly.
  base: BranchName.nullable().default(null),
  commitSelection: CommitSelection.nullable(),
  selectedFilePath: z.string().min(1).nullable(),
  scrollTop: z.number().finite().nonnegative(),
  // The imported review: comments carry app-assigned identity; layers keep
  // their authored array order (the app never re-sorts). Both default to
  // [] for a session with no review yet — modelled empty, never absent.
  comments: z.array(Comment),
  layers: z.array(ReviewLayer),
  // The authored tour doc the review opens on, carried like comments/layers so a
  // relaunch reopens on it and a round-trip export re-emits it. Null for a session
  // whose review has none (and for every plain repo session); `.default(null)` lets a
  // session written before the field parse strictly rather than fall to salvage.
  overview: ReviewOverview.nullable().default(null),
  // The review's pinned diff: drives the rendered diff to the one the
  // anchors were authored against, so comments place without a manual re-pick. The
  // selector only narrows within it (`reviewSubrange`); what moves it is this machine —
  // a frozen pin thaws to refs once the repo and refs are here (`repinSession`). Null for
  // a plain repo session. `.default(null)`
  // lets an older v2 session (no key) parse strictly rather than fall to the
  // salvage tier — absence is a schema addition, not corruption.
  reviewDiff: ReviewDiff.nullable().default(null),
  // The subset of the review's `base..head` commits the reviewer narrowed to,
  // SHA-anchored so history growth cannot shift it. Null is the whole
  // review — its diff renders via `reviewDiff` (the pin), placing every anchor;
  // non-null re-derives the diff of just those commits. Only ever set on a review
  // session (a frozen review, whose diff can't be narrowed, never carries one, and a
  // review that thaws starts without one — see `repinSession`).
  // `.default(null)` keeps a pre-scope session parsing strictly, like the pins above.
  reviewSubrange: CommitSelection.nullable().default(null),
  // The authored repo, refs, and embedded patch this session was opened from (for
  // round-trip export), and the marker that this is a review session at all. Carries
  // the base/head a frozen `reviewDiff` drops, so the curated review always
  // re-serializes to its authored range. Null for a plain repo session.
  // `.default(null)` keeps an older session parsing strictly, like `reviewDiff`.
  reviewOrigin: ReviewOrigin.nullable().default(null),
  // The `.reviewer.json` this session was opened from, resolved to an absolute real
  // path. Identity, not content: it is what makes "this review is already open" and
  // "this review's progress lives here" the same question with the same answer, so a
  // reader who closes a tab and reopens the artifact resumes where they stopped. Null
  // for a plain repo session and for a review opened before this field existed — both
  // simply keep no artifact-scoped progress, which is the old behaviour.
  reviewPath: z.string().min(1).nullable().default(null),
  ...ReadProgress.shape,
});
export type Session = z.infer<typeof Session>;

/** A review session re-seated on a new pin — the one way `source.repo`, `reviewDiff` and
 * `reviewSubrange` change after open, shared by the launch re-pin and Locate Repository… so the
 * two cannot disagree about what a thaw resets. Answers `session` itself when nothing moved, so a
 * caller can skip the write.
 *
 * A subrange survives only a move that keeps the pin's kind: its SHAs are commits of the same
 * authored refs, so a relocated live review can still stand on them — but a frozen review never
 * carries one, and a review that thaws starts on its whole diff. */
export function repinSession(
  session: Session,
  pin: { repo: RepoInfo; reviewDiff: ReviewDiff },
): Session {
  const sameKind = session.reviewDiff?.kind === pin.reviewDiff.kind;
  if (sameKind && session.source.repo.path === pin.repo.path) {
    return session;
  }
  return {
    ...session,
    source: { kind: "local", repo: pin.repo },
    reviewDiff: pin.reviewDiff,
    reviewSubrange: sameKind ? session.reviewSubrange : null,
  };
}

/** A renderer write-back laid over the stored session, keeping the pin as main has it. Only main
 * moves a review's pin (`repinSession`, from the launch re-pin and Locate Repository…); the
 * renderer's copy only ever carries back what it was handed. But a write-back is a debounce behind
 * at best, so one that left before a re-seat can land after it — and would put the old pin back,
 * stranding the review frozen until the next launch. So the pin is main's and main keeps it, while
 * everything else in the write-back is the reader's and wins. A plain repo session has no pin. */
export function withStoredPin(incoming: Session, stored: Session | undefined): Session {
  if (stored === undefined || stored.reviewOrigin === null) {
    return incoming;
  }
  return {
    ...incoming,
    source: stored.source,
    reviewDiff: stored.reviewDiff,
    // The subrange is the reader's, but a frozen pin can never carry one.
    reviewSubrange: stored.reviewDiff?.kind === "frozenPatch" ? null : incoming.reviewSubrange,
  };
}

/** What `sessions:list` answers with: the store's live state minus the on-disk
 * versioning concern. Reads always succeed — salvage happens at load, not here. */
export const SessionSnapshot = z.object({
  sessions: z.array(Session),
  activeSessionId: SessionId.nullable(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

/** The on-disk envelope. Version 2 carries the review fields; a v1 file
 * (sessions without `comments`/`layers`) migrates on load by defaulting both to
 * []. The version lives in the file, not electron-store's app-version
 * `migrations`, matching the settings.ts precedent (zod is the house contract
 * tool). */
export const SessionStoreFile = z.object({
  version: z.literal(2),
  sessions: z.array(Session),
  activeSessionId: SessionId.nullable(),
});
export type SessionStoreFile = z.infer<typeof SessionStoreFile>;

export const SessionCreateRequest = z.object({ source: SessionSource });
export type SessionCreateRequest = z.infer<typeof SessionCreateRequest>;

export const SessionIdRequest = z.object({ id: SessionId });
export type SessionIdRequest = z.infer<typeof SessionIdRequest>;

/** A dragged tab strip's new order, as the full id list. Sending the whole order
 * rather than a from/to pair keeps main's array a pure function of what the
 * renderer last showed, so a dropped or reordered-twice message can't leave the
 * two sides disagreeing about where a tab sits. */
export const SessionOrderRequest = z.object({ ids: z.array(SessionId) });
export type SessionOrderRequest = z.infer<typeof SessionOrderRequest>;
