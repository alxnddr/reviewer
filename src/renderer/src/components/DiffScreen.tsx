import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { assertNever } from "../../../shared/assert";
import type { DiffSelection } from "../../../shared/git";
import type { Comment, ReviewAnchor, ReviewLayer } from "../../../shared/review";
import { emptySoloReason, findLayer, layerOutline, soloFiles } from "@/lib/layers";
import { effectiveLayers } from "@/lib/coverage";
import { useFitToContent } from "@/lib/fit-panel";
import { unplaceableComments } from "@/lib/diff/comment-annotations";
import { isComplete, NO_COLLAPSED_FILES, NO_READ_FILES, tallyRead } from "@/lib/read-progress";
import { resolveExpandLoader } from "@/lib/diff/expand-context";
import { DiffView } from "@/components/DiffView";
import { LayerIntro } from "@/components/LayerIntro";
import { UnplaceableComments } from "@/components/UnplaceableComments";
import { GitFailureText } from "@/components/GitFailureText";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// A stable empty array: a fresh [] per render would make the comments selector
// return a new reference each time and re-render the screen in a loop.
const EMPTY_COMMENTS: Comment[] = [];
const EMPTY_LAYERS: ReviewLayer[] = [];

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/** j/k step through changed files; the tree keeps its own arrow-key navigation. */
function useFileStepShortcuts(): void {
  const selectAdjacentFile = useReviewStore((state) => state.selectAdjacentFile);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) {
        return;
      }
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        selectAdjacentFile(event.key === "j" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectAdjacentFile]);
}

/** n/p walk the comments (next/previous), Escape dismisses the walk. Sibling of the
 * j/k file stepper, with the same editable-target and modifier guards so it never
 * fires inside the comment editor or a filter field. */
function useCommentStepShortcuts(): void {
  const stepComment = useReviewStore((state) => state.stepComment);
  const clearActiveComment = useReviewStore((state) => state.clearActiveComment);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) {
        return;
      }
      if (event.key === "n" || event.key === "p") {
        event.preventDefault();
        stepComment(event.key === "n" ? 1 : -1);
      } else if (event.key === "Escape") {
        clearActiveComment();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stepComment, clearActiveComment]);
}

/** `r` marks the focused file read or unread — the keyboard half of the header control,
 * and the sibling of j/k (files) and n/p (comments). Deliberately does not move: a reader
 * who marks the file they are looking at is still looking at it, and a surface that jumped
 * out from under that click would make the whole gesture something to be careful with. */
function useReadShortcut(): void {
  const toggleFileRead = useReviewStore((state) => state.toggleFileRead);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) {
        return;
      }
      if (event.key === "r") {
        event.preventDefault();
        toggleFileRead();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleFileRead]);
}

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

/** A clean diff reads differently per selection: branch mode names both sides
 * (refs render mono — machine tokens inside a sans sentence). */
function emptyDiffMessage(selection: DiffSelection | null): ReactNode {
  if (selection === null) {
    return "Nothing to select in this repository.";
  }
  if (selection.kind === "branches") {
    return (
      <>
        {"No changes between "}
        <span className="font-mono">{selection.base}</span>
        {" and "}
        <span className="font-mono">{selection.head}</span>.
      </>
    );
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
  const diffStyle = useReviewStore((state) => state.diffStyle);
  const setScrollTop = useReviewStore((state) => state.setScrollTop);
  const addComment = useReviewStore((state) => state.addComment);
  const editComment = useReviewStore((state) => state.editComment);
  const discardComment = useReviewStore((state) => state.discardComment);
  const stepComment = useReviewStore((state) => state.stepComment);
  const clearActiveComment = useReviewStore((state) => state.clearActiveComment);
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  // Collapsing the prose drops the resize panel entirely (nothing to size), so the
  // parent — not LayerIntro — owns this.
  const [layerIntroCollapsed, setLayerIntroCollapsed] = useState(false);
  useFileStepShortcuts();
  useCommentStepShortcuts();
  useReadShortcut();

  // Bound to the active id (which is DiffView's mount key), so it stays stable for
  // the mounted view and captures land only in the session that scrolled.
  const onScrollTop = useCallback(
    (top: number) => {
      if (activeSessionId !== null) {
        setScrollTop(top, activeSessionId);
      }
    },
    [setScrollTop, activeSessionId],
  );
  const onAddComment = useCallback(
    (anchor: ReviewAnchor, body: string) => {
      if (activeSessionId !== null) {
        addComment(anchor, body, activeSessionId);
      }
    },
    [addComment, activeSessionId],
  );
  const onEditComment = useCallback(
    (commentId: string, body: string) => {
      if (activeSessionId !== null) {
        editComment(commentId, body, activeSessionId);
      }
    },
    [editComment, activeSessionId],
  );
  const onDiscardComment = useCallback(
    (commentId: string) => {
      if (activeSessionId !== null) {
        discardComment(commentId, activeSessionId);
      }
    },
    [discardComment, activeSessionId],
  );
  const onStepComment = useCallback(
    (direction: 1 | -1) => {
      if (activeSessionId !== null) {
        stepComment(direction, activeSessionId);
      }
    },
    [stepComment, activeSessionId],
  );
  const onClearActiveComment = useCallback(() => {
    if (activeSessionId !== null) {
      clearActiveComment(activeSessionId);
    }
  }, [clearActiveComment, activeSessionId]);
  const onSetFileCollapsed = useCallback(
    (path: string, collapsed: boolean) => {
      if (activeSessionId !== null) {
        setFileCollapsed(path, collapsed, activeSessionId);
      }
    },
    [setFileCollapsed, activeSessionId],
  );
  const onResetReviewSubrange = useCallback(() => {
    if (activeSessionId !== null) {
      resetReviewSubrange(activeSessionId);
    }
  }, [resetReviewSubrange, activeSessionId]);

  // Solo: the active layer restricts the diff to its files across both the code
  // view and the tree. Derived from the full loaded files, memoised so a
  // stable subset identity keeps DiffView from rebuilding its items every render.
  const loadedFiles = diff !== null && diff.phase === "loaded" ? diff.files : null;
  // Comments the re-derived diff has no line to host: kept in state, shown
  // nowhere on the surface — the count bar makes them discoverable. Resolved
  // against the full loaded set, never the soloed subset, so soloing a layer never
  // reclassifies another file's comments as unplaceable.
  const unplaceable = useMemo(
    () => unplaceableComments(loadedFiles ?? [], comments),
    [loadedFiles, comments],
  );
  // The authored layers plus the inferred "not covered by layers" layer, so soloing that
  // synthetic row restricts the code view to the skipped files just like an authored one.
  const effLayers = useMemo(
    () => effectiveLayers(loadedFiles ?? [], layers),
    [loadedFiles, layers],
  );
  const activeLayer = useMemo(
    () => findLayer(effLayers, activeLayerId),
    [effLayers, activeLayerId],
  );
  // What each authored layer is and the number it wears — the same outline the rail and
  // the doc read, so the band's number and breadcrumb can never disagree with theirs.
  const outline = useMemo(() => layerOutline(layers), [layers]);
  const visibleFiles = useMemo(
    () => (loadedFiles === null ? null : soloFiles(loadedFiles, activeLayer, effLayers)),
    [loadedFiles, activeLayer, effLayers],
  );
  // The soloed chapter's own progress. `visibleFiles` IS the layer's extent whenever one
  // is soloed, so the band's ring counts exactly what the band's chapter put on screen —
  // no second definition of "this layer's files" to fall out of step with the rail's.
  const layerTally = useMemo(
    () => tallyRead(visibleFiles ?? [], readFiles),
    [visibleFiles, readFiles],
  );
  // The intro's file-link resolution + navigation set. Memoised on the stable
  // subset so LayerIntro's own derived state (the diff-file Set, the parsed
  // description) holds across renders instead of rebuilding every time.
  const visibleFilePaths = useMemo(
    () => (visibleFiles ?? loadedFiles ?? []).map((file) => file.path),
    [visibleFiles, loadedFiles],
  );
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
      const layerFiles = visibleFiles ?? diff.files;
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
            hasOverview={hasOverview}
            ordinal={entry?.ordinal ?? null}
            // With a tour doc, "previous" from the first layer is the doc itself — the
            // review's real first stop — so the chevron only dead-ends without one.
            hasPrev={index > 0 || (hasOverview && index === 0)}
            hasNext={index >= 0 && index < effLayers.length - 1}
            readTally={layerTally}
            onToggleRead={() => setLayerRead(activeLayer.id, !isComplete(layerTally))}
            filePaths={visibleFilePaths}
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
      if (activeLayer !== null && visibleFiles !== null && visibleFiles.length === 0) {
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
