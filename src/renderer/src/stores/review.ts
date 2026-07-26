import { create } from "zustand";
import { assertNever } from "../../../shared/assert";
import type {
  BranchList,
  BranchName,
  LogRange,
  CommitSelection,
  CommitSha,
  DiffSelection,
  GitFailure,
  LogEntry,
  RepoInfo,
} from "../../../shared/git";
import type { ReviewerBridge, TabCycleDirection, TabOrdinal } from "../../../shared/ipc";
import {
  Comment,
  type ReviewAnchor,
  type ReviewDiff,
  type ReviewLayer,
  type ReviewOrigin,
  type ReviewOverview,
} from "../../../shared/review";
import type { ReviewOpenFailure, ReviewOpenResponse } from "../../../shared/review-open";
import type { Session, SessionId, SessionSnapshot } from "../../../shared/session";
import { parsePatch, type PatchFile } from "../lib/diff/patch";
import { findLayer, soloFiles, stepLayer as stepLayerId } from "../lib/layers";
import { effectiveLayers } from "../lib/coverage";
import {
  isFileRead,
  markFilesRead,
  NO_COLLAPSED_FILES,
  NO_READ_FILES,
  withCollapsed,
  type ReadFiles,
} from "../lib/read-progress";
import { indexOfComment, navigableEntries, orderedComments } from "../lib/diff/comment-navigation";
import {
  exportSourceFor,
  markdownCommentsFrom,
  reviewToMarkdown,
  serializeReview,
} from "../lib/review-export";
import type { ReviewExportFailure } from "../lib/review-export-failure-message";
import {
  brushFromSelection,
  brushReducer,
  isFullBrush,
  reviewFullBrush,
  selectionFromBrush,
  type BrushAction,
  type BrushRange,
} from "../lib/selection";

export type DiffStyle = "split" | "unified";

export type DiffState =
  | { phase: "idle" }
  | { phase: "loading" }
  /** loadId is unique per load within a session; key one-shot structures (the
   * tree model) by session id + loadId, since tickets restart per session. */
  | { phase: "loaded"; loadId: number; files: PatchFile[] }
  | { phase: "empty" }
  /** git produced bytes the patch parser could not read — distinct from a clean diff. */
  | { phase: "unreadable" }
  | { phase: "failed"; failure: GitFailure };

export type LogState =
  | { phase: "loading" }
  | { phase: "loaded"; entries: LogEntry[] }
  | { phase: "failed"; failure: GitFailure };

export type BranchesState =
  | { phase: "loading" }
  | { phase: "loaded"; list: BranchList }
  | { phase: "failed"; failure: GitFailure };

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
  /** How much of the diff the reader has been through: each read file's path against the
   * signature of the content they read (see `lib/read-progress.ts`). Derived view state
   * exactly like `activeLayerId` and `activeCommentId` — absent from `persistedSession`,
   * no write-back on its setters, and never part of the exported artifact: progress is one
   * person's place in one sitting, not something the review claims about itself. It
   * survives every tab switch (it lives in the slice, which is keyed by session id) and
   * nothing else. */
  readFiles: ReadFiles;
  /** Files the code view is showing as a header band only, body folded away. Ephemeral and
   * unpersisted like `readFiles`, and deliberately *not* derived from it: marking a file
   * read folds it, so what is still owed rises up the pane, but the header stays a
   * disclosure — a finished file opens back up in one click and stays open. Only a
   * gesture ever folds or unfolds a file; nothing springs shut on its own. */
  collapsedFiles: ReadonlySet<string>;
  /** True from hydration until first activation derives log/branches/diff; a
   * derived slice is never re-derived, so switching back costs zero bridge calls. */
  needsDerive: boolean;
  /** Monotonic per-slice ticket guarding diff responses only: one is applied only
   * if the slice still exists and no newer action in the same session superseded
   * it, so a late response mutates its originating slice or nothing — never
   * another session. Derivation fetches are deliberately outside it (they guard
   * on slice existence), so user actions can never discard a derive in flight. */
  requestTicket: number;
};

/** `hydrate` runs once ("pending" gates a StrictMode double effect); "hydrating"
 * spans the `sessions:list` round-trip, during which the empty state must not
 * flash; "ready" resolves to empty or sessions by whether slices exist. */
export type BootPhase = "pending" | "hydrating" | "ready";

type ReviewState = {
  boot: BootPhase;
  /** Tab order is insertion order: hydration inserts in main's persisted order
   * and opens append, so the key order IS the tab strip everywhere. */
  sessions: Record<SessionId, SessionSlice>;
  /** Invariant (matching main's store): names an existing slice or nothing. */
  activeSessionId: SessionId | null;
  /** A failed repo-open is app-level: it never lands in a slice. The
   * OpenFailureBanner renders it while a session is active, the empty state
   * otherwise. */
  openFailure: GitFailure | null;
  /** A failed review-open (bad extension, oversize, malformed, …): also app-level
   * (opens land as sessions, so a *failed* open has no session to report in),
   * surfaced by the ReviewOpenFailureBanner and cleared on the next open. */
  reviewOpenFailure: ReviewOpenFailure | null;
  /** A failed review export: app-level like the open failures, surfaced by
   * ReviewExportFailureBanner and cleared on the next export or dismissal. Either a
   * lost disk write (a swallowed one would leave the reviewer believing a curated
   * review was saved when nothing reached disk) or an unreadable diff that
   * could not be frozen into an artifact — never a silent no-op. */
  reviewExportFailure: ReviewExportFailure | null;
  diffStyle: DiffStyle;
  /** Boot hydration: pull main's persisted sessions, derive the active one only. */
  hydrate: () => Promise<void>;
  activateSession: (id: SessionId) => void;
  /** Deletes the session in main and removes the slice; closing the active tab
   * activates the right neighbor, else the left, else lands on the empty state. */
  closeSession: (sessionId?: SessionId) => void;
  /** Re-seats the tab strip after a drag. Key insertion order IS tab order, so the
   * record is rebuilt rather than annotated — ⌘1…9 and ⌃Tab then follow the new
   * arrangement for free, since both read that same order. */
  reorderSessions: (ids: SessionId[]) => void;
  /** ⌘1…⌘8 are positional; ⌘9 is the last tab (macOS tabbed-app convention). */
  activateTabByOrdinal: (ordinal: TabOrdinal) => void;
  /** ⌃Tab / ⌃⇧Tab; wraps at both ends. */
  cycleActiveSession: (direction: TabCycleDirection) => void;
  openRepository: () => Promise<void>;
  /** The File → Open Review… menu command: main shows the native picker. */
  openReview: () => Promise<void>;
  /** A dropped `.reviewer.json`: `path` came from the preload `getPathForFile`. */
  openReviewByPath: (path: string) => Promise<void>;
  /** A dropped File: resolve its disk path via the preload, then open it. A File
   * with no backing path (getPathForFile → null) becomes a typed failure and is
   * never sent as an empty-path invoke. */
  openDroppedFile: (file: File) => Promise<void>;
  /** Re-list main's sessions after a CLI/`open-file` import pushed `sessionsChanged`,
   * or after a dialog/drop opened one: adds the new slice(s), adopts main's active,
   * and derives it — without disturbing any already-live slice. */
  syncSessions: () => Promise<void>;
  clearOpenFailure: () => void;
  clearReviewOpenFailure: () => void;
  clearReviewExportFailure: () => void;
  /** Moves the brush without touching the diff — drag feedback between pointerdown
   * and pointerup; `commitBrush` (or any loading action) makes it real. */
  previewBrush: (action: BrushAction, sessionId?: SessionId) => void;
  commitBrush: (sessionId?: SessionId) => void;
  applyBrush: (action: BrushAction, sessionId?: SessionId) => void;
  /** Clear a review session's commit subrange back to the whole review: the diff
   * returns to the authored pin (frozen or refs) so every comment places again. */
  resetReviewSubrange: (sessionId?: SessionId) => void;
  /** Point the picker at another branch: its commits become the list. Refetches the
   * log and re-locates the brush in it. */
  setHead: (branch: BranchName, sessionId?: SessionId) => void;
  /** Compare `head` against `base` — the list narrows to exactly what `head` adds over
   * it, the range a pull request shows — or pass null to drop the comparison and go
   * back to the branch's own history. Refetches the log, like `setHead`. */
  setBase: (branch: BranchName | null, sessionId?: SessionId) => void;
  swapBranches: (sessionId?: SessionId) => void;
  selectFile: (path: string, sessionId?: SessionId) => void;
  selectAdjacentFile: (direction: 1 | -1, sessionId?: SessionId) => void;
  setScrollTop: (scrollTop: number, sessionId?: SessionId) => void;
  /** Curation: add a user-authored comment at a picked anchor. The app assigns
   * identity here — a manual comment is stamped exactly like an imported one; an
   * empty body is never stored. Persists via the write-back. */
  addComment: (anchor: ReviewAnchor, body: string, sessionId?: SessionId) => void;
  /** Edit any comment — imported or manual, all equally editable; an
   * empty body is a no-op, never an empty-body write. */
  editComment: (commentId: string, body: string, sessionId?: SessionId) => void;
  /** Discard any comment; a discarded comment leaves no trace. */
  discardComment: (commentId: string, sessionId?: SessionId) => void;
  /** Solo a layer by id, or pass null to clear back to the full diff.
   * Derived view state only: no write-back, and `selection`/`selectedFilePath`/
   * `scrollTop` are left untouched — the diff the session persists never moves.
   * Always leaves the tour doc: choosing what the diff shows means you are done reading
   * the trailhead. */
  setActiveLayer: (layerId: string | null, sessionId?: SessionId) => void;
  /** Open the tour doc — the review's first stop. Clears the soloed layer so the rail has
   * exactly one selected stop, and lands on the section the reader last came out of. A
   * no-op on a session with no doc. */
  openOverview: (sessionId?: SessionId) => void;
  /** Leave the tour doc for the full diff — the "browse all files" way out, and what the
   * `o` toggle does from inside the doc. */
  closeOverview: (sessionId?: SessionId) => void;
  /** Walk the walkthrough: the tour doc (when the review has one) is stop zero, then the
   * authored layer order, clamping at both ends. Stepping back off the first layer opens
   * the doc; stepping forward from it enters the first layer. Snappy and additive,
   * exactly like `setActiveLayer` (no write-back, no session mutation). */
  stepLayer: (direction: 1 | -1, sessionId?: SessionId) => void;
  /** Focus a comment by id: mark it active (drives the scroll-to + card ring + the
   * counter) and move the file focus onto its file so the tree and j/k stay in
   * sync. Clears an active solo that would hide the target so its annotation is
   * actually mounted. The active id is ephemeral (no write-back); the file focus
   * persists like any other navigation. */
  focusComment: (commentId: string, sessionId?: SessionId) => void;
  /** Step the reader through the comments that have a line on the surface (placed
   * or outdated), in reading order over the currently visible (soloed) file set,
   * wrapping at both ends. A no-op when there are none. */
  stepComment: (direction: 1 | -1, sessionId?: SessionId) => void;
  /** Drop the focused comment back to none — dismisses the counter and the ring. */
  clearActiveComment: (sessionId?: SessionId) => void;
  /** Mark one file of the loaded diff read or unread — the atom every other progress
   * readout is derived from. Marks against the file's current content, so the mark can
   * never outlive the code it was made about. Derived view state: no write-back, and a
   * path the loaded diff does not carry is a no-op rather than a mark for nothing. */
  setFileRead: (path: string, read: boolean, sessionId?: SessionId) => void;
  /** The `r` gesture: flip the focused file (or a named one). Pure — it moves nothing,
   * so the reader stays exactly where they were reading. */
  toggleFileRead: (path?: string | null, sessionId?: SessionId) => void;
  /** Mark a whole chapter read or unread: every file in the layer's *extent* — itself
   * plus everything nested under it, the same subset soloing shows — so completing a
   * group and completing its sections are the same act. The synthetic "not covered by
   * layers" layer works here too, since it solos like any other. */
  setLayerRead: (layerId: string, read: boolean, sessionId?: SessionId) => void;
  /** Back to nothing read. Scoped to a file set (the tree's own listing, or the whole
   * diff from the doc) so a reset offered beside a subset can never quietly wipe the
   * rest of the review's progress. */
  clearFilesRead: (paths: readonly string[], sessionId?: SessionId) => void;
  /** Fold a file's body away in the code view, or open it back up — the file header's own
   * disclosure. Independent of the read mark: marking read folds, but folding is not
   * marking, and a finished file the reader opens again stays open. */
  setFileCollapsed: (path: string, collapsed: boolean, sessionId?: SessionId) => void;
  setDiffStyle: (style: DiffStyle) => void;
  /** Export the curated review as a round-trip `.reviewer.json`: serialize
   * the authored projection and hand it to the native save seam in main. An
   * imported review re-emits its authored source verbatim; a plain repo session
   * exports its on-screen diff (`resolveExportOrigin`) — branch refs, or a frozen
   * patch for a commit-range/working-tree diff. */
  exportReviewJson: (sessionId?: SessionId) => Promise<void>;
  /** Export the curated review as portable Markdown through the same save
   * seam and the same origin derivation; outdated notes resolve against the loaded
   * diff. */
  exportReviewMarkdown: (sessionId?: SessionId) => Promise<void>;
  /** Fires every pending debounced write-back now — the quit/unload path, so main
   * holds the last mutation before its own disk flush. */
  flushWriteBacks: () => void;
};

/** The lookup seam component selectors go through; the full store state satisfies it. */
export type SessionsView = Pick<ReviewState, "sessions" | "activeSessionId">;

export function selectActiveSlice(state: SessionsView): SessionSlice | null {
  return state.activeSessionId === null ? null : (state.sessions[state.activeSessionId] ?? null);
}

/** The authored layers plus the inferred "not covered by layers" layer, resolved against
 * whatever diff is loaded. Navigation and soloing key off this so the synthetic layer
 * steps and filters exactly like an authored one; it is never persisted (it stays out of
 * `slice.layers`), only ever reachable through the ephemeral `activeLayerId`. An
 * unloaded diff has no universe, so it degrades to the authored layers. */
function sliceLayers(slice: SessionSlice): ReviewLayer[] {
  const files = slice.diff.phase === "loaded" ? slice.diff.files : [];
  return effectiveLayers(files, slice.layers);
}

/** What the current mode's state asks of the diff pane. */
type DiffPlan =
  | { kind: "selection"; selection: DiffSelection }
  /** A review's frozen embedded patch: rendered as-is, off git entirely. */
  | { kind: "frozenPatch"; patch: string }
  /** The mode's source data failed to load — the pane shows that failure. */
  | { kind: "blocked"; failure: GitFailure }
  | { kind: "nothing" };

function planDiff(slice: SessionSlice): DiffPlan {
  // A review session is scoped to its authored diff: the selector can only
  // narrow to a subset of the review's commits, never jump to another diff. A
  // subrange re-derives the diff of just those commits; no subrange renders the pin
  // (frozen patch verbatim, or the `base..head` refs) so every anchor places.
  if (slice.reviewOrigin !== null) {
    if (slice.reviewSubrange !== null) {
      return { kind: "selection", selection: slice.reviewSubrange };
    }
    if (slice.reviewDiff === null) {
      // A review session always carries a pin (createFromReview sets both together);
      // guard defensively rather than render a repo picker for it.
      return { kind: "nothing" };
    }
    return slice.reviewDiff.kind === "frozenPatch"
      ? { kind: "frozenPatch", patch: slice.reviewDiff.patch }
      : {
          kind: "selection",
          selection: {
            kind: "reviewRefs",
            base: slice.reviewDiff.base,
            head: slice.reviewDiff.head,
          },
        };
  }
  // A repo session's picker is one list of commits and a brush over it, so the diff
  // follows from how much of that list is brushed — there is no second flag that could
  // disagree with what is on screen. A comparison brushed end to end IS the comparison
  // (three-dot `base...head`, what a pull request shows); anything narrower is the range
  // of commits actually banded, which is also how a review's subrange works.
  if (slice.log === null || slice.log.phase === "loading") {
    return { kind: "nothing" };
  }
  if (slice.log.phase === "failed") {
    return { kind: "blocked", failure: slice.log.failure };
  }
  const entries = slice.log.entries;
  const comparing = slice.base !== null && slice.head !== null;
  if (
    comparing &&
    slice.base !== null &&
    slice.head !== null &&
    // An empty list still names the comparison rather than nothing: "no changes between
    // these two" is an answer, and the diff pane says it in those words.
    (entries.length === 0 || (slice.brush !== null && isFullBrush(entries, slice.brush)))
  ) {
    return {
      kind: "selection",
      selection: { kind: "branches", base: slice.base, head: slice.head },
    };
  }
  if (slice.brush === null) {
    return { kind: "nothing" };
  }
  const selection = selectionFromBrush(entries, slice.brush);
  return selection === null ? { kind: "nothing" } : { kind: "selection", selection };
}

function sameSelection(a: DiffSelection | null, b: DiffSelection | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  switch (a.kind) {
    case "branches":
      return b.kind === "branches" && a.base === b.base && a.head === b.head;
    case "reviewRefs":
      return b.kind === "reviewRefs" && a.base === b.base && a.head === b.head;
    case "commitRange":
      return b.kind === "commitRange" && a.first === b.first && a.last === b.last;
    case "commitRangeWithUncommitted":
      return b.kind === "commitRangeWithUncommitted" && a.first === b.first;
    case "uncommitted":
      return b.kind === "uncommitted";
    default:
      return assertNever(a);
  }
}

type Setter = (partial: Partial<ReviewState>) => void;
type Getter = () => ReviewState;

/** Every slice write funnels through here: a slice deleted mid-flight (tab close)
 * silently absorbs the write instead of resurrecting itself. */
function setSlice(
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
  set({ sessions: { ...sessions, [sessionId]: { ...slice, ...partial } } });
}

/** Every read-progress write funnels through here — one file, a chapter's worth, or a
 * reset — so the rule that marking a file folds it away is stated once instead of at four
 * call sites that could drift apart.
 *
 * Reading a file is finishing with it: its body is then pane real estate spent on
 * settled work, so the fold is part of the same gesture and the files still owed rise up
 * to meet the reader. Unmarking is its mirror and opens the file back up; the header stays
 * a disclosure either way, so a finished file is always one click from being read again.
 *
 * Two more jobs beyond `setSlice`: a gesture that changed nothing (both helpers return
 * their input on a no-op) never reaches the store, so a redundant click costs no render;
 * and no write-back is ever scheduled, because progress and folding are derived view
 * state and must not touch the session main persists. */
function applyRead(
  set: Setter,
  get: Getter,
  sessionId: SessionId,
  files: readonly PatchFile[],
  read: boolean,
): void {
  const slice = get().sessions[sessionId];
  if (slice === undefined) {
    return;
  }
  const readFiles = markFilesRead(slice.readFiles, files, read);
  const collapsedFiles = withCollapsed(
    slice.collapsedFiles,
    files.map((file) => file.path),
    read,
  );
  if (readFiles === slice.readFiles && collapsedFiles === slice.collapsedFiles) {
    return;
  }
  setSlice(set, get, sessionId, { readFiles, collapsedFiles });
}

/** Matches main's debounce shape (sessions.ts): the first mutation in a window
 * schedules, later ones coalesce into the same write; `flushWriteBacks` owns the
 * trailing edge on quit. */
export const WRITE_BACK_DEBOUNCE_MS = 500;

// Timer handles live outside zustand state: they are I/O plumbing of this module's
// singleton store, not renderable state, and are keyed per session so activity in
// one tab can never coalesce away another tab's write.
const pendingSessionWrites = new Map<SessionId, ReturnType<typeof setTimeout>>();
let pendingActiveWrite: ReturnType<typeof setTimeout> | null = null;

/** The suggested export filename stem from the repo name — the native sheet's
 * pre-fill only, but the request schema rejects path separators, so a repo name
 * carrying one (never a real toplevel basename, but untrusted all the same) is
 * flattened rather than sent as a request main would reject. */
function reviewFileBase(repoName: string): string {
  const safe = repoName.replace(/[\\/]/g, "-").split("\0").join("-").trim();
  return `${safe === "" ? "review" : safe}-review`;
}

/** The session HEAD: the newest committed log entry's sha (the working-tree
 * pseudo-entry rides on top and carries no sha), or null on an unborn repo whose
 * log holds no commit. The committed endpoint an exported working-tree review
 * records as its source (`exportSourceFor`). */
function headShaOf(log: LogState | null): CommitSha | null {
  if (log === null || log.phase !== "loaded") {
    return null;
  }
  for (const entry of log.entries) {
    if (entry.kind === "commit") {
      return entry.commit.sha;
    }
  }
  return null;
}

/** The authored artifact this session exports. An imported review re-emits its
 * origin verbatim. A plain repo session is projected from its on-screen
 * diff: a branch comparison exports as refs; a commit-range or working-tree diff
 * embeds a frozen patch re-read from git so its comments place on their exact
 * authored lines. `"nothing"` is a session with no diff selected — there is
 * genuinely nothing to export; `"diffUnreadable"` is a needed re-read that failed,
 * surfaced rather than silently dropped. An imported review's origin *is* this shape
 * already (`ReviewOrigin`), so re-emitting one is a pass-through. */
type ExportResolution = ReviewOrigin | "nothing" | "diffUnreadable";

async function resolveExportOrigin(
  bridge: ReviewerBridge,
  slice: SessionSlice,
): Promise<ExportResolution> {
  if (slice.reviewOrigin !== null) {
    return slice.reviewOrigin;
  }
  if (slice.selection === null) {
    return "nothing";
  }
  const { repo, base, head, needsPatch } = exportSourceFor(
    slice.selection,
    slice.repo,
    headShaOf(slice.log),
  );
  if (!needsPatch) {
    return { repo, base, head, patch: null };
  }
  const response = await bridge.getDiff({
    repoPath: slice.repo.path,
    selection: slice.selection,
  });
  if (!response.ok) {
    return "diffUnreadable";
  }
  // An empty patch is no usable frozen diff (and no comment could have anchored on
  // it): fall through to the source refs rather than freezing an empty artifact.
  const patch = response.value.patch;
  return { repo, base, head, patch: patch.length > 0 ? patch : null };
}

/** Inputs only — log/branches/diff are re-derived on load and never cross IPC. */
function persistedSession(slice: SessionSlice): Session {
  return {
    id: slice.id,
    source: { kind: "local", repo: slice.repo },
    head: slice.head,
    base: slice.base,
    commitSelection: slice.commitSelection,
    selectedFilePath: slice.selectedFilePath,
    scrollTop: slice.scrollTop,
    comments: slice.comments,
    layers: slice.layers,
    overview: slice.overview,
    reviewDiff: slice.reviewDiff,
    reviewSubrange: slice.reviewSubrange,
    reviewOrigin: slice.reviewOrigin,
  };
}

function sendSessionWriteBack(get: Getter, sessionId: SessionId): void {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined) {
    return;
  }
  void bridge.updateSession(persistedSession(slice));
}

function scheduleSessionWriteBack(get: Getter, sessionId: SessionId): void {
  if (pendingSessionWrites.has(sessionId)) {
    return;
  }
  pendingSessionWrites.set(
    sessionId,
    setTimeout(() => {
      pendingSessionWrites.delete(sessionId);
      sendSessionWriteBack(get, sessionId);
    }, WRITE_BACK_DEBOUNCE_MS),
  );
}

function sendActiveWriteBack(get: Getter): void {
  const bridge = window.reviewer;
  const id = get().activeSessionId;
  if (!bridge || id === null) {
    return;
  }
  void bridge.setActiveSession({ id });
}

/** The active id persists through the same debounce, not per switch — switching
 * back to a session must cost zero immediate bridge calls. */
function scheduleActiveWriteBack(get: Getter): void {
  if (pendingActiveWrite !== null) {
    return;
  }
  pendingActiveWrite = setTimeout(() => {
    pendingActiveWrite = null;
    sendActiveWriteBack(get);
  }, WRITE_BACK_DEBOUNCE_MS);
}

async function runDiffLoad(set: Setter, get: Getter, sessionId: SessionId): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined) {
    return;
  }
  const plan = planDiff(slice);
  // Bumped on every outcome, not just fetches: a plan that resolves to empty or
  // blocked must also invalidate an older in-flight response for this session.
  const ticket = slice.requestTicket + 1;
  if (plan.kind === "blocked") {
    setSlice(set, get, sessionId, {
      requestTicket: ticket,
      selection: null,
      diff: { phase: "failed", failure: plan.failure },
      selectedFilePath: null,
    });
    return;
  }
  if (plan.kind === "nothing") {
    setSlice(set, get, sessionId, {
      requestTicket: ticket,
      selection: null,
      diff: { phase: "empty" },
      selectedFilePath: null,
    });
    return;
  }
  if (plan.kind === "frozenPatch") {
    // A frozen review renders its embedded patch off git entirely: parse it
    // here, no bridge round-trip. `selection` stays null — there is no git selection
    // to name — and the result never changes, so a re-run over a settled load is a
    // no-op rather than a loadId churn.
    if (
      slice.diff.phase === "loaded" ||
      slice.diff.phase === "empty" ||
      slice.diff.phase === "unreadable"
    ) {
      return;
    }
    const frozenFiles = parsePatch(plan.patch, `${sessionId}:${ticket}`);
    setSlice(set, get, sessionId, {
      requestTicket: ticket,
      selection: null,
      diff:
        frozenFiles.length === 0
          ? { phase: plan.patch.trim() === "" ? "empty" : "unreadable" }
          : { phase: "loaded", loadId: ticket, files: frozenFiles },
      selectedFilePath: frozenFiles.some((file) => file.path === slice.selectedFilePath)
        ? slice.selectedFilePath
        : (frozenFiles[0]?.path ?? null),
    });
    return;
  }
  if (
    sameSelection(slice.selection, plan.selection) &&
    (slice.diff.phase === "loaded" || slice.diff.phase === "empty")
  ) {
    return;
  }

  setSlice(set, get, sessionId, {
    requestTicket: ticket,
    selection: plan.selection,
    // A repo session's commit-brush arm persists as the SHA-anchored `commitSelection`;
    // `branches`, a review's pinned `reviewRefs`, and a review session's own commit
    // arm (which persists as `reviewSubrange` instead) all leave it untouched.
    commitSelection:
      plan.selection.kind === "branches" ||
      plan.selection.kind === "reviewRefs" ||
      slice.reviewOrigin !== null
        ? slice.commitSelection
        : plan.selection,
    diff: { phase: "loading" },
  });

  const response = await bridge.getDiff({ repoPath: slice.repo.path, selection: plan.selection });
  const current = get().sessions[sessionId];
  if (current === undefined || current.requestTicket !== ticket) {
    return;
  }
  if (!response.ok) {
    setSlice(set, get, sessionId, { diff: { phase: "failed", failure: response.failure } });
    return;
  }
  const files = parsePatch(response.value.patch, `${sessionId}:${ticket}`);
  if (files.length === 0) {
    // The wire contract (Patch, src/shared/git.ts) sends "" for a changeless
    // selection; zero files out of a non-empty patch is a parse failure, not
    // a clean diff.
    setSlice(set, get, sessionId, {
      diff: { phase: response.value.patch.trim() === "" ? "empty" : "unreadable" },
    });
    return;
  }
  setSlice(set, get, sessionId, {
    diff: { phase: "loaded", loadId: ticket, files },
    // A restored (or merely persistent) file focus survives when the fresh diff
    // still contains it; otherwise focus starts at the top like a fresh open.
    selectedFilePath: files.some((file) => file.path === current.selectedFilePath)
      ? current.selectedFilePath
      : (files[0]?.path ?? null),
  });
}

/** A restored slice before first activation: inputs from disk, derived state absent. */
function restoredSlice(session: Session): SessionSlice {
  return {
    id: session.id,
    repo: session.source.repo,
    log: null,
    branches: null,
    brush: null,
    head: session.head,
    base: session.base,
    selection: null,
    diff: { phase: "idle" },
    selectedFilePath: session.selectedFilePath,
    scrollTop: session.scrollTop,
    commitSelection: session.commitSelection,
    comments: session.comments,
    layers: session.layers,
    overview: session.overview,
    // A review that carries a tour doc opens on it: the doc is where the review starts,
    // and a restore (or a fresh open, which lands here too) should read the same way as
    // the first open did. A session with no doc restores straight onto its diff.
    overviewOpen: session.overview !== null,
    reviewDiff: session.reviewDiff,
    reviewSubrange: session.reviewSubrange,
    reviewOrigin: session.reviewOrigin,
    activeLayerId: null,
    lastChapterId: null,
    activeCommentId: null,
    // Progress starts empty on every launch, like the soloed layer and the focused
    // comment beside it: a relaunch reopens the review at its overview, unread.
    readFiles: NO_READ_FILES,
    collapsedFiles: NO_COLLAPSED_FILES,
    needsDerive: true,
    requestTicket: 0,
  };
}

/** What `git log` walks for this session: a review's own `base..head`, another
 * branch's whole history when the picker was pointed at one, or HEAD — which is the
 * only walk that carries the working-tree row, and so the one a session listing its
 * own checked-out branch must keep. */
function logRangeFor(slice: SessionSlice): LogRange | null {
  if (slice.reviewOrigin !== null) {
    return { base: slice.reviewOrigin.base, head: slice.reviewOrigin.head };
  }
  if (slice.head === null) {
    // Detached, or before the branch list landed: HEAD is the only ref there is.
    return null;
  }
  if (slice.base !== null) {
    return { base: slice.base, head: slice.head };
  }
  const current =
    slice.branches !== null && slice.branches.phase === "loaded"
      ? slice.branches.list.currentBranch
      : null;
  // Listing the checked-out branch is the HEAD walk — the same commits, plus the
  // working tree — so it is left as `null` rather than named, which would trade that
  // row away for nothing.
  return slice.head === current ? null : { base: null, head: slice.head };
}

/** Where the brush lands on a freshly walked log.
 *
 * A comparison is brushed end to end: asking for `main → feature/x` means asking for
 * what that comparison holds, and a band over all of it is how the picker says so (the
 * same shape a review session opens in over its own range). Without one, the list is a
 * whole history and nobody means "all of it" by that — so it lands on the newest entry,
 * or on the persisted selection when that is still in this walk. */
function brushAfterWalk(
  entries: LogEntry[],
  slice: SessionSlice,
  /** True when the reviewer just moved an endpoint, false when a session is being
   * restored. The two want opposite things from the same log: a reviewer who has just
   * asked for `main → feature/x` wants to see that comparison, not whatever narrower
   * range they happened to be on beforehand; a session reopening wants the place it was
   * left, and nothing else. */
  land: boolean,
): BrushRange | null {
  if (entries.length === 0) {
    return null;
  }
  // A comparison is brushed end to end — asking for it means asking for what it holds,
  // which is the same shape a review session opens in over its own range. A plain
  // history is not something anyone means "all of" by, so it lands on the newest entry.
  const whole = (): BrushRange | null =>
    slice.base !== null ? reviewFullBrush(entries) : { anchor: 0, focus: 0 };
  if (land || slice.commitSelection === null) {
    return whole();
  }
  // Restoring: a selection the log can no longer place degrades to nothing rather than
  // to some other diff — reopening a session onto a *different* range than the one it
  // was left on is worse than reopening onto none.
  return brushFromSelection(entries, slice.commitSelection);
}

/** Re-walk the log after the picker moves an endpoint, then place the brush in what came
 * back. */
async function reloadLog(set: Setter, get: Getter, sessionId: SessionId): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined) {
    return;
  }
  setSlice(set, get, sessionId, { log: { phase: "loading" } });
  const log = await bridge.getCommitLog({
    repoPath: slice.repo.path,
    range: logRangeFor(slice),
  });
  const current = get().sessions[sessionId];
  if (current === undefined || current.head !== slice.head || current.base !== slice.base) {
    // The reviewer moved the endpoints again while this was in flight.
    return;
  }
  if (!log.ok) {
    setSlice(set, get, sessionId, { log: { phase: "failed", failure: log.failure }, brush: null });
    await runDiffLoad(set, get, sessionId);
    return;
  }
  const entries = log.value.entries;
  setSlice(set, get, sessionId, {
    log: { phase: "loaded", entries },
    brush: brushAfterWalk(entries, current, true),
  });
  await runDiffLoad(set, get, sessionId);
}

/** First activation of a restored slice: fetch log + branches, re-locate the
 * SHA-anchored brush in the fresh log, then load the diff. Never runs twice for
 * one slice — later activations render what is already there. */
async function deriveSession(set: Setter, get: Getter, sessionId: SessionId): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined || !slice.needsDerive) {
    return;
  }
  setSlice(set, get, sessionId, {
    needsDerive: false,
    log: { phase: "loading" },
    branches: { phase: "loading" },
    diff: { phase: "loading" },
  });

  // A review session lists only its own `base..head` commits; a repo session walks
  // whichever branch its picker was left on. The pin still renders the diff, so a
  // failed ranged log only costs the reviewer the ability to narrow, never the review.
  const range = logRangeFor(slice);
  const [log, branches] = await Promise.all([
    bridge.getCommitLog({ repoPath: slice.repo.path, range }),
    bridge.listBranches({ repoPath: slice.repo.path }),
  ]);
  // Existence is the only staleness that applies here: nothing else can produce
  // log/branches for this slice (needsDerive flipped synchronously, and opens
  // always create fresh slices). The requestTicket guards diff responses alone —
  // an interleaved user action must not discard the derivation it waits on.
  const current = get().sessions[sessionId];
  if (current === undefined) {
    return;
  }
  const review =
    current.reviewOrigin !== null && log.ok
      ? recoverReviewBrush(log.value.entries, current.reviewSubrange)
      : null;
  setSlice(set, get, sessionId, {
    log: log.ok
      ? { phase: "loaded", entries: log.value.entries }
      : { phase: "failed", failure: log.failure },
    branches: branches.ok
      ? { phase: "loaded", list: branches.value }
      : { phase: "failed", failure: branches.failure },
    brush:
      review !== null
        ? review.brush
        : log.ok
          ? brushAfterWalk(log.value.entries, current, false)
          : null,
    reviewSubrange: review !== null ? review.reviewSubrange : current.reviewSubrange,
    // A persisted pick wins; a fresh session lists the branch it is standing on. `base`
    // is deliberately not defaulted: a session opens on the branch's own history, and a
    // comparison is something the reviewer asks for.
    head:
      current.head ??
      (branches.ok ? (branches.value.currentBranch ?? branches.value.defaultBranch) : null),
  });
  await runDiffLoad(set, get, sessionId);
}

/** Shared tail of the dialog + drop paths: a typed failure surfaces on the
 * app-level banner; an opened review re-lists (main already created + activated
 * the session) and focuses it; a dialog cancel is a no-op. */
async function applyReviewOpen(
  set: Setter,
  get: Getter,
  response: ReviewOpenResponse,
): Promise<void> {
  if (!response.ok) {
    set({ reviewOpenFailure: response.failure });
    return;
  }
  if (response.value.kind === "canceled") {
    return;
  }
  set({ reviewOpenFailure: null });
  await get().syncSessions();
  get().activateSession(response.value.sessionId);
}

/** A review session's brush over its `base..head` ranged log, and the subrange to
 * keep: the whole review by default; the saved subrange when it still fits; else the
 * whole review, resetting the now-stale subrange so the diff shows the full review
 * (via the pin) rather than a range whose commits history has since dropped. */
function recoverReviewBrush(
  entries: LogEntry[],
  reviewSubrange: CommitSelection | null,
): { brush: BrushRange | null; reviewSubrange: CommitSelection | null } {
  if (reviewSubrange === null) {
    return { brush: reviewFullBrush(entries), reviewSubrange: null };
  }
  const brush = brushFromSelection(entries, reviewSubrange);
  return brush === null
    ? { brush: reviewFullBrush(entries), reviewSubrange: null }
    : { brush, reviewSubrange };
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  boot: "pending",
  sessions: {},
  activeSessionId: null,
  openFailure: null,
  reviewOpenFailure: null,
  reviewExportFailure: null,
  diffStyle: "split",

  hydrate: async () => {
    if (get().boot !== "pending") {
      return;
    }
    set({ boot: "hydrating" });
    const bridge = window.reviewer;
    if (!bridge) {
      // Browser gate run: no main process, so no sessions to restore.
      set({ boot: "ready" });
      return;
    }
    let snapshot: SessionSnapshot;
    try {
      snapshot = await bridge.listSessions();
    } catch (error) {
      // Session reads are designed never to fail, but an
      // IPC-level rejection must still degrade to the empty state with a visible
      // failure — never a forever-blank "hydrating" boot.
      console.error("Session hydration failed:", error);
      set({ boot: "ready", openFailure: { code: "unexpected" } });
      return;
    }
    const sessions: Record<SessionId, SessionSlice> = {};
    for (const session of snapshot.sessions) {
      sessions[session.id] = restoredSlice(session);
    }
    // Salvage can null the active pointer while keeping sessions — the dropped
    // session was the active one. Land on the first surviving tab so a restore
    // never renders the empty state behind a populated strip; the
    // recovered pointer heals main's null on the next write-back.
    const restoredActive = snapshot.activeSessionId ?? snapshot.sessions[0]?.id ?? null;
    set({ boot: "ready", sessions, activeSessionId: restoredActive });
    if (restoredActive !== null) {
      if (snapshot.activeSessionId === null) {
        scheduleActiveWriteBack(get);
      }
      // Only the visible session derives now; the rest stay restored until first
      // activation, so a many-tab relaunch cannot stampede git spawns.
      await deriveSession(set, get, restoredActive);
    }
  },

  activateSession: (id) => {
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    if (get().activeSessionId !== id) {
      set({ activeSessionId: id });
      scheduleActiveWriteBack(get);
    }
    if (slice.needsDerive) {
      void deriveSession(set, get, id);
    }
  },

  closeSession: (sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null || get().sessions[id] === undefined) {
      return;
    }
    // A write-back still in its debounce window would target a session main is
    // about to delete; cancel it rather than send a knowingly stale update.
    const pending = pendingSessionWrites.get(id);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingSessionWrites.delete(id);
    }
    const order = Object.keys(get().sessions);
    const index = order.indexOf(id);
    const neighborId = order[index + 1] ?? order[index - 1] ?? null;
    const remaining = { ...get().sessions };
    delete remaining[id];
    const wasActive = get().activeSessionId === id;
    set(wasActive ? { sessions: remaining, activeSessionId: neighborId } : { sessions: remaining });
    void window.reviewer?.deleteSession({ id });
    if (wasActive && neighborId !== null) {
      // Main nulled its active pointer on delete; the debounced write-back
      // re-points it at the neighbor. Last-tab closes stay null on both sides.
      scheduleActiveWriteBack(get);
      if (get().sessions[neighborId]?.needsDerive === true) {
        void deriveSession(set, get, neighborId);
      }
    }
  },

  reorderSessions: (ids) => {
    const current = get().sessions;
    const reordered: Record<SessionId, SessionSlice> = {};
    for (const id of ids) {
      const slice = current[id];
      if (slice !== undefined) {
        reordered[id] = slice;
      }
    }
    // A session that opened mid-drag isn't in `ids`; keep it at the back rather
    // than dropping it, matching how main resolves the same gap.
    for (const [id, slice] of Object.entries(current)) {
      if (reordered[id] === undefined) {
        reordered[id] = slice;
      }
    }
    set({ sessions: reordered });
    void window.reviewer?.reorderSessions({ ids: Object.keys(reordered) });
  },

  activateTabByOrdinal: (ordinal) => {
    const order = Object.keys(get().sessions);
    const id = ordinal === 9 ? order[order.length - 1] : order[ordinal - 1];
    if (id !== undefined) {
      get().activateSession(id);
    }
  },

  cycleActiveSession: (direction) => {
    const state = get();
    const order = Object.keys(state.sessions);
    const first = order[0];
    if (first === undefined) {
      return;
    }
    const index = state.activeSessionId === null ? -1 : order.indexOf(state.activeSessionId);
    if (index === -1) {
      // Sessions exist but none is active (salvaged store): cycling enters the strip.
      state.activateSession(first);
      return;
    }
    const step = direction === "next" ? 1 : -1;
    const next = order[(index + step + order.length) % order.length];
    if (next !== undefined && next !== state.activeSessionId) {
      state.activateSession(next);
    }
  },

  openRepository: async () => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    const opened = await bridge.openRepo();
    if (!opened.ok) {
      // App-level failure: opening belongs to the shell, so it must not clobber
      // whichever session happens to be active. The banner surfaces it
      // over an active session; the empty state renders it otherwise.
      set({ openFailure: opened.failure });
      return;
    }
    if (opened.value.kind === "canceled") {
      return;
    }
    const repo = opened.value.repo;
    // One tab per repository: re-opening a path that already has a session
    // re-activates its tab — two tabs over one repo would silently fight over
    // the same persisted state through the write-back.
    const existing = Object.values(get().sessions).find((slice) => slice.repo.path === repo.path);
    if (existing !== undefined) {
      set({ openFailure: null });
      get().activateSession(existing.id);
      return;
    }
    // The id comes from main (sessions are main-owned); creation also
    // activates on the main side, so no set-active write-back is needed here.
    const session = await bridge.createSession({ source: { kind: "local", repo } });
    const slice: SessionSlice = {
      id: session.id,
      repo,
      log: { phase: "loading" },
      branches: { phase: "loading" },
      brush: null,
      head: null,
      base: null,
      selection: null,
      diff: { phase: "loading" },
      selectedFilePath: null,
      scrollTop: 0,
      commitSelection: null,
      comments: [],
      layers: [],
      overview: null,
      overviewOpen: false,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
      activeLayerId: null,
      lastChapterId: null,
      activeCommentId: null,
      readFiles: NO_READ_FILES,
      collapsedFiles: NO_COLLAPSED_FILES,
      needsDerive: false,
      requestTicket: 0,
    };
    set({
      sessions: { ...get().sessions, [session.id]: slice },
      activeSessionId: session.id,
      openFailure: null,
    });

    const [log, branches] = await Promise.all([
      bridge.getCommitLog({ repoPath: repo.path, range: null }),
      bridge.listBranches({ repoPath: repo.path }),
    ]);
    // Existence-only, like deriveSession: this fresh slice's log/branches can
    // come from nowhere else, and an interleaved user action (which bumps the
    // diff ticket) must not discard the sources it is waiting on.
    const current = get().sessions[session.id];
    if (current === undefined) {
      return;
    }
    setSlice(set, get, session.id, {
      log: log.ok
        ? { phase: "loaded", entries: log.value.entries }
        : { phase: "failed", failure: log.failure },
      branches: branches.ok
        ? { phase: "loaded", list: branches.value }
        : { phase: "failed", failure: branches.failure },
      // The freshest thing in the repo — the working tree when dirty, the newest
      // commit otherwise — is the selection a reviewer wants first.
      brush: log.ok && log.value.entries.length > 0 ? { anchor: 0, focus: 0 } : null,
      head: branches.ok ? (branches.value.currentBranch ?? branches.value.defaultBranch) : null,
    });
    await runDiffLoad(set, get, session.id);
  },

  openReview: async () => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    await applyReviewOpen(set, get, await bridge.openReview());
  },

  openReviewByPath: async (path) => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    await applyReviewOpen(set, get, await bridge.openReviewByPath({ path }));
  },

  openDroppedFile: async (file) => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    const path = bridge.getPathForFile(file);
    if (path === null) {
      // A File built in JS / not backed by disk: nothing to open. Surface it as a
      // typed failure rather than invoking main with an empty path.
      set({ reviewOpenFailure: { code: "unreadable" } });
      return;
    }
    await get().openReviewByPath(path);
  },

  syncSessions: async () => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    let snapshot: SessionSnapshot;
    try {
      snapshot = await bridge.listSessions();
    } catch (error) {
      // The push is a hint; a failed re-list leaves current state intact rather
      // than blanking the strip (hydrate owns the boot-time failure surface).
      console.error("Session re-list failed:", error);
      return;
    }
    // Rebuild from main's order (new opens append), keeping every already-live
    // slice by identity so a re-list never re-derives or wipes an open session.
    const existing = get().sessions;
    const sessions: Record<SessionId, SessionSlice> = {};
    for (const session of snapshot.sessions) {
      sessions[session.id] = existing[session.id] ?? restoredSlice(session);
    }
    const current = get().activeSessionId;
    const nextActive =
      snapshot.activeSessionId !== null && sessions[snapshot.activeSessionId] !== undefined
        ? snapshot.activeSessionId
        : current !== null && sessions[current] !== undefined
          ? current
          : null;
    set({ boot: "ready", sessions, activeSessionId: nextActive });
    if (nextActive !== null && sessions[nextActive]?.needsDerive === true) {
      await deriveSession(set, get, nextActive);
    }
  },

  previewBrush: (action, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.log?.phase !== "loaded") {
      return;
    }
    const next = brushReducer(slice.brush, action, slice.log.entries.length);
    if (next !== slice.brush) {
      setSlice(set, get, id, { brush: next });
    }
  },

  commitBrush: (sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    if (slice.reviewOrigin !== null) {
      // A review session's brush narrows within the authored diff — the pin stays, so
      // resetting returns to the exact review. A brush over the whole range is the
      // full review, modelled as no subrange so the diff renders via the pin (placing
      // every anchor) rather than an equivalent-but-re-derived commit range.
      const entries = slice.log?.phase === "loaded" ? slice.log.entries : [];
      const subrange =
        slice.brush === null || isFullBrush(entries, slice.brush)
          ? null
          : selectionFromBrush(entries, slice.brush);
      setSlice(set, get, id, { reviewSubrange: subrange });
    }
    scheduleSessionWriteBack(get, id);
    void runDiffLoad(set, get, id);
  },

  applyBrush: (action, sessionId) => {
    get().previewBrush(action, sessionId);
    get().commitBrush(sessionId);
  },

  resetReviewSubrange: (sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.reviewOrigin === null) {
      return;
    }
    // Back to the whole review: no subrange (the diff renders via the pin) and the
    // brush spans every commit so the list reflects it.
    const entries = slice.log?.phase === "loaded" ? slice.log.entries : [];
    setSlice(set, get, id, { reviewSubrange: null, brush: reviewFullBrush(entries) });
    scheduleSessionWriteBack(get, id);
    void runDiffLoad(set, get, id);
  },

  setHead: (branch, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.reviewOrigin !== null || slice.head === branch) {
      return;
    }
    setSlice(set, get, id, { head: branch });
    scheduleSessionWriteBack(get, id);
    void reloadLog(set, get, id);
  },

  setBase: (branch, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.reviewOrigin !== null || slice.base === branch) {
      return;
    }
    // Comparing to yourself is not a comparison; it is the branch's own history, which
    // is what null already means.
    setSlice(set, get, id, { base: branch === slice.head ? null : branch });
    scheduleSessionWriteBack(get, id);
    void reloadLog(set, get, id);
  },

  swapBranches: (sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.base === null || slice.head === null) {
      return;
    }
    setSlice(set, get, id, { base: slice.head, head: slice.base });
    scheduleSessionWriteBack(get, id);
    void reloadLog(set, get, id);
  },

  selectFile: (path, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    // Plain file navigation dismisses the comment step-through: the reader is
    // browsing files now, not walking comments — and it leaves the tour doc, since a
    // picked file is a request to see the diff (the doc's own file chips route here).
    setSlice(set, get, id, {
      selectedFilePath: path,
      activeCommentId: null,
      overviewOpen: false,
    });
    scheduleSessionWriteBack(get, id);
  },

  selectAdjacentFile: (direction, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.diff.phase !== "loaded" || slice.diff.files.length === 0) {
      return;
    }
    const files = slice.diff.files;
    const currentIndex = files.findIndex((file) => file.path === slice.selectedFilePath);
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : files.length - 1
        : Math.min(Math.max(currentIndex + direction, 0), files.length - 1);
    const next = files[nextIndex];
    if (next && next.path !== slice.selectedFilePath) {
      // j/k is plain file navigation — it dismisses the comment step-through.
      setSlice(set, get, id, {
        selectedFilePath: next.path,
        activeCommentId: null,
        overviewOpen: false,
      });
      scheduleSessionWriteBack(get, id);
    }
  },

  setScrollTop: (scrollTop, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null || !Number.isFinite(scrollTop)) {
      return;
    }
    setSlice(set, get, id, { scrollTop: Math.max(0, scrollTop) });
    scheduleSessionWriteBack(get, id);
  },

  addComment: (anchor, body, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    const trimmed = body.trim();
    if (trimmed === "") {
      return;
    }
    // The app stamps identity for a manual comment exactly as importReview does
    // for an imported one: a fresh uuid via Web Crypto in the renderer.
    // safeParse is the final gate — a malformed anchor (which the schema's
    // ascending/positive refinements reject) never becomes stored state that a
    // write-back would then fail to persist.
    const parsed = Comment.safeParse({
      ...anchor,
      body: trimmed,
      id: crypto.randomUUID(),
    });
    if (!parsed.success) {
      return;
    }
    setSlice(set, get, id, { comments: [...slice.comments, parsed.data] });
    scheduleSessionWriteBack(get, id);
  },

  editComment: (commentId, body, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    const trimmed = body.trim();
    if (trimmed === "" || !slice.comments.some((comment) => comment.id === commentId)) {
      return;
    }
    setSlice(set, get, id, {
      comments: slice.comments.map((comment) =>
        comment.id === commentId ? { ...comment, body: trimmed } : comment,
      ),
    });
    scheduleSessionWriteBack(get, id);
  },

  discardComment: (commentId, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    const remaining = slice.comments.filter((comment) => comment.id !== commentId);
    if (remaining.length === slice.comments.length) {
      return;
    }
    // Never leave the focus pointing at a comment that no longer exists — the
    // counter would read a phantom position and the ring would target nothing.
    setSlice(set, get, id, {
      comments: remaining,
      ...(slice.activeCommentId === commentId ? { activeCommentId: null } : {}),
    });
    scheduleSessionWriteBack(get, id);
  },

  setActiveLayer: (layerId, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || (slice.activeLayerId === layerId && !slice.overviewOpen)) {
      return;
    }
    // No write-back: the active layer is a derived view, never a persisted input
    // (it is absent from `persistedSession`), so soloing costs zero bridge calls
    // and a relaunch always reopens on the full diff.
    setSlice(set, get, id, {
      activeLayerId: layerId,
      overviewOpen: false,
      ...(layerId === null ? {} : { lastChapterId: layerId }),
    });
  },

  openOverview: (sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.overview === null) {
      return;
    }
    // The doc is a stop, not an overlay: it clears the solo rather than hiding it, so
    // there is exactly one selected row in the rail and no remembered state to surprise
    // the reader when they come back down into the diff. `lastChapterId` is untouched —
    // it is the doc's own scroll target, so returning lands on the layer just read.
    setSlice(set, get, id, { overviewOpen: true, activeLayerId: null });
  },

  closeOverview: (sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || !slice.overviewOpen) {
      return;
    }
    setSlice(set, get, id, { overviewOpen: false });
  },

  stepLayer: (direction, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    const layers = sliceLayers(slice);
    if (slice.overviewOpen) {
      // From stop zero, forward enters the first chapter; back is the start of the
      // walkthrough, so it stays put rather than wrapping to the end.
      const first = direction === 1 ? (layers[0]?.id ?? null) : null;
      if (first !== null) {
        setSlice(set, get, id, {
          activeLayerId: first,
          overviewOpen: false,
          lastChapterId: first,
        });
      }
      return;
    }
    // Stepping back off the first chapter returns to the doc — the walkthrough's real
    // first stop — instead of dead-ending where the reader can still go somewhere.
    if (
      direction === -1 &&
      slice.overview !== null &&
      slice.activeLayerId !== null &&
      layers[0]?.id === slice.activeLayerId
    ) {
      setSlice(set, get, id, { overviewOpen: true, activeLayerId: null });
      return;
    }
    const next = stepLayerId(layers, slice.activeLayerId, direction);
    if (next === null || next === slice.activeLayerId) {
      return;
    }
    setSlice(set, get, id, { activeLayerId: next, lastChapterId: next });
  },

  focusComment: (commentId, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    const comment = slice.comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) {
      return;
    }
    // A soloed layer that doesn't cover the target's file would leave its
    // annotation unmounted, so there'd be nothing to scroll to; clear the solo
    // first (the panel lists every comment, soloed-out ones included). The full
    // diff is unaffected, so this only fires when a solo is actually hiding it.
    const layers = sliceLayers(slice);
    const clearsSolo =
      slice.activeLayerId !== null &&
      slice.diff.phase === "loaded" &&
      !soloFiles(slice.diff.files, findLayer(layers, slice.activeLayerId), layers).some(
        (file) => file.path === comment.file,
      );
    // A folded file renders no lines, so its comment cards are not mounted and there is
    // nothing to scroll to — the same reason a solo that hides the file is cleared above.
    // Unfold it rather than refuse the jump: the reader asked for this finding.
    const collapsedFiles = withCollapsed(slice.collapsedFiles, [comment.file], false);
    // The active id is ephemeral (no write-back); the file focus moves with it so
    // the tree and j/k stay on the comment's file — that half persists.
    setSlice(set, get, id, {
      activeCommentId: commentId,
      selectedFilePath: comment.file,
      ...(collapsedFiles === slice.collapsedFiles ? {} : { collapsedFiles }),
      // Stepping to a comment is diff navigation, so it leaves the doc — the card is
      // about to be scrolled to, and it lives on the diff surface.
      overviewOpen: false,
      ...(clearsSolo ? { activeLayerId: null } : {}),
    });
    scheduleSessionWriteBack(get, id);
  },

  stepComment: (direction, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.diff.phase !== "loaded") {
      return;
    }
    // Walk the file set the surface actually shows: a soloed layer restricts both
    // the diff and this walk, so `n`/`p` never jumps to a comment that isn't on
    // screen. `frozen` places every anchor; otherwise placement is positional.
    const frozen = slice.reviewDiff?.kind === "frozenPatch";
    const layers = sliceLayers(slice);
    const visible = soloFiles(slice.diff.files, findLayer(layers, slice.activeLayerId), layers);
    const entries = navigableEntries(orderedComments(visible, slice.comments, frozen));
    if (entries.length === 0) {
      return;
    }
    const current =
      slice.activeCommentId === null ? -1 : indexOfComment(entries, slice.activeCommentId);
    // From nowhere, forward lands on the first comment and backward on the last;
    // otherwise step and wrap so the ends meet (the counter makes the wrap legible).
    const nextIndex =
      current === -1
        ? direction === 1
          ? 0
          : entries.length - 1
        : (current + direction + entries.length) % entries.length;
    const next = entries[nextIndex];
    if (next !== undefined) {
      get().focusComment(next.comment.id, id);
    }
  },

  clearActiveComment: (sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    setSlice(set, get, id, { activeCommentId: null });
  },

  setFileRead: (path, read, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.diff.phase !== "loaded") {
      return;
    }
    const file = slice.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
      return;
    }
    applyRead(set, get, id, [file], read);
  },

  toggleFileRead: (path, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.diff.phase !== "loaded") {
      return;
    }
    // No argument means the file the reader is on — the one j/k and the tree agree is
    // focused, which is the only file `r` could sensibly mean.
    const target = path ?? slice.selectedFilePath;
    const file = slice.diff.files.find((candidate) => candidate.path === target);
    if (file === undefined) {
      return;
    }
    applyRead(set, get, id, [file], !isFileRead(slice.readFiles, file));
  },

  setLayerRead: (layerId, read, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.diff.phase !== "loaded") {
      return;
    }
    const layers = sliceLayers(slice);
    const layer = findLayer(layers, layerId);
    if (layer === null) {
      return;
    }
    // The extent, via the same `soloFiles` the diff and the tree render — so "mark this
    // chapter read" covers exactly what soloing it puts on screen, no more.
    applyRead(set, get, id, soloFiles(slice.diff.files, layer, layers), read);
  },

  clearFilesRead: (paths, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.diff.phase !== "loaded") {
      return;
    }
    const wanted = new Set(paths);
    applyRead(
      set,
      get,
      id,
      slice.diff.files.filter((file) => wanted.has(file.path)),
      false,
    );
  },

  setFileCollapsed: (path, collapsed, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    // Folding alone, leaving the read mark exactly as it was: a reader who opens a
    // finished file back up has not un-finished it, and one who folds an unread file away
    // has not claimed to have read it.
    const collapsedFiles = withCollapsed(slice.collapsedFiles, [path], collapsed);
    if (collapsedFiles !== slice.collapsedFiles) {
      setSlice(set, get, id, { collapsedFiles });
    }
  },

  clearOpenFailure: () => {
    set({ openFailure: null });
  },

  clearReviewOpenFailure: () => {
    set({ reviewOpenFailure: null });
  },

  clearReviewExportFailure: () => {
    set({ reviewExportFailure: null });
  },

  setDiffStyle: (style) => {
    set({ diffStyle: style });
  },

  exportReviewJson: async (sessionId) => {
    const bridge = window.reviewer;
    const id = sessionId ?? get().activeSessionId;
    if (!bridge || id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    const origin = await resolveExportOrigin(bridge, slice);
    if (origin === "nothing") {
      return;
    }
    if (origin === "diffUnreadable") {
      set({ reviewExportFailure: { kind: "diffUnreadable" } });
      return;
    }
    const artifact = serializeReview({
      repo: origin.repo,
      base: origin.base,
      head: origin.head,
      patch: origin.patch,
      overview: slice.overview,
      comments: slice.comments,
      layers: slice.layers,
    });
    const response = await bridge.saveReviewJson({
      content: `${JSON.stringify(artifact, null, 2)}\n`,
      defaultName: `${reviewFileBase(slice.repo.name)}.reviewer.json`,
    });
    // A cancel or a successful write clears any prior failure; a failed write
    // surfaces — never swallowed, or the reviewer thinks the review was saved.
    set({ reviewExportFailure: response.ok ? null : { kind: "write", failure: response.failure } });
  },

  exportReviewMarkdown: async (sessionId) => {
    const bridge = window.reviewer;
    const id = sessionId ?? get().activeSessionId;
    if (!bridge || id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined) {
      return;
    }
    const origin = await resolveExportOrigin(bridge, slice);
    if (origin === "nothing") {
      return;
    }
    if (origin === "diffUnreadable") {
      set({ reviewExportFailure: { kind: "diffUnreadable" } });
      return;
    }
    // "Frozen" keys off the exported artifact's own patch, not the `reviewDiff`
    // render pin (which is cleared once the reviewer navigates to their own diff):
    // an artifact carrying an embedded patch places every anchor, so its comments
    // are never outdated regardless of what diff is on screen. A refs export
    // resolves against the loaded diff — best effort; with none loaded (or after
    // navigating away) its comments flag outdated, the honest "no authored diff to
    // place against right now" state rather than a silent claim they place.
    const frozen = origin.patch !== null;
    const files = slice.diff.phase === "loaded" ? slice.diff.files : [];
    const comments = markdownCommentsFrom(slice.comments, files, frozen);
    const response = await bridge.saveReviewMarkdown({
      content: reviewToMarkdown({
        repo: origin.repo,
        base: origin.base,
        head: origin.head,
        overview: slice.overview,
        layers: slice.layers,
        comments,
      }),
      defaultName: `${reviewFileBase(slice.repo.name)}.md`,
    });
    set({ reviewExportFailure: response.ok ? null : { kind: "write", failure: response.failure } });
  },

  flushWriteBacks: () => {
    for (const [sessionId, timer] of pendingSessionWrites) {
      clearTimeout(timer);
      sendSessionWriteBack(get, sessionId);
    }
    pendingSessionWrites.clear();
    if (pendingActiveWrite !== null) {
      clearTimeout(pendingActiveWrite);
      pendingActiveWrite = null;
      sendActiveWriteBack(get);
    }
  },
}));
