import type { ReactElement } from "react";
import type { Comment, ReviewLayer } from "../../../shared/review";
import { CommentsPanel } from "@/components/CommentsPanel";
import { FileTreePanel } from "@/components/FileTreePanel";
import { LayerList } from "@/components/LayerList";
import { OverviewRow } from "@/components/OverviewRow";
import { RailNote } from "@/components/rail";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { emptySoloReason } from "../../../shared/layers";
import type { DiffState } from "@/lib/load-state";
import { useFitToContent } from "@/lib/fit-panel";
import { selectActiveSlice, selectSoloedDiff, useReviewStore } from "@/stores/review";

// The rail below the diff bar, once there is a diff to be about: the doc's own row, the
// walkthrough, the comment overview, the file tree — stacked, and resizable where there is
// something to size (see `SidebarNav`, which owns the switch that puts this here).
//
// ── Where the state comes from ────────────────────────────────────────────────────
//
// One rule, because five sections in one column had five answers and four of them were
// accidents.
//
// A section reads the store. It is a region of the surface, mounted once, and what it draws
// is session state it can name for itself: `LayerList` subscribes to the layers,
// `CommentsPanel` to the comments, `FileTreePanel` to the soloed subset, `SelectionPanel`
// (which always did) to the picker's refs and log. What a section takes as props is only
// what this component knows and it cannot — the disclosure state the rail owns, the panel
// refs it is fitted through, and the key it is mounted under.
//
// A row, a band, or the diff surface takes props, actions included. It is drawn once per
// thing and its parent has already resolved which thing that is: `OverviewRow`, `TreeRow`,
// `CommentRow`, `LayerIntro`, `DiffView`.
//
// The standing exception is a leaf control that calls one action and needs nothing but its
// own id to do it — `FileReadToggle`, `FileFoldToggle`, the two copy buttons. Each reads
// and calls the store itself, and each says why in its own file: threading a callback down
// to a button that needs exactly one id is plumbing for nothing, and the ones that hang off
// Pierre's slots would repaint on a reconciliation rather than on the click that caused it.
//
// The rail is where that mattered most. `layers`, `files`, `frozen` and `activeLayerId`
// were drilled through here into a `LayerList` that already held a store handle, so this
// component subscribed to — and re-rendered the whole column on — state only one section
// below it ever drew.

// Stable empty arrays so the selectors below return a constant reference for a layer-less
// or comment-less session, rather than a fresh [] that would re-render every tick.
const EMPTY_LAYERS: ReviewLayer[] = [];
const EMPTY_COMMENTS: Comment[] = [];

type ReviewRailProps = {
  /** The loaded diff this rail is about. Narrowed by the parent, which is what decides
   * there is a rail at all — every other phase forces the picker open in its place. */
  diff: Extract<DiffState, { phase: "loaded" }>;
  /** Disclosure of the layers list and of the comment overview. Held by `SidebarNav`
   * rather than here so opening the picker and closing it again leaves both where the
   * reader put them; per-session, like the picker's own state, because `SidebarNav` is
   * keyed by the active session. */
  layersExpanded: boolean;
  onToggleLayers: () => void;
  commentsExpanded: boolean;
  onToggleComments: () => void;
};

export function ReviewRail({
  diff,
  layersExpanded,
  onToggleLayers,
  commentsExpanded,
  onToggleComments,
}: ReviewRailProps): ReactElement {
  const layers = useReviewStore((state) => selectActiveSlice(state)?.layers ?? EMPTY_LAYERS);
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  // The soloed diff — the effective layer list, the resolved active layer, and the file
  // subset the tree lists — derived once for the whole app (`lib/soloed-diff.ts`) and read
  // here as a subscription rather than recomputed in the render body. The rail re-renders on
  // every disclosure toggle; this used to run the full O(files × layers × ranges) coverage
  // scan on each of them.
  const soloed = useReviewStore(selectSoloedDiff);
  const hasOverview = useReviewStore((state) => selectActiveSlice(state)?.overview != null);
  const overviewOpen = useReviewStore((state) => selectActiveSlice(state)?.overviewOpen ?? false);
  const openOverview = useReviewStore((state) => state.openOverview);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const activeLayerId = useReviewStore((state) => selectActiveSlice(state)?.activeLayerId ?? null);

  // The layers panel sizes like the diff view's layer-intro band: it opens fitted to
  // its rows, capped at half the rail, and the seam handle can then drag it either way
  // until the layer set itself changes (a reload can grow or shrink the list) and the
  // fit recomputes. Soloing a layer does not refit — the rows don't move, and a drag
  // the reviewer just made should hold.
  const layersFit = useFitToContent({
    enabled: layers.length > 0 && layersExpanded,
    refitOn: layers,
  });
  // The comment overview sizes the same way: opened, it is as tall as its rows need
  // and no taller — a short review's list left a band of empty rail above the tree —
  // capped at half the stack it shares with the tree, and draggable from there.
  const commentsFit = useFitToContent({
    enabled: comments.length > 0 && commentsExpanded,
    refitOn: comments,
  });

  // The active layer resolved against the authored layers *plus* the inferred
  // "not covered by layers" layer, so soloing that synthetic row filters the
  // tree to the skipped files exactly as an authored layer would.
  const { layers: effLayers, activeLayer, files: treeFiles } = soloed;
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
      <FileTreePanel key={`${activeSessionId}:${diff.loadId}:${activeLayerId ?? ""}`} />
    );
  // The walkthrough heads the rail: an artifact's layers are the reading order
  // it was written in, so the list the reader steps sits above the comment
  // overview and the tree, not under them.
  const layersList = (
    <LayerList
      expanded={layersExpanded}
      onToggleExpanded={onToggleLayers}
      fit={layersFit.content}
    />
  );
  // The doc's own row, above the Layers section rather than inside it — it is a
  // sibling of that section, not one of its layers. Absent on a review that carries
  // no doc, in which case the rail simply starts at Layers.
  const overviewRow = hasOverview ? (
    <OverviewRow selected={overviewOpen} onOpen={() => openOverview()} />
  ) : null;
  const renderComments = (fill: boolean): ReactElement | null => (
    <CommentsPanel
      expanded={commentsExpanded}
      onToggleExpanded={onToggleComments}
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
      <ResizablePanelGroup orientation="vertical" {...commentsFit.group} className="min-h-0 flex-1">
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
    ) : layersExpanded ? (
      <ResizablePanelGroup orientation="vertical" {...layersFit.group} className="min-h-0 flex-1">
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
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        {layersList}
        {restStack}
      </div>
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
}
