import * as z from "zod";
import { BranchName, CommitSelection, RepoInfo } from "./git";
import { Comment, ReviewDiff, ReviewLayer, ReviewOrigin } from "./review";

// The Session domain contract: main owns the persisted per-repo review
// state; the renderer holds a hydrated copy and writes back over IPC. Persisted
// data is attacker-writable JSON on disk, so every ref-bearing field reuses the
// git.ts schemas — a tampered value fails the same validation that guards spawns.
// Sessions are keyed by id, never by window (a tear-off stays open).

/** Assigned by main via crypto.randomUUID(); never renderer-chosen. */
export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;

/** Which selection mode the session's UI is in. */
export const SelectionMode = z.enum(["commits", "branches"]);
export type SelectionMode = z.infer<typeof SelectionMode>;

/** Where the session's diff comes from. Single-arm on purpose: the union is the
 * seam a `github` arm plugs into without reshaping persisted data. */
export const SessionSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), repo: RepoInfo }),
]);
export type SessionSource = z.infer<typeof SessionSource>;

/** Persisted inputs only — log, branches, and the patch are re-derived from git
 * on load so the diff reflects the repo now. Both modes' inputs persist side by
 * side and `mode` names the driver: switching modes must not lose the other
 * mode's picks across a restart. The commit selection anchors to SHAs,
 * never brush indices (indices drift when the repo gains commits). */
export const Session = z.object({
  id: SessionId,
  source: SessionSource,
  mode: SelectionMode,
  base: BranchName.nullable(),
  head: BranchName.nullable(),
  commitSelection: CommitSelection.nullable(),
  selectedFilePath: z.string().min(1).nullable(),
  scrollTop: z.number().finite().nonnegative(),
  // The imported review: comments carry app-assigned identity; layers keep
  // their authored array order (the app never re-sorts). Both default to
  // [] for a session with no review yet — modelled empty, never absent.
  comments: z.array(Comment),
  layers: z.array(ReviewLayer),
  // The review's pinned diff: drives the rendered diff to the one the
  // anchors were authored against, so comments place without a manual re-pick. A
  // review session keeps this pin for its whole life (the selector only narrows
  // within it via `reviewSubrange`); null for a plain repo session. `.default(null)`
  // lets an older v2 session (no key) parse strictly rather than fall to the
  // salvage tier — absence is a schema addition, not corruption.
  reviewDiff: ReviewDiff.nullable().default(null),
  // The subset of the review's `base..head` commits the reviewer narrowed to,
  // SHA-anchored so history growth cannot shift it. Null is the whole
  // review — its diff renders via `reviewDiff` (the pin), placing every anchor;
  // non-null re-derives the diff of just those commits. Only ever set on a review
  // session (a frozen review, whose diff can't be narrowed, never carries one).
  // `.default(null)` keeps a pre-scope session parsing strictly, like the pins above.
  reviewSubrange: CommitSelection.nullable().default(null),
  // The authored source + embedded patch this session was opened from (for
  // round-trip export), and the marker that this is a review session at all. Carries
  // the base/head a frozen `reviewDiff` drops, so the curated review always
  // re-serializes to its authored `source`. Null for a plain repo session.
  // `.default(null)` keeps an older session parsing strictly, like `reviewDiff`.
  reviewOrigin: ReviewOrigin.nullable().default(null),
});
export type Session = z.infer<typeof Session>;

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
