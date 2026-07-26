import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { ChevronDown, ListTree } from "lucide-react";
import { assertNever } from "../../../shared/assert";
import type { CommitSelection, DiffSelection, LogEntry } from "../../../shared/git";
import type { Comment, ReviewLayer, ReviewSource } from "../../../shared/review";
import { CommentsPanel } from "@/components/CommentsPanel";
import { FileTreePanel } from "@/components/FileTreePanel";
import { LayerList } from "@/components/LayerList";
import { SelectionPanel } from "@/components/SelectionPanel";
import { commentCountsByFile } from "@/lib/diff/comment-navigation";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipHint } from "@/components/ui/tooltip";
import { emptySoloReason, findLayer, soloFiles } from "@/lib/layers";
import { effectiveLayers } from "@/lib/coverage";
import { useFitToContent } from "@/lib/fit-panel";
import { shortRef, shortSha } from "@/lib/refs";
import { reviewSubrangeExtent } from "@/lib/selection";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The sidebar is modal: a diff selector OR the changed-file tree, never both — a
// file tree only makes sense once a diff exists. The header carries the one
// switch between them. Keyed per session in App, so `view` resets to the tree
// each time a session is entered (its diff is already loaded).

type SidebarView = "selector" | "tree";

// A stable empty array so the layers selector returns a constant reference for a
// layer-less session, rather than a fresh [] that would re-render every tick.
const EMPTY_LAYERS: ReviewLayer[] = [];
const EMPTY_COMMENTS: Comment[] = [];

/** The header's diff label: a rendered node (refs/SHAs mono, plain-language arms
 * sans) plus a plain-string `title`, so a truncated ref stays recoverable on hover. */
type SelectionLabel = { node: ReactNode; title: string };

function describeSelection(selection: DiffSelection | null): SelectionLabel {
  if (selection === null) {
    return { node: "Select a diff", title: "Select a diff" };
  }
  switch (selection.kind) {
    case "branches":
      return {
        node: (
          <>
            <span className="font-mono">{selection.base}</span>
            {" … "}
            <span className="font-mono">{selection.head}</span>
          </>
        ),
        title: `${selection.base} … ${selection.head}`,
      };
    case "reviewRefs": {
      const base = shortRef(selection.base);
      const head = shortRef(selection.head);
      return {
        node: (
          <>
            <span className="font-mono">{base}</span>
            {" … "}
            <span className="font-mono">{head}</span>
          </>
        ),
        title: `${base} … ${head}`,
      };
    }
    case "uncommitted":
      return { node: "Uncommitted changes", title: "Uncommitted changes" };
    case "commitRange": {
      const first = shortSha(selection.first);
      if (selection.first === selection.last) {
        return {
          node: (
            <>
              <span className="text-text-muted">Commit </span>
              <span className="font-mono">{first}</span>
            </>
          ),
          title: `Commit ${first}`,
        };
      }
      const last = shortSha(selection.last);
      return {
        node: (
          <>
            <span className="text-text-muted">Commits </span>
            <span className="font-mono">{first}</span>
            {" … "}
            <span className="font-mono">{last}</span>
          </>
        ),
        title: `Commits ${first} … ${last}`,
      };
    }
    case "commitRangeWithUncommitted": {
      const first = shortSha(selection.first);
      return {
        node: (
          <>
            <span className="text-text-muted">Commits </span>
            <span className="font-mono">{first}</span>
            {" … uncommitted"}
          </>
        ),
        title: `Commits ${first} … uncommitted`,
      };
    }
    default:
      return assertNever(selection);
  }
}

/** A review session's diff label: the fixed `base … head` endpoints (abbreviated),
 * with a "N of M commits" badge when the reviewer has narrowed to a subrange. */
function reviewSelectionLabel(
  source: Extract<ReviewSource, { kind: "local" }>,
  entries: LogEntry[] | null,
  subrange: CommitSelection | null,
): SelectionLabel {
  const base = shortRef(source.base);
  const head = shortRef(source.head);
  const extent =
    subrange !== null && entries !== null ? reviewSubrangeExtent(entries, subrange) : null;
  const badge = extent === null ? null : ` · ${extent.selected} of ${extent.total} commits`;
  return {
    node: (
      <>
        <span className="font-mono">{base}</span>
        {" … "}
        <span className="font-mono">{head}</span>
        {badge !== null && <span className="text-text-muted">{badge}</span>}
      </>
    ),
    title: `${base} … ${head}${badge ?? ""}`,
  };
}

export function SidebarNav(): ReactElement {
  const diff = useReviewStore((state) => selectActiveSlice(state)?.diff ?? null);
  const selection = useReviewStore((state) => selectActiveSlice(state)?.selection ?? null);
  const reviewSource = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewOrigin?.source ?? null,
  );
  const reviewSubrange = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewSubrange ?? null,
  );
  const reviewLogEntries = useReviewStore((state) => {
    const log = selectActiveSlice(state)?.log ?? null;
    return log !== null && log.phase === "loaded" ? log.entries : null;
  });
  const layers = useReviewStore((state) => selectActiveSlice(state)?.layers ?? EMPTY_LAYERS);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  const activeLayerId = useReviewStore((state) => selectActiveSlice(state)?.activeLayerId ?? null);
  const hasOverview = useReviewStore((state) => selectActiveSlice(state)?.overview != null);
  const overviewOpen = useReviewStore((state) => selectActiveSlice(state)?.overviewOpen ?? false);
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const activeCommentId = useReviewStore(
    (state) => selectActiveSlice(state)?.activeCommentId ?? null,
  );
  const focusComment = useReviewStore((state) => state.focusComment);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const [view, setView] = useState<SidebarView>("tree");
  // Disclosure of the comment overview: collapsed it's a one-line count bar; expanded
  // it becomes a resizable panel above the layers/tree stack. Per-session (SidebarNav
  // is keyed by the active session), so it resets like `view` on a tab switch.
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  // The same disclosure for the layers list, and the same per-session reset — but open
  // by default: an artifact's layers *are* the reading order it was written in, so the
  // walkthrough is what the rail should offer first, with the tree underneath.
  const [layersExpanded, setLayersExpanded] = useState(true);
  const commentCounts = useMemo(() => commentCountsByFile(comments), [comments]);

  // A tree only exists for a loaded diff; every other phase (idle, loading,
  // empty, failed) forces the selector — there is nothing to browse, and the
  // selector is where the reviewer recovers by picking a different diff.
  const treeReady = diff !== null && diff.phase === "loaded";
  const showTree = treeReady && view === "tree";

  // The layers panel sizes like the diff view's layer-intro band: it opens fitted to
  // its rows, capped at half the rail, and the seam handle can then drag it either way
  // until the layer set itself changes (a reload can grow or shrink the list) and the
  // fit recomputes. Soloing a layer does not refit — the rows don't move, and a drag
  // the reviewer just made should hold.
  const layersVisible = showTree && (layers.length > 0 || hasOverview) && layersExpanded;
  const layersFit = useFitToContent({ enabled: layersVisible, refitOn: layers });
  // The comment overview sizes the same way: opened, it is as tall as its rows need
  // and no taller — a short review's list left a band of empty rail above the tree —
  // capped at half the stack it shares with the tree, and draggable from there.
  const commentsVisible = showTree && comments.length > 0 && commentsExpanded;
  const commentsFit = useFitToContent({ enabled: commentsVisible, refitOn: comments });

  // A review session names its fixed endpoints (with a subrange badge when narrowed),
  // never a repo picker's selection; a repo session describes its live selection.
  const label =
    reviewSource !== null && reviewSource.kind === "local"
      ? reviewSelectionLabel(reviewSource, reviewLogEntries, reviewSubrange)
      : describeSelection(selection);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-2">
        {showTree ? (
          <Button
            variant="ghost"
            className="h-8 w-full justify-start gap-2 px-2 font-normal hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => setView("selector")}
            aria-label="Change the diff selection"
          >
            {/* The hint hangs off the label itself, not the button: the button is a
                full-width hit target that never clips, so only the label can say
                whether anything was actually cut off. */}
            <TooltipHint content={label.title} whenTruncated side="bottom" align="start">
              <span className="min-w-0 flex-1 truncate text-left text-sm">{label.node}</span>
            </TooltipHint>
            <ChevronDown aria-hidden="true" className="shrink-0 opacity-60" />
          </Button>
        ) : (
          <>
            <span className="px-2 text-sm text-text-muted">Select a diff</span>
            {treeReady && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto hover:bg-border/60 dark:hover:bg-border/60"
                onClick={() => setView("tree")}
              >
                <ListTree aria-hidden="true" />
                Browse changes
              </Button>
            )}
          </>
        )}
      </div>
      {showTree && diff.phase === "loaded" ? (
        (() => {
          // Resolve the active layer against the authored layers *plus* the inferred
          // "not covered by layers" layer, so soloing that synthetic row filters the
          // tree to the skipped files exactly as an authored layer would.
          const effLayers = effectiveLayers(diff.files, layers);
          const activeLayer = findLayer(effLayers, activeLayerId);
          const treeFiles = soloFiles(diff.files, activeLayer, effLayers);
          // An empty subset means either the layer's files all drifted out of the diff or
          // the layer names none at all; `emptySoloReason` keeps the hint from reading a
          // layer with nothing of its own as broken, mirroring the diff surface's
          // dead-end copy.
          const tree =
            activeLayer !== null && treeFiles.length === 0 ? (
              <p className="px-3 py-3 text-xs text-text-muted">
                {emptySoloReason(activeLayer, effLayers) === "empty"
                  ? "This layer has no changes of its own."
                  : "This layer’s files are no longer in the current diff."}
              </p>
            ) : (
              // The tree model is immutable after creation; a new load means a new
              // tree, and a solo means a new file subset — the key carries both so
              // the tree remounts on either. loadIds restart per session.
              <FileTreePanel
                key={`${activeSessionId}:${diff.loadId}:${activeLayerId ?? ""}`}
                files={treeFiles}
                commentCounts={commentCounts}
              />
            );
          // The walkthrough heads the rail: an artifact's layers are the reading order
          // it was written in, so the list the reader steps sits above the comment
          // overview and the tree, not under them.
          const layersList = (
            <LayerList
              layers={layers}
              activeLayerId={activeLayerId}
              hasOverview={hasOverview}
              overviewOpen={overviewOpen}
              files={diff.files}
              frozen={frozen}
              expanded={layersExpanded}
              onToggleExpanded={() => setLayersExpanded((value) => !value)}
              fit={layersFit.content}
            />
          );
          // The overview reads the full diff (not the soloed subset) — clicking a
          // soloed-out comment clears the solo in the store.
          const renderComments = (fill: boolean): ReactElement | null => (
            <CommentsPanel
              files={diff.files}
              comments={comments}
              frozen={frozen}
              activeCommentId={activeCommentId}
              onFocusComment={focusComment}
              expanded={commentsExpanded}
              onToggleExpanded={() => setCommentsExpanded((value) => !value)}
              fill={fill}
              {...(fill ? { fit: commentsFit.content } : {})}
            />
          );
          // What sits under the walkthrough: the comment overview over the tree.
          // Expanded (with comments to show), the overview is its own resizable panel,
          // draggable at the seam. Collapsed — or on a diff with no comments — it's
          // just the shrink-0 count bar over the tree, so the resize math is only paid
          // for when the list is actually open.
          const restStack =
            comments.length > 0 && commentsExpanded ? (
              <ResizablePanelGroup
                orientation="vertical"
                {...commentsFit.group}
                className="min-h-0 flex-1"
              >
                <ResizablePanel
                  id="comments"
                  {...commentsFit.panel}
                  defaultSize="240px"
                  minSize="72px"
                  groupResizeBehavior="preserve-pixel-size"
                >
                  {renderComments(true)}
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel id="tree" minSize="120px">
                  <div className="flex h-full min-h-0 flex-col">{tree}</div>
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {renderComments(false)}
                {tree}
              </div>
            );
          // Open, the layer list is a resizable panel over that stack, seam and all.
          // Collapsed — or on a diff with no layers at all — it's the bare bar (or
          // nothing) above it, so the resize math is only paid for when the list is on
          // screen.
          if (layers.length === 0 && !hasOverview) {
            return restStack;
          }
          if (!layersExpanded) {
            return (
              <div className="flex min-h-0 flex-1 flex-col">
                {layersList}
                {restStack}
              </div>
            );
          }
          return (
            <ResizablePanelGroup
              orientation="vertical"
              {...layersFit.group}
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="layers"
                {...layersFit.panel}
                defaultSize="50%"
                minSize="64px"
                groupResizeBehavior="preserve-pixel-size"
              >
                {layersList}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="rest" minSize="120px">
                <div className="flex h-full min-h-0 flex-col">{restStack}</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          );
        })()
      ) : (
        <SelectionPanel />
      )}
    </div>
  );
}
