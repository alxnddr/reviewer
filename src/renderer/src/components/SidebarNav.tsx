import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronDown, ListTree } from "lucide-react";
import {
  useGroupRef,
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";
import { assertNever } from "../../../shared/assert";
import type { CommitSelection, DiffSelection, LogEntry } from "../../../shared/git";
import type { ReviewLayer, ReviewSource } from "../../../shared/review";
import { FileTreePanel } from "@/components/FileTreePanel";
import { LayerList } from "@/components/LayerList";
import { SelectionPanel } from "@/components/SelectionPanel";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { emptySoloReason, findLayer, soloFiles } from "@/lib/layers";
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
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const [view, setView] = useState<SidebarView>("tree");

  // A tree only exists for a loaded diff; every other phase (idle, loading,
  // empty, failed) forces the selector — there is nothing to browse, and the
  // selector is where the reviewer recovers by picking a different diff.
  const treeReady = diff !== null && diff.phase === "loaded";
  const showTree = treeReady && view === "tree";

  // The layers panel sizes like the diff view's layer-intro band (see
  // DiffScreen's fitIntro): it opens fitted to its rows' natural height, capped
  // at half the rail, and the seam handle can then drag it either way until the
  // layer set changes and the fit recomputes. The group element gives the rail
  // height; the group handle reports whether its initial layout has settled; the
  // panel handle applies the size; the content ref (in LayerList) measures the
  // rows. `wantFit` gates the fit so onLayoutChanged reapplies it once the group
  // settles (imperative resize is a no-op while the layout is deferred) without
  // ever overriding the user's own drag.
  const layersGroupElRef = useRef<HTMLDivElement>(null);
  const layersGroupRef = useGroupRef();
  const layersPanelRef = usePanelRef();
  const layersContentRef = useRef<HTMLDivElement>(null);
  const wantFitRef = useRef(false);

  const fitLayers = useCallback(() => {
    const groupEl = layersGroupElRef.current;
    const group = layersGroupRef.current;
    const content = layersContentRef.current;
    const panel = layersPanelRef.current;
    if (groupEl === null || group === null || content === null || panel === null) return;
    if (Object.keys(group.getLayout()).length === 0) return;
    // The h-9 heading bar (36px) above the rows, plus the listbox's py-1 (8px).
    const natural = 36 + content.offsetHeight + 8;
    panel.resize(Math.min(natural, groupEl.clientHeight / 2));
    wantFitRef.current = false;
  }, [layersGroupRef, layersPanelRef]);

  // Re-fit when the panel appears and whenever the layer set itself changes (a
  // reload can grow or shrink the list). Soloing a layer does not refit — the
  // rows don't move, and a drag the reviewer just made should hold.
  const layersVisible = showTree && layers.length > 0;
  useLayoutEffect(() => {
    if (!layersVisible) return;
    wantFitRef.current = true;
    fitLayers();
  }, [layersVisible, layers, fitLayers]);

  const onLayersLayoutChanged = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta) => {
      if (meta.isUserInteraction) {
        wantFitRef.current = false;
      } else if (wantFitRef.current) {
        fitLayers();
      }
    },
    [fitLayers],
  );

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
            title={label.title}
          >
            <span className="min-w-0 flex-1 truncate text-left text-sm">{label.node}</span>
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
          const activeLayer = findLayer(layers, activeLayerId);
          const treeFiles = soloFiles(diff.files, activeLayer, layers);
          // An empty subset means either the layer's files all drifted out or
          // it is a bare parent-rollup node with no diff of its own;
          // `emptySoloReason` keeps the hint from reading a legitimate rollup as
          // broken, mirroring the diff surface's dead-end copy.
          const tree =
            activeLayer !== null && treeFiles.length === 0 ? (
              <p className="px-3 py-3 text-xs text-text-muted">
                {emptySoloReason(activeLayer, layers) === "rollup"
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
              />
            );
          if (layers.length === 0) {
            return tree;
          }
          return (
            <ResizablePanelGroup
              orientation="vertical"
              elementRef={layersGroupElRef}
              groupRef={layersGroupRef}
              onLayoutChanged={onLayersLayoutChanged}
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="layers"
                panelRef={layersPanelRef}
                defaultSize="50%"
                minSize="64px"
                groupResizeBehavior="preserve-pixel-size"
              >
                <LayerList
                  layers={layers}
                  activeLayerId={activeLayerId}
                  files={diff.files}
                  frozen={frozen}
                  contentRef={layersContentRef}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="tree" minSize="120px">
                <div className="flex h-full min-h-0 flex-col">{tree}</div>
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
