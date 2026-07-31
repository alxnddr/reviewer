import type { BranchName, CommitSelection, DiffSelection, RepoInfo } from "../../../../shared/git";
import type {
  Comment,
  ReviewDiff,
  ReviewLayer,
  ReviewOrigin,
  ReviewOverview,
} from "../../../../shared/review";
import type { SessionId } from "../../../../shared/session";
import { NO_FILES, soloedDiff, type SoloedDiff } from "../../lib/soloed-diff";
import type { ReadFiles } from "../../lib/read-progress";
import type { BrushRange } from "../../lib/selection";
import type { BranchesState, DiffState, LogState } from "../../lib/load-state";
import type { ReviewState } from "./state";

// The shape every action in this directory is about, and the two combinators every one of
// them goes through to reach it. Nothing here is a zustand slice: it is what the slices in
// the sibling modules share, so none of them has to import another.

/** One open project's entire review state: keyed by the main-assigned session id so
 * it survives any number of tab switches untouched. */
export type SessionSlice = {
  id: SessionId;
  repo: RepoInfo;
  log: LogState | null;
  branches: BranchesState | null;
  brush: BrushRange | null;
  /** The branch whose commits the picker lists, or null for the checked-out one. */
  head: BranchName | null;
  /** What `head` is compared against, or null to list `head`'s own history. Set, the
   * log holds exactly what `head` adds over it — a pull request's commit list — and the
   * brush narrows within that. */
  base: BranchName | null;
  /** The one union driving the rendered diff; everything above is input to it. */
  selection: DiffSelection | null;
  diff: DiffState;
  /** Identity of the file the tree/keyboard focus points at; a `PatchFile.path`. */
  selectedFilePath: string | null;
  /** Carried for persistence; capture/restore mechanics live in the scroll layer. */
  scrollTop: number;
  /** The persistable commit-mode input: SHA-anchored, updated at commit points and
   * kept across mode switches and failed derivations so a write-back never
   * downgrades what main already holds (brush indices are never persisted). */
  commitSelection: CommitSelection | null;
  /** The imported review, carried through hydration and write-back verbatim so a
   * persisted update never wipes it. */
  comments: Comment[];
  layers: ReviewLayer[];
  /** The authored tour doc, or null for a review that carries none (and for every plain
   * repo session). Carried through hydration and write-back verbatim, like the
   * comments/layers beside it, so a round-trip export re-emits it. */
  overview: ReviewOverview | null;
  /** Whether the tour doc — stop zero of the walkthrough — is the surface on screen.
   * Derived view state exactly like `activeLayerId`: never persisted, and every setter
   * that targets the diff (soloing a layer, focusing a comment, picking a file) clears
   * it, so "the doc is open" and "a layer is soloed" can never both read true. A
   * restored review session starts here whenever it has a doc to show — the review
   * begins at its overview, not mid-diff. Invariant: true implies
   * `activeLayerId === null`, which makes the rail's selection unambiguous. */
  overviewOpen: boolean;
  /** The last chapter the reader entered, or null before they enter any. Ephemeral like
   * the two above, and never a second source of truth for what is soloed — it exists so
   * returning to the doc lands on the chapter you just read instead of the top of a long
   * page, which is the one thing a hub-and-spoke walkthrough must not lose. */
  lastChapterId: string | null;
  /** The review's pinned diff, or null for a plain repo session. When set,
   * it drives the rendered diff so the anchors place on their exact authored lines. A
   * `frozenPatch` pin renders its embedded diff verbatim (anchors resolve frozen); a
   * `refs` pin re-derives `base..head` from git. A review session keeps this pin for
   * its whole life — the selector only narrows within it via `reviewSubrange` — so a
   * reopened review always lands back on the authored diff. Persisted. */
  reviewDiff: ReviewDiff | null;
  /** The subset of the review's `base..head` commits the reviewer narrowed to, or
   * null for the whole review. Layered over `reviewDiff`: null renders the pin (every
   * anchor places); non-null re-derives the diff of just those commits, so a comment
   * on a file the subset drops becomes unplaceable (surfaced, never lost). SHA-anchored
   * and persisted; only ever set on a refs review session, never a frozen one. */
  reviewSubrange: CommitSelection | null;
  /** The authored repo, refs, and patch this session was opened from: what the
   * round-trip export re-emits as the artifact's own `repo`/`base`/`head`. Stable — unlike
   * `reviewDiff` it is never cleared when the reviewer picks their own diff, so a
   * curated review still exports to its authored `base..head` after navigation.
   * Null for a plain repo session (nothing to export as a review). */
  reviewOrigin: ReviewOrigin | null;
  /** The soloed layer, or null for the full diff. Derived view state: it
   * never persists (absent from `persistedSession`) and its setters schedule no
   * write-back, so layer navigation is additive over the session, never a
   * mutation of `selection`/`selectedFilePath`/`scrollTop`. */
  activeLayerId: string | null;
  /** The comment the reviewer is stepping through / has focused, or null. Derived
   * view state exactly like `activeLayerId`: never persisted (absent from
   * `persistedSession`) and its setters schedule no write-back, so comment
   * navigation is additive over the session and a relaunch always starts clean.
   * The one source the sidebar list, the floating counter, and `DiffView`'s
   * scroll-to-comment all read. */
  activeCommentId: string | null;
  /** The focused comment whose scroll the diff surface still owes, or null once it has
   * been performed. Separate from `activeCommentId` because the two answer different
   * questions — *which* comment is focused (the ring, the counter) versus whether
   * focusing it is still an *unmet request to move the viewport* — and only the second
   * survives the surface not being mounted.
   *
   * That is the whole reason it exists: the tour doc replaces the diff pane, so clicking
   * a comment from the doc sets the focus in the same commit the surface *mounts*, where
   * `DiffView`'s "did the focused comment change" compare has nothing to compare against
   * and stands down — the reader landed on the file's first line with the card far below.
   * A request that is consumed rather than diffed is true on that mount and false on a
   * bare remount (a tab bounce), which is exactly the distinction the old ref-compare was
   * reaching for and could not make. Write it through `commentFocus` and clear it through
   * `commentScrolled`; never persisted, like the focus itself. */
  pendingCommentScroll: string | null;
  /** How much of the diff the reader has been through: each read file's path against the
   * signature of the content they read (see `lib/read-progress.ts`).
   *
   * Persisted, unlike the derived view state above it, and it is the one piece of session
   * state that persists *twice*: into the session, so a reload or a relaunch restores every
   * open tab, and — for a review session — into the artifact's own progress record, so
   * closing the tab and reopening the review later resumes rather than restarts. Main owns
   * the mirroring; from here it is one write-back like any other. Never part of the exported
   * artifact, though: progress is one person's place in the reading, not something the
   * review claims about itself. */
  readFiles: ReadFiles;
  /** Files the code view is showing as a header band only, body folded away. Persisted
   * alongside `readFiles`, and deliberately *not* derived from it: marking a file read folds
   * it, so what is still owed rises up the pane, but the header stays a disclosure — a
   * finished file opens back up in one click and stays open. Only a gesture ever folds or
   * unfolds a file; nothing springs shut on its own. Restoring the marks without the folds
   * would reopen every file the reader had already put away, which is why it travels with
   * them rather than starting empty. */
  collapsedFiles: ReadonlySet<string>;
  /** The `.reviewer.json` this session was opened from, or null for a plain repo session.
   * Identity only — never rendered, never exported. It is what makes "this review is already
   * open" and "this review's progress lives here" one question with one answer. */
  reviewPath: string | null;
  /** The denominator of the marks as last persisted — how many files the diff held. Carried
   * rather than derived because it is only ever *read* by surfaces with no diff in hand (the
   * recents rows, the start screen), and only ever *written* from a loaded one: whenever this
   * session persists with its diff loaded, the live count replaces it. Between those, it
   * holds the last honest answer rather than decaying to zero. */
  readTotal: number;
  /** True from hydration until first activation derives log/branches/diff; a
   * derived slice is never re-derived, so switching back costs zero bridge calls. */
  needsDerive: boolean;
  /** Monotonic per-slice ticket guarding diff responses only: one is applied only
   * if the slice still exists and no newer action in the same session superseded
   * it, so a late response mutates its originating slice or nothing — never
   * another session. Derivation fetches are deliberately outside it (they guard
   * on slice existence), so user actions can never discard a derive in flight. */
  requestTicket: number;
  /** The same discipline for the picker's log re-walks, counted apart from the diff's
   * because the two go stale independently: a brush commit supersedes an in-flight diff
   * without saying anything about the walk still on its way back. Comparing endpoints is
   * not enough on its own — `setHead` A → B → A, faster than git answers, leaves two walks
   * whose endpoints both match the pair now on screen, and the older one would win by
   * resolving last. Derivation's log fetch is outside this one too, for the same reason. */
  logTicket: number;
};

/** The lookup seam component selectors go through; the full store state satisfies it. */
export type SessionsView = Pick<ReviewState, "sessions" | "activeSessionId">;

export function selectActiveSlice(state: SessionsView): SessionSlice | null {
  return state.activeSessionId === null ? null : (state.sessions[state.activeSessionId] ?? null);
}

/** Moving the comment focus, as one value. Every site that changes which comment is
 * focused — walkthrough's focus/clear, a discard that takes the focused one, plain file
 * navigation dismissing the step-through — writes this rather than the two fields, so the
 * surface can never be left owing a scroll to a comment nothing is focused on. Spelling
 * out `pendingCommentScroll` at a call site is the one thing that would reintroduce that
 * bug, so no call site does; the sole exception is `commentScrolled`, which clears the
 * request *because* the scroll happened and must leave the focus standing. */
export function commentFocus(
  commentId: string | null,
): Pick<SessionSlice, "activeCommentId" | "pendingCommentScroll"> {
  return { activeCommentId: commentId, pendingCommentScroll: commentId };
}

/** The slice's soloed diff: the authored layers plus the inferred "not covered by layers"
 * layer, the active one resolved against that list, and the file subset a solo leaves. The
 * synthetic layer is never persisted (it stays out of `slice.layers`), only ever reachable
 * through the ephemeral `activeLayerId`. An unloaded diff has no universe, so it degrades
 * to the authored layers over an empty file set.
 *
 * Navigation, soloing and the two surfaces all read this one derivation
 * (`lib/soloed-diff.ts`), which memoises on the identities `slice` holds — so an action
 * that fires per keypress costs a lookup, not a walk of the diff. */
export function sliceSolo(slice: SessionSlice): SoloedDiff {
  const files = slice.diff.phase === "loaded" ? slice.diff.files : NO_FILES;
  return soloedDiff(files, slice.layers, slice.activeLayerId);
}

/** A stable empty layer list, so the sessionless case below hits one cache entry rather
 * than keying a new one per call. */
const NO_LAYERS: readonly ReviewLayer[] = [];

/** The same derivation for the active session, for the components that render it — one
 * cached object, so subscribing to it is a reference check and never a re-render on its
 * own. Sessionless (no slice) reads as an empty diff with no layers. */
export function selectSoloedDiff(state: SessionsView): SoloedDiff {
  const slice = selectActiveSlice(state);
  return slice === null ? soloedDiff(NO_FILES, NO_LAYERS, null) : sliceSolo(slice);
}

export type Setter = (partial: Partial<ReviewState>) => void;
export type Getter = () => ReviewState;

/** Every slice write funnels through here: a slice deleted mid-flight (tab close)
 * silently absorbs the write instead of resurrecting itself.
 *
 * It also carries the no-op guard structurally, so no call site is required to have its
 * own: a `partial` that changes nothing (every key already `Object.is`-equal to the slice's
 * current value) skips the `set` entirely — the same contract `applyRead`, `previewBrush`
 * and `setFileCollapsed` each also check by hand before calling in, which this reinforces
 * rather than conflicts with. Without it, every write here — including `setScrollTop` and
 * `selectFile`, which write unconditionally — reallocated the whole `sessions` record,
 * which is what turned a `j`/`k` at the end of a file list, or a brush drag's 60 Hz of
 * `previewBrush` calls, into a `sessions` identity change on every tick and re-rendered
 * every subscriber of the whole record (see `TabBar`). */
export function setSlice(
  set: Setter,
  get: Getter,
  sessionId: SessionId,
  partial: Partial<SessionSlice>,
): void {
  const sessions = get().sessions;
  const slice = sessions[sessionId];
  if (slice === undefined) {
    return;
  }
  const keys = Object.keys(partial) as (keyof SessionSlice)[];
  if (keys.every((key) => Object.is(slice[key], partial[key]))) {
    return;
  }
  set({ sessions: { ...sessions, [sessionId]: { ...slice, ...partial } } });
}

/** The resolve-and-guard every session action opens with, stated once: default to the session
 * on screen, and do nothing at all when there is none or when the id names no slice.
 *
 * Both halves are the same fact — an action is always *about* a slice, and a caller that passes
 * no id means "the one the reader is looking at". Silence is the right answer to both misses:
 * menu commands and keyboard accelerators fire whether or not a session is open, and a tab
 * closed between the gesture and the call must absorb the write rather than resurrect itself
 * (the same contract `setSlice` carries for the write itself).
 *
 * The callback's result comes back, or `undefined` when it never ran — which is what lets the
 * clipboard actions, the only ones that answer anything, say `?? false` in one place each. */
export function withSlice<T>(
  get: Getter,
  sessionId: SessionId | undefined,
  fn: (slice: SessionSlice, id: SessionId) => T,
): T | undefined {
  const id = sessionId ?? get().activeSessionId;
  if (id === null) {
    return;
  }
  const slice = get().sessions[id];
  if (slice === undefined) {
    return;
  }
  return fn(slice, id);
}
