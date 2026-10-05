import * as z from "zod";
import { GitHubPostRecord } from "./github-posting";

// Where a reader got to, as something that survives the tab being closed.
//
// Progress is the one piece of review state nobody authored: the artifact says what the
// change *is*, and this says how much of it one person has been through — which files they
// have read, and which findings they have answered. It therefore lives nowhere near the
// artifact — `rvw emit` owns every byte of `~/.rvw/reviews`, and the app
// writing reader state into that directory would make two programs owners of one folder. It
// is app-owned, in userData, alongside the sessions store.
//
// Two scopes, both real, and they are not redundant:
//
//   *session*  — `ReadProgress` rides on the `Session` (see session.ts), so a reload or a
//                relaunch restores every open tab exactly as it was. This covers plain repo
//                sessions too, which have no artifact to key on.
//   *artifact* — the same shape, written to its own file keyed by the artifact's path, so
//                closing the tab and reopening the review later resumes rather than restarts,
//                and the start screen can show a ring without opening anything.
//
// The session copy is authoritative while a tab is open (it is what the reader is looking at);
// the artifact file is a mirror of it, and is only ever *read* when a review is opened fresh
// or when the start screen lists what is on disk.
//
// **One file per review, and nothing is ever read or written except on demand.** A format
// change should cost one review's progress, not everyone's, and the way to get that is not
// merely separate files — it is never touching a file you were not asked about. There is no
// startup sweep and no bulk migration: a record is read when its review is opened, written
// when its progress changes, and otherwise left alone, so a build that cannot understand an
// old record simply shows no progress for it and moves on.

/** What a reader decided about one finding, in the three words the fix prompt asks an
 * agent to report back (`PROMPT_RULES`, `lib/review-export.ts`). That alignment is the
 * whole design: the reader copies a prompt, the agent answers "addressed" / "skipped — why"
 * / "disagree — why" per `path:line`, and the reader marks each comment with the word they
 * were just handed. A fourth state, or a synonym of one of these, would break the round
 * trip at the only place it is a round trip.
 *
 * Reader-owned, never derived. The mechanical equivalent — Greptile marks a comment
 * `addressed` when a later commit touched the file — is already computed here as an
 * anchor's `outdated` status, and is shown *beside* a mark as a hint, never as one. Baz
 * decides its Accepted "not based on UI interaction"; this is the opposite choice, and it
 * follows from the same rule that keeps this file out of the artifact. */
export const CommentResolution = z.enum(["addressed", "skipped", "disagree"]);
export type CommentResolution = z.infer<typeof CommentResolution>;

/** The read marks as they persist: a JSON object rather than the `Map`/`Set` the app works
 * in, because this shape crosses IPC and lands in a JSON file. `lib/read-progress.ts` owns
 * the meaning of the values; this owns only the transport. */
export const ReadProgress = z.object({
  /** Read file path → the `fileSignature` of the content it was read at. A signature, not a
   * bare list, so a file that changed under a re-derived diff reads honestly unread again
   * without anything having to be cleared. */
  readFiles: z.record(z.string(), z.string()).default({}),
  /** Paths folded to a header band in the code view. Persisted with the marks because
   * marking folds, and restoring the marks without the folds would reopen every finished
   * file the reader had already put away. */
  collapsedFiles: z.array(z.string()).default([]),
  /** Whether the initial folds have already been seeded into `collapsedFiles` for this
   * review (`lib/initial-folds.ts`: lockfiles, generated output, and the layers an author
   * marked `skim`). Seeding happens once, on the first diff a session loads; this is the
   * bit that makes "once" true across a relaunch.
   *
   * It rides *here*, with the folds it is about, rather than on the session — which is
   * what makes it true across the other scope too. Close a review's tab and reopen the
   * artifact and the record brings back both the folds and the fact that they were seeded,
   * so a lockfile the reader deliberately opened does not fold itself again in a later
   * sitting. Deriving it instead ("nothing is folded yet, so seed") would do exactly that
   * to the reader who unfolds the one file the heuristic found.
   *
   * `.default(false)` — a session or record written before this key existed has not been
   * seeded, which is the honest answer: it gets its folds on the next diff load, once. */
  foldsSeeded: z.boolean().default(false),
  /** How many files the diff held when these marks were last touched — the denominator.
   * Cached rather than derived because the surfaces that want a *ratio* (a recents row, the
   * start screen) have no diff in hand and deriving one means shelling out to git for every
   * row. Stale if the range moved on underneath; opening the review recomputes honestly,
   * which is why nothing but a picker hint is ever rendered from it. */
  readTotal: z.number().int().nonnegative().default(0),
  /** `commentFingerprint` (shared/fingerprint.ts) → what the reader decided about that
   * finding. Keyed by the fingerprint rather than by the comment's `id`, because the id is
   * stamped fresh at every import and would key a mark to one sitting of one tab.
   *
   * It rides here with the read marks rather than on the artifact for the reason at the top
   * of this file, and because the two are the same kind of thing at two scales: a file the
   * reader has been through, and a finding they have answered. Both scopes then come for
   * free — `ReviewProgressFile` spreads this shape, so a mark persists into the session and
   * into the per-review record without a second channel.
   *
   * A record from a build that did not know the key reads as `{}` (the default), which is
   * exactly "nothing resolved". */
  resolvedComments: z.record(z.string(), CommentResolution).default({}),
});
export type ReadProgress = z.infer<typeof ReadProgress>;

export const NO_PROGRESS: ReadProgress = {
  readFiles: {},
  collapsedFiles: [],
  foldsSeeded: false,
  readTotal: 0,
  resolvedComments: {},
};

/** One artifact's progress, as it sits on disk.
 *
 * `version` is per record, so it is the only thing a future format has to break: an
 * unreadable or too-new record is read as "no progress here" and left untouched on disk —
 * never deleted, because the build that can read it may be the next one, and never rewritten
 * until the reader generates real progress to put in its place.
 *
 * `path` is the artifact it belongs to. The filename is derived from that path, so this is
 * strictly redundant — and worth every byte: it is what makes the directory greppable when
 * something is wrong, and what lets the orphan sweep name what it is dropping.
 *
 * `github` is what the reader posted from this review to its pull request as pending comments
 * (`shared/github-posting.ts`'s `GitHubPostRecord`, Layer C). It rides on the record and *not* on
 * `ReadProgress`, so it is not on the session either, and the reason is who writes it: main, after
 * each comment GitHub accepts, and nobody else. On the session it would come back on every
 * renderer write-back, a debounce behind, and could put an older record over a newer one; here
 * the session mirror carries it through untouched (`main/review/progress.ts`), the way the
 * settings store carries the keys other owners write — raw, so a value this build cannot read is
 * carried rather than dropped. Optional, and salvaged on its own: an unreadable value never costs
 * the read marks beside it. It is never overwritten either: main refuses to post while it cannot
 * read it (`recordUnreadable`), because the record is what keeps a comment from going out twice. */
export const ReviewProgressFile = z.object({
  version: z.literal(1),
  path: z.string().min(1),
  updated: z.iso.datetime(),
  ...ReadProgress.shape,
  github: GitHubPostRecord.optional().catch(undefined),
});
export type ReviewProgressFile = z.infer<typeof ReviewProgressFile>;

/** What a picker row shows: the ratio, and nothing else. Deliberately not the marks — a row
 * needs to answer "did I start this, and how far did I get", and shipping a few hundred file
 * paths per row to answer it would make listing the directory cost more than opening a
 * review. */
export const ReviewProgressSummary = z.object({
  read: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ReviewProgressSummary = z.infer<typeof ReviewProgressSummary>;

/** The summary a record reduces to. `read` is counted from the marks rather than stored
 * beside them, so the two can never disagree; only the denominator is cached. */
export function progressSummary(progress: ReadProgress): ReviewProgressSummary {
  return { read: Object.keys(progress.readFiles).length, total: progress.readTotal };
}

/** Whether a summary is worth drawing at all. A row for a review nobody has opened should
 * carry no glyph — a column of empty rings down a list of untouched reviews is noise that
 * makes the started ones harder to find, which is the same rule `ReadRing` follows. */
export function hasProgress(summary: ReviewProgressSummary): boolean {
  return summary.read > 0;
}
