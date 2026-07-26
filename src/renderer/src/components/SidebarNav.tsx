import { useMemo, useState, type ReactElement } from "react";
import type { Comment, ReviewLayer } from "../../../shared/review";
import { CommentsPanel } from "@/components/CommentsPanel";
import { FileTreePanel } from "@/components/FileTreePanel";
import { LayerList } from "@/components/LayerList";
import { OverviewRow } from "@/components/OverviewRow";
import { RailNote } from "@/components/rail";
import { SelectionPanel, SelectionRow } from "@/components/SelectionPanel";
import { commentCountsByFile } from "@/lib/diff/comment-navigation";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { emptySoloReason, findLayer, soloFiles } from "@/lib/layers";
import { effectiveLayers } from "@/lib/coverage";
import { useFitToContent } from "@/lib/fit-panel";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The rail, top to bottom: the diff it is about, then the review's stops, then the
// files — widest scope first, one section bar each (see rail.tsx, which owns every bar
// and row the four widgets below are built from).
//
// The diff section is modal where the others are not: opened, its picker takes the
// rail, because everything below it is *about* the diff being picked and a picker
// squeezed into a third of a 256px column can show three commits. What it no longer
// does is take the bar with it — the bar stays, names the loaded diff throughout, and
// its twisty is the way back. Keyed per session in App, so the picker starts closed
// each time a session is entered (its diff is already loaded).

// A stable empty array so the layers selector returns a constant reference for a
// layer-less session, rather than a fresh [] that would re-render every tick.
const EMPTY_LAYERS: ReviewLayer[] = [];
const EMPTY_COMMENTS: Comment[] = [];

export function SidebarNav(): ReactElement {
  const diff = useReviewStore((state) => selectActiveSlice(state)?.diff ?? null);
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
  const openOverview = useReviewStore((state) => state.openOverview);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  // Disclosure of the diff picker. Closed by default: a session arrives with its diff
  // already chosen, so the rail opens on what is in it.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Disclosure of the comment overview: collapsed it's a one-line count bar; expanded
  // it becomes a resizable panel above the layers/tree stack. Per-session (SidebarNav
  // is keyed by the active session), so it resets like the picker on a tab switch.
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  // The same disclosure for the layers list, and the same per-session reset — but open
  // by default: an artifact's layers *are* the reading order it was written in, so the
  // walkthrough is what the rail should offer first, with the tree underneath.
  const [layersExpanded, setLayersExpanded] = useState(true);
  const commentCounts = useMemo(() => commentCountsByFile(comments), [comments]);

  // A tree only exists for a loaded diff; every other phase (idle, loading,
  // empty, failed) forces the picker open and holds it there — there is nothing to
  // browse, and the picker is where the reviewer recovers by choosing another diff.
  const treeReady = diff !== null && diff.phase === "loaded";
  const showTree = treeReady && !pickerOpen;

  // The layers panel sizes like the diff view's layer-intro band: it opens fitted to
  // its rows, capped at half the rail, and the seam handle can then drag it either way
  // until the layer set itself changes (a reload can grow or shrink the list) and the
  // fit recomputes. Soloing a layer does not refit — the rows don't move, and a drag
  // the reviewer just made should hold.
  const layersVisible = showTree && layers.length > 0 && layersExpanded;
  const layersFit = useFitToContent({ enabled: layersVisible, refitOn: layers });
  // The comment overview sizes the same way: opened, it is as tall as its rows need
  // and no taller — a short review's list left a band of empty rail above the tree —
  // capped at half the stack it shares with the tree, and draggable from there.
  const commentsVisible = showTree && comments.length > 0 && commentsExpanded;
  const commentsFit = useFitToContent({ enabled: commentsVisible, refitOn: comments });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      // Escape leaves the picker, from anywhere inside it — the gesture every transient
      // surface in the app answers to. Not while a field has focus: a combobox eats its
      // own Escape to close its popup, and the filter field's Escape clears the filter,
      // so a key that also closed the panel out from under either would be the second
      // thing it did. Scoped to the rail rather than the window: the diff pane has its
      // own Escape (leaving the comment walk), and a key can only mean one thing at a
      // time in the region the reader is actually in.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !pickerOpen || !treeReady) {
          return;
        }
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          return;
        }
        event.preventDefault();
        setPickerOpen(false);
      }}
    >
      <SelectionRow
        expanded={!showTree}
        onToggle={() => setPickerOpen((open) => !open)}
        locked={!treeReady}
      />
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
              <RailNote>
                {emptySoloReason(activeLayer, effLayers) === "empty"
                  ? "This layer has no changes of its own."
                  : "This layer’s files are no longer in the current diff."}
              </RailNote>
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
              overviewOpen={overviewOpen}
              files={diff.files}
              frozen={frozen}
              expanded={layersExpanded}
              onToggleExpanded={() => setLayersExpanded((value) => !value)}
              fit={layersFit.content}
            />
          );
          // The doc's own row, above the Layers section rather than inside it — it is a
          // sibling of that section, not one of its layers. Absent on a review that carries
          // no doc, in which case the rail simply starts at Layers.
          const overviewRow = hasOverview ? (
            <OverviewRow selected={overviewOpen} onOpen={() => openOverview()} />
          ) : null;
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
          // The doc's row is a fixed-height item above everything, never inside the
          // resizable stack: it is one row and always one row, so there is nothing about it
          // to size. Only the layer list is a panel, and only while it is open.
          //
          // Open, the layer list is a resizable panel over the rest, seam and all.
          // Collapsed — or on a diff with no layers at all — it's the bare bar (or nothing)
          // above it, so the resize math is only paid for when the list is on screen.
          const stack =
            layers.length === 0 ? (
              restStack
            ) : !layersExpanded ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {layersList}
                {restStack}
              </div>
            ) : (
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
          if (overviewRow === null) {
            return stack;
          }
          return (
            <div className="flex min-h-0 flex-1 flex-col">
              {overviewRow}
              {stack}
            </div>
          );
        })()
      ) : (
        <SelectionPanel />
      )}
    </div>
  );
}
