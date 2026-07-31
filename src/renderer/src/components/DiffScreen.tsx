import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { assertNever } from "../../../shared/assert";
import type { DiffSelection } from "../../../shared/git";
import type { Comment, ReviewLayer } from "../../../shared/review";
import type { SessionId } from "../../../shared/session";
import { emptySoloReason, layerOutline } from "../../../shared/layers";
import { useFitToContent } from "@/lib/fit-panel";
import { unplaceableComments } from "../../../shared/diff/comment-annotations";
import { isFullyRead, NO_COLLAPSED_FILES, NO_READ_FILES, tallyRead } from "@/lib/read-progress";
import { resolveExpandLoader } from "@/lib/diff/expand-context";
import { DiffView } from "@/components/DiffView";
import { LayerIntro } from "@/components/LayerIntro";
import { UnplaceableComments } from "@/components/UnplaceableComments";
import { GitFailureText } from "@/components/GitFailureText";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { selectActiveSlice, selectSoloedDiff, useReviewStore } from "@/stores/review";
import { useUiPrefsStore } from "@/stores/ui-prefs";

// A stable empty array: a fresh [] per render would make the comments selector
// return a new reference each time and re-render the screen in a loop.
const EMPTY_COMMENTS: Comment[] = [];
const EMPTY_LAYERS: ReviewLayer[] = [];

function LoadingState(): ReactElement {
  return (
    <div aria-label="Loading diff" className="flex h-full flex-col gap-2 p-6" role="status">
      <Skeleton className="mb-2 h-7 w-72 bg-border" />
      <Skeleton className="h-4 w-2/3 bg-border" />
      <Skeleton className="h-4 w-full bg-border" />
      <Skeleton className="h-4 w-5/6 bg-border" />
      <Skeleton className="h-4 w-3/4 bg-border" />
      <Skeleton className="mt-6 mb-2 h-7 w-56 bg-border" />
      <Skeleton className="h-4 w-4/5 bg-border" />
      <Skeleton className="h-4 w-full bg-border" />
      <Skeleton className="h-4 w-2/3 bg-border" />
    </div>
  );
}

type TerminalStateProps = {
  title: string | null;
  message: ReactNode;
  /** The open-repository escape hatch belongs to repo-level dead ends; a clean
   * diff between two picked refs is resolved in the selection panel instead. */
  withOpenAction: boolean;
};

/** Empty and failed share one anatomy: a message and, at dead ends, an escape hatch. */
function TerminalState({ title, message, withOpenAction }: TerminalStateProps): ReactElement {
  const openRepository = useReviewStore((state) => state.openRepository);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="max-w-96 text-center">
        {/* Hierarchy from size + full ink over the muted body; weight stays 400. */}
        {title !== null && <h2 className="text-base">{title}</h2>}
        <p className="mt-1 text-sm text-text-muted">{message}</p>
      </div>
      {withOpenAction && (
        <Button variant="outline" onClick={() => void openRepository()}>
          Open repository
        </Button>
      )}
    </div>
  );
}

/** Bind a session action to one session id for as long as that id is the active one.
 *
 * Every action in the store already takes an optional trailing `sessionId` and defaults to
 * the active session, so this is not about *reaching* a slice — it is about *when* the
 * slice is chosen. Captured here at render time, a callback handed to `DiffView` acts on
 * the session that view was mounted for, which is the same id the view is keyed on: a
 * scroll or a comment that lands after a tab switch (the debounced scroll report is the
 * routine case) writes to the session it came from rather than to whatever is on screen
 * when it arrives. Resolving at call time — passing the action straight through — would
 * silently move those writes to the new tab.
 *
 * Sessionless, the callback is inert: there is no session for the gesture to be about, and
 * every one of these comes from a surface that only exists inside one.
 *
 * The id goes on the end of whatever the callback is *called* with, so a bound action must
 * be invoked rather than handed over: `onClick={onClose}` passes React's event as the first
 * argument, which on a zero-argument action lands in the `sessionId` slot and the write is
 * swallowed by `withSlice`. Every surface below wraps (`() => onStepComment(-1)`), which is
 * also how the store's actions are called everywhere they are read directly. */
function useSessionBound<A extends unknown[]>(
  fn: (...args: [...A, SessionId]) => void,
  sessionId: SessionId | null,
): (...args: A) => void {
  return useCallback(
    (...args: A) => {
      if (sessionId !== null) {
        fn(...args, sessionId);
      }
    },
    [fn, sessionId],
  );
}

/** A clean diff reads differently per selection: branch mode names both sides. The
 * refs set in the shell sans like every other ref in the app — mono is for code, and a
 * branch name is a name. */
function emptyDiffMessage(selection: DiffSelection | null): ReactNode {
  if (selection === null) {
    return "Nothing to select in this repository.";
  }
  if (selection.kind === "branches") {
    return `No changes between ${selection.base} and ${selection.head}.`;
  }
  return "No changes.";
}

/** Everything right of the sidebar once a repository is open. All diff-pane states
 * sit on the Pierre content surface so the pane colour never changes between them. */
export function DiffScreen(): ReactElement | null {
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const diff = useReviewStore((state) => selectActiveSlice(state)?.diff ?? null);
  const repoPath = useReviewStore((state) => selectActiveSlice(state)?.repo.path ?? null);
  const selection = useReviewStore((state) => selectActiveSlice(state)?.selection ?? null);
  const selectedFilePath = useReviewStore(
    (state) => selectActiveSlice(state)?.selectedFilePath ?? null,
  );
  const scrollTop = useReviewStore((state) => selectActiveSlice(state)?.scrollTop ?? 0);
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const layers = useReviewStore((state) => selectActiveSlice(state)?.layers ?? EMPTY_LAYERS);
  const activeLayerId = useReviewStore((state) => selectActiveSlice(state)?.activeLayerId ?? null);
  const activeCommentId = useReviewStore(
    (state) => selectActiveSlice(state)?.activeCommentId ?? null,
  );
  // Solo: the active layer restricts the diff to its files across both the code view and
  // the tree. One derivation for the whole app (`lib/soloed-diff.ts`), read here as a
  // subscription — the rail reads the same object, so there is no second definition of the
  // layer's file set to drift, and the stable subset identity keeps DiffView from
  // rebuilding its items every render.
  const soloed = useReviewStore(selectSoloedDiff);
  // Whether this review carries a tour doc: the chapter band then shows the breadcrumb
  // back to it, and stepping back off the first chapter lands there.
  const hasOverview = useReviewStore((state) => selectActiveSlice(state)?.overview != null);
  // A frozen review pins its embedded patch: its anchors place directly, never
  // re-resolved against a re-derived diff.
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  // A review session narrowed to a subset of its commits: comments outside that
  // subset are stranded by the narrowing, not by drift, so the unplaceable bar reads
  // and resolves differently (widen back, don't discard).
  const reviewSubrange = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewSubrange ?? null,
  );
  const readFiles = useReviewStore((state) => selectActiveSlice(state)?.readFiles ?? NO_READ_FILES);
  const collapsedPaths = useReviewStore(
    (state) => selectActiveSlice(state)?.collapsedFiles ?? NO_COLLAPSED_FILES,
  );
  const setLayerRead = useReviewStore((state) => state.setLayerRead);
  const setFileCollapsed = useReviewStore((state) => state.setFileCollapsed);
  const resetReviewSubrange = useReviewStore((state) => state.resetReviewSubrange);
  // An app-wide preference, so it comes from the prefs store rather than the review store —
  // it outlives every session here and is persisted on its own (stores/ui-prefs).
  const diffStyle = useUiPrefsStore((state) => state.diffStyle);
  const setScrollTop = useReviewStore((state) => state.setScrollTop);
  const addComment = useReviewStore((state) => state.addComment);
  const editComment = useReviewStore((state) => state.editComment);
  const discardComment = useReviewStore((state) => state.discardComment);
  const stepComment = useReviewStore((state) => state.stepComment);
  const clearActiveComment = useReviewStore((state) => state.clearActiveComment);
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  // The chapter band's own two verbs, resolved here rather than there: the band is a
  // presentational band like `DiffView` beside it, and this screen is what reads the store
  // for both of them (the data rule, `ReviewRail.tsx`).
  const stepLayer = useReviewStore((state) => state.stepLayer);
  const selectFile = useReviewStore((state) => state.selectFile);
  // Collapsing the prose drops the resize panel entirely (nothing to size), so the
  // parent — not LayerIntro — owns this.
  const [layerIntroCollapsed, setLayerIntroCollapsed] = useState(false);

  // Everything the diff surface can do, bound to the active id — which is also DiffView's
  // mount key, so each stays stable for the mounted view and its writes land in the session
  // the gesture was made in (see `useSessionBound` above for why that is not the same as
  // letting the action default to the active session).
  const onScrollTop = useSessionBound(setScrollTop, activeSessionId);
  const onAddComment = useSessionBound(addComment, activeSessionId);
  const onEditComment = useSessionBound(editComment, activeSessionId);
  const onDiscardComment = useSessionBound(discardComment, activeSessionId);
  const onStepComment = useSessionBound(stepComment, activeSessionId);
  const onClearActiveComment = useSessionBound(clearActiveComment, activeSessionId);
  const onSetFileCollapsed = useSessionBound(setFileCollapsed, activeSessionId);
  const onResetReviewSubrange = useSessionBound(resetReviewSubrange, activeSessionId);

  const loadedFiles = diff !== null && diff.phase === "loaded" ? diff.files : null;
  // Comments the re-derived diff has no line to host: kept in state, shown
  // nowhere on the surface — the count bar makes them discoverable. Resolved
  // against the full loaded set, never the soloed subset, so soloing a layer never
  // reclassifies another file's comments as unplaceable.
  const unplaceable = useMemo(
    () => unplaceableComments(loadedFiles ?? [], comments),
    [loadedFiles, comments],
  );
  // The authored layers plus the inferred "not covered by layers" layer (so soloing that
  // synthetic row restricts the code view to the skipped files just like an authored one),
  // the active one resolved against that list, and the subset it leaves on screen — empty
  // for every diff phase that has no files.
  const { layers: effLayers, activeLayer, files: visibleFiles } = soloed;
  // What each authored layer is and the number it wears — the same outline the rail and
  // the doc read, so the band's number and breadcrumb can never disagree with theirs.
  const outline = useMemo(() => layerOutline(layers), [layers]);
  // The soloed chapter's own progress. `visibleFiles` IS the layer's extent whenever one
  // is soloed, so the band's ring counts exactly what the band's chapter put on screen —
  // no second definition of "this layer's files" to fall out of step with the rail's.
  const layerTally = useMemo(() => tallyRead(visibleFiles, readFiles), [visibleFiles, readFiles]);
  // The intro's file-link resolution + navigation set. Memoised on the stable
  // subset so LayerIntro's own derived state (the diff-file Set, the parsed
  // description) holds across renders instead of rebuilding every time.
  const visibleFilePaths = useMemo(() => visibleFiles.map((file) => file.path), [visibleFiles]);
  // Context expansion: a loader only when a live repo backs a two-ref
  // selection, else null so the expander is absent and no git read can fire. Stable
  // across expands (Pierre hydrates the diff in place), so the diff never rebuilds
  // its options mid-expansion — scroll and layer stepping stay owned by DiffView.
  const loadDiffFiles = useMemo(
    () =>
      resolveExpandLoader({
        frozen,
        repoPath,
        selection,
        fetch: window.reviewer?.getFileContents ?? null,
      }),
    [frozen, repoPath, selection],
  );

  // The intro band hugs its prose: on each fresh expand and each layer switch the
  // panel re-fits to the description's own height, capped at half the diff viewport
  // so a long one scrolls within instead of burying the code. The seam handle can
  // still override that until the next expand or layer change recomputes it.
  const introExpanded = diff?.phase === "loaded" && activeLayer !== null && !layerIntroCollapsed;
  const introFit = useFitToContent({ enabled: introExpanded, refitOn: activeLayerId });

  if (diff === null) {
    return null;
  }
  switch (diff.phase) {
    case "idle":
      return null;
    case "loading":
      return (
        <div className="h-full bg-diff-surface">
          <LoadingState />
        </div>
      );
    case "failed":
      return (
        <div className="h-full bg-diff-surface">
          <TerminalState
            title="Diff unavailable"
            message={<GitFailureText failure={diff.failure} />}
            withOpenAction={true}
          />
        </div>
      );
    case "empty":
      return (
        <div className="h-full bg-diff-surface">
          <TerminalState
            title={null}
            message={emptyDiffMessage(selection)}
            withOpenAction={selection === null}
          />
        </div>
      );
    case "unreadable":
      return (
        <div className="h-full bg-diff-surface">
          <TerminalState
            title="Diff unavailable"
            message="The diff could not be parsed."
            withOpenAction={true}
          />
        </div>
      );
    case "loaded": {
      // Soloed to the active layer's subset when one is active; the full diff otherwise.
      const layerFiles = visibleFiles;
      // Sits directly above the diff — below the chapter band, not above it — in
      // every loaded layout, so a stranded comment reads as belonging to the code it
      // drifted off, not to the layer heading; null (absent) when none.
      const unplaceableBar = (
        <UnplaceableComments
          comments={unplaceable}
          onDiscard={onDiscardComment}
          narrowed={reviewSubrange !== null}
          onReset={onResetReviewSubrange}
        />
      );
      // Keyed per session: CodeView keeps id-keyed internal state, and item ids are
      // file paths two repos routinely share (readme.md) — a fresh instance per
      // session keeps that state from crossing tabs. Highlight correctness is
      // separate: the pool caches by fileDiff.cacheKey, made collision-free in
      // parsePatch.
      const diffView = (
        <DiffView
          key={activeSessionId}
          files={layerFiles}
          comments={comments}
          frozen={frozen}
          selectedFilePath={selectedFilePath}
          diffStyle={diffStyle}
          restoreScrollTop={scrollTop}
          activeLayerId={activeLayerId}
          activeCommentId={activeCommentId}
          collapsedPaths={collapsedPaths}
          onSetFileCollapsed={onSetFileCollapsed}
          loadDiffFiles={loadDiffFiles}
          onScrollTop={onScrollTop}
          onAddComment={onAddComment}
          onEditComment={onEditComment}
          onDiscardComment={onDiscardComment}
          onStepComment={onStepComment}
          onClearActiveComment={onClearActiveComment}
        />
      );
      // The active layer's chapter intro reads its description at width. In
      // `fill` mode it fills the resizable panel's dragged height; otherwise it is a
      // content-height band. filePaths is the visible (soloed) set, so its file
      // links resolve to and navigate within what is actually on screen.
      const renderIntro = (fill: boolean): ReactElement | null => {
        if (activeLayer === null) {
          return null;
        }
        // The inferred layer is not an authored step, so it carries no number and hangs
        // off nothing; the chevrons still walk it (last in the effective order) so prev
        // reaches the real layers and next is a dead end.
        const entry = outline.find((candidate) => candidate.layer.id === activeLayer.id) ?? null;
        const index = effLayers.findIndex((layer) => layer.id === activeLayer.id);
        return (
          <LayerIntro
            layer={activeLayer}
            ordinal={entry?.ordinal ?? null}
            // With a tour doc, "previous" from the first layer is the doc itself — the
            // review's real first stop — so the chevron only dead-ends without one.
            hasPrev={index > 0 || (hasOverview && index === 0)}
            hasNext={index >= 0 && index < effLayers.length - 1}
            onStepLayer={stepLayer}
            readTally={layerTally}
            onToggleRead={() => setLayerRead(activeLayer.id, !isFullyRead(layerTally))}
            filePaths={visibleFilePaths}
            onSelectFile={selectFile}
            collapsed={layerIntroCollapsed}
            onToggleCollapsed={() => setLayerIntroCollapsed((value) => !value)}
            fill={fill}
            fit={introFit.content}
          />
        );
      };
      // A soloed layer resolves to zero visible files in two distinct ways: its files all
      // drifted out of the diff, or it names no code at all — `emptySoloReason` tells them
      // apart so the copy never reads an empty layer as a broken one. Either way, name the
      // state and offer the escape back to the full diff; the layer stays listed and
      // steppable in the panel, never dropped.
      if (activeLayer !== null && visibleFiles.length === 0) {
        const reason = emptySoloReason(activeLayer, effLayers);
        return (
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1 flex-col bg-diff-surface">
              {renderIntro(false)}
              {unplaceableBar}
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
                <div className="max-w-96 text-center">
                  <h2 className="text-base">
                    {reason === "empty"
                      ? "Nothing to show for this layer"
                      : "Layer not in this diff"}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">
                    {reason === "empty"
                      ? "This layer points at no code."
                      : "This layer’s files are no longer in the current diff."}
                  </p>
                </div>
                <Button variant="outline" onClick={() => setActiveLayer(null)}>
                  Show all files
                </Button>
              </div>
            </div>
          </div>
        );
      }
      // Resize the intro against the diff only when there is prose to size: an
      // expanded band gets the vertical panel group; no layer or a collapsed band
      // falls back to the plain stack (intro is then just its header, or absent).
      const resizableIntro = activeLayer !== null && !layerIntroCollapsed;
      return (
        <div className="flex h-full flex-col">
          {resizableIntro ? (
            <ResizablePanelGroup
              orientation="vertical"
              {...introFit.group}
              className="min-h-0 flex-1 bg-diff-surface"
            >
              <ResizablePanel
                id="intro"
                {...introFit.panel}
                defaultSize="50%"
                minSize="96px"
                groupResizeBehavior="preserve-pixel-size"
              >
                {renderIntro(true)}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="diff" minSize="160px">
                <div className="flex h-full min-h-0 flex-col">
                  {unplaceableBar}
                  <div className="min-h-0 flex-1">{diffView}</div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col bg-diff-surface">
              {renderIntro(false)}
              {unplaceableBar}
              <div className="min-h-0 flex-1">{diffView}</div>
            </div>
          )}
        </div>
      );
    }
    default:
      return assertNever(diff);
  }
}
