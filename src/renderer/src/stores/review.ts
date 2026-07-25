import { create } from "zustand";
import { assertNever } from "../../../shared/assert";
import type {
  BranchList,
  BranchName,
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
  type ReviewSource,
} from "../../../shared/review";
import type { ReviewOpenFailure, ReviewOpenResponse } from "../../../shared/review-open";
import type { SelectionMode, Session, SessionId, SessionSnapshot } from "../../../shared/session";
import { parsePatch, type PatchFile } from "../lib/diff/patch";
import { findLayer, soloFiles, stepLayer as stepLayerId } from "../lib/layers";
import { effectiveLayers } from "../lib/coverage";
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
  mode: SelectionMode;
  log: LogState | null;
  branches: BranchesState | null;
  brush: BrushRange | null;
  base: BranchName | null;
  head: BranchName | null;
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
  /** The authored source + patch this session was opened from: what the
   * round-trip export re-emits as the artifact `source`. Stable — unlike
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
  setMode: (mode: SelectionMode, sessionId?: SessionId) => void;
  /** Moves the brush without touching the diff — drag feedback between pointerdown
   * and pointerup; `commitBrush` (or any loading action) makes it real. */
  previewBrush: (action: BrushAction, sessionId?: SessionId) => void;
  commitBrush: (sessionId?: SessionId) => void;
  applyBrush: (action: BrushAction, sessionId?: SessionId) => void;
  /** Clear a review session's commit subrange back to the whole review: the diff
   * returns to the authored pin (frozen or refs) so every comment places again. */
  resetReviewSubrange: (sessionId?: SessionId) => void;
  setBase: (branch: BranchName, sessionId?: SessionId) => void;
  setHead: (branch: BranchName, sessionId?: SessionId) => void;
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
   * `scrollTop` are left untouched — the diff the session persists never moves. */
  setActiveLayer: (layerId: string | null, sessionId?: SessionId) => void;
  /** Walk the authored layer order, clamping at both ends; snappy and additive,
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
  if (slice.mode === "commits") {
    if (slice.log === null || slice.log.phase === "loading") {
      return { kind: "nothing" };
    }
    if (slice.log.phase === "failed") {
      return { kind: "blocked", failure: slice.log.failure };
    }
    if (slice.brush === null) {
      return { kind: "nothing" };
    }
    const selection = selectionFromBrush(slice.log.entries, slice.brush);
    return selection === null ? { kind: "nothing" } : { kind: "selection", selection };
  }
  if (slice.branches === null || slice.branches.phase === "loading") {
    return { kind: "nothing" };
  }
  if (slice.branches.phase === "failed") {
    return { kind: "blocked", failure: slice.branches.failure };
  }
  if (slice.base === null || slice.head === null) {
    return { kind: "nothing" };
  }
  return { kind: "selection", selection: { kind: "branches", base: slice.base, head: slice.head } };
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
 * surfaced rather than silently dropped. */
type ExportOrigin = { source: ReviewSource; patch: string | null };
type ExportResolution = ExportOrigin | "nothing" | "diffUnreadable";

async function resolveExportOrigin(
  bridge: ReviewerBridge,
  slice: SessionSlice,
): Promise<ExportResolution> {
  if (slice.reviewOrigin !== null) {
    return { source: slice.reviewOrigin.source, patch: slice.reviewOrigin.patch };
  }
  if (slice.selection === null) {
    return "nothing";
  }
  const plan = exportSourceFor(slice.selection, slice.repo, headShaOf(slice.log));
  if (!plan.needsPatch) {
    return { source: plan.source, patch: null };
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
  return { source: plan.source, patch: patch.length > 0 ? patch : null };
}

/** Inputs only — log/branches/diff are re-derived on load and never cross IPC. */
function persistedSession(slice: SessionSlice): Session {
  return {
    id: slice.id,
    source: { kind: "local", repo: slice.repo },
    mode: slice.mode,
    base: slice.base,
    head: slice.head,
    commitSelection: slice.commitSelection,
    selectedFilePath: slice.selectedFilePath,
    scrollTop: slice.scrollTop,
    comments: slice.comments,
    layers: slice.layers,
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
    mode: session.mode,
    log: null,
    branches: null,
    brush: null,
    base: session.base,
    head: session.head,
    selection: null,
    diff: { phase: "idle" },
    selectedFilePath: session.selectedFilePath,
    scrollTop: session.scrollTop,
    commitSelection: session.commitSelection,
    comments: session.comments,
    layers: session.layers,
    reviewDiff: session.reviewDiff,
    reviewSubrange: session.reviewSubrange,
    reviewOrigin: session.reviewOrigin,
    activeLayerId: null,
    activeCommentId: null,
    needsDerive: true,
    requestTicket: 0,
  };
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
  // HEAD (range null). The pin still renders the diff, so a failed ranged log only
  // costs the reviewer the ability to narrow, never the review itself.
  const range =
    slice.reviewOrigin !== null
      ? { base: slice.reviewOrigin.source.base, head: slice.reviewOrigin.source.head }
      : null;
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
          ? recoverBrush(log.value.entries, current.commitSelection)
          : null,
    reviewSubrange: review !== null ? review.reviewSubrange : current.reviewSubrange,
    // Persisted picks win; only a never-chosen side gets the fresh-open default.
    base: current.base ?? (branches.ok ? branches.value.defaultBranch : null),
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

function recoverBrush(
  entries: LogEntry[],
  commitSelection: CommitSelection | null,
): BrushRange | null {
  if (commitSelection === null) {
    // Nothing was ever selected — restore like a fresh open: the newest entry.
    return entries.length > 0 ? { anchor: 0, focus: 0 } : null;
  }
  return brushFromSelection(entries, commitSelection);
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
      mode: "commits",
      log: { phase: "loading" },
      branches: { phase: "loading" },
      brush: null,
      base: null,
      head: null,
      selection: null,
      diff: { phase: "loading" },
      selectedFilePath: null,
      scrollTop: 0,
      commitSelection: null,
      comments: [],
      layers: [],
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
      activeLayerId: null,
      activeCommentId: null,
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
      base: branches.ok ? branches.value.defaultBranch : null,
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

  setMode: (mode, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    const slice = get().sessions[id];
    if (slice === undefined || slice.mode === mode) {
      return;
    }
    // Repo-session only: a review session has no mode switch (its selector is scoped
    // to the review), so this never fires against a pinned diff.
    setSlice(set, get, id, { mode });
    scheduleSessionWriteBack(get, id);
    void runDiffLoad(set, get, id);
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

  setBase: (branch, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    setSlice(set, get, id, { base: branch });
    scheduleSessionWriteBack(get, id);
    void runDiffLoad(set, get, id);
  },

  setHead: (branch, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    setSlice(set, get, id, { head: branch });
    scheduleSessionWriteBack(get, id);
    void runDiffLoad(set, get, id);
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
    void runDiffLoad(set, get, id);
  },

  selectFile: (path, sessionId) => {
    const id = sessionId ?? get().activeSessionId;
    if (id === null) {
      return;
    }
    // Plain file navigation dismisses the comment step-through: the reader is
    // browsing files now, not walking comments.
    setSlice(set, get, id, { selectedFilePath: path, activeCommentId: null });
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
      setSlice(set, get, id, { selectedFilePath: next.path, activeCommentId: null });
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
    if (slice === undefined || slice.activeLayerId === layerId) {
      return;
    }
    // No write-back: the active layer is a derived view, never a persisted input
    // (it is absent from `persistedSession`), so soloing costs zero bridge calls
    // and a relaunch always reopens on the full diff.
    setSlice(set, get, id, { activeLayerId: layerId });
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
    const next = stepLayerId(sliceLayers(slice), slice.activeLayerId, direction);
    if (next === null || next === slice.activeLayerId) {
      return;
    }
    setSlice(set, get, id, { activeLayerId: next });
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
    // The active id is ephemeral (no write-back); the file focus moves with it so
    // the tree and j/k stay on the comment's file — that half persists.
    setSlice(set, get, id, {
      activeCommentId: commentId,
      selectedFilePath: comment.file,
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
      source: origin.source,
      patch: origin.patch,
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
        source: origin.source,
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
