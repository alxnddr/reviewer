import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Compass,
  Layers as LayersIcon,
} from "lucide-react";
import type { ReviewLayer } from "../../../shared/review";
import type { PatchFile } from "@/lib/diff/patch";
import type { FitToContentRefs } from "@/lib/fit-panel";
import { layerOutline, resolveLayerScroll } from "@/lib/layers";
import { coverageSummary } from "@/lib/coverage";
import { layerTally, NO_READ_FILES, type ReadTally } from "@/lib/read-progress";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { ReadRing, readLabel } from "@/components/ReadRing";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The review's table of contents, as a tree. `layers` nests, so the rail is a tree widget
// and not a flat list pretending: a row indents under its parent, a parent discloses, and
// the section number (`4.2.1`) is the same one the doc and the band print.
//
// Every row is a real place to stand, parents included — selecting one solos its whole
// extent (itself plus everything under it), selecting a child narrows to that section.
// That is the aggregation rule from lib/layers.ts, and it is why there is no second kind
// of row here with different rules: one row type, one gesture, two scopes.
//
// Hand-built `tree`/`treeitem` rather than a component library: the active descendant *is*
// the soloed layer, so roving and soloing are the same move, and the arrow keys have to
// walk what is on screen (a collapsed subtree is skipped) while the diff-side chevrons walk
// the whole review. The pure stepping/solo/outline logic lives in lib/layers.ts.

/** Per-level indent. Enough to read as nesting at a glance in a 256px rail, small enough
 * that the cap (five levels) still leaves a usable label column. */
const INDENT_PX = 12;
/** The twisty's slot, held open on childless rows so labels line up within a level. */
const TWISTY_PX = 16;

/** Nothing measured: the doc's row, and any layer the loaded diff carries no file for. A
 * shared constant so those rows hand `ReadRing` one stable reference rather than a fresh
 * object per render. */
const NO_TALLY: ReadTally = { read: 0, total: 0 };

function rowDomId(id: string): string {
  return `layer-row-${id}`;
}

/** The tour doc's slot in the tree. Namespaced like the inferred layer's id so it cannot
 * collide with an authored one; it never leaves this component — clicking it calls
 * `openOverview`, it is never handed to `setActiveLayer`. */
const OVERVIEW_ROW_ID = "reviewer:overview";

/** What the rail draws, flattened to rows in document order. The tree shape survives as
 * `depth` + `expandable`, which is all a row needs to render and all the keyboard needs to
 * move: everything structural was already decided by `layerOutline`. */
type Row = {
  id: string;
  kind: "overview" | "layer" | "uncovered";
  depth: number;
  /** Null on the doc and inferred rows, which are no authored step. */
  ordinal: string | null;
  label: string;
  /** The one-line summary, shown on hover — the rail is an outline, not a description. */
  summary: string | null;
  expandable: boolean;
  /** Hidden because an ancestor is collapsed. Kept in the list (not filtered out) so the
   * keyboard and the click handler share one index space with the DOM. */
  hidden: boolean;
  outdated: boolean;
  /** Related to the soloed layer: inside its extent (the diff on screen includes this
   * section's files) or on the trail up to it. Carried in ink rather than fill, so "part
   * of what you are looking at" never reads as a second selection. */
  related: boolean;
  /** How much of this row's extent the reader has been through. Status, not a control —
   * the chapter band is where a layer is marked, and a 12px target inside a 28px row that
   * already means "solo this" would be a second gesture nobody could aim. */
  read: ReadTally;
};

type LayerRowProps = {
  row: Row;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
};

/** One row: indent, twisty, section number, label. One line — the rail is scanned, and a
 * second line of prose per row buries the shape the indentation exists to show. The
 * summary rides in the hover hint, where it costs nothing. */
function TreeRow({ row, selected, expanded, onSelect, onToggle }: LayerRowProps): ReactElement {
  const glyph =
    row.kind === "overview" ? (
      <Compass aria-hidden="true" className="size-3.5 shrink-0" />
    ) : row.kind === "uncovered" ? (
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
    ) : null;

  return (
    <div
      role="treeitem"
      id={rowDomId(row.id)}
      data-row-id={row.id}
      aria-selected={selected}
      aria-level={row.depth + 1}
      {...(row.expandable ? { "aria-expanded": expanded } : {})}
      style={{ paddingLeft: 8 + row.depth * INDENT_PX }}
      className={cn(
        "flex h-7 cursor-default items-center gap-1.5 pr-2 select-none hover:bg-border/30",
        selected && "bg-selected hover:bg-selected",
        selected || row.related ? "text-foreground" : "text-text-muted",
      )}
    >
      {/* The twisty owns its own click: disclosing a group is not selecting it, and a
          reader opening a chapter to look inside should not have the diff jump. */}
      {row.expandable ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          style={{ width: TWISTY_PX }}
          className="flex h-full shrink-0 items-center justify-center text-text-muted hover:text-foreground"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : (
        <span style={{ width: TWISTY_PX }} className="shrink-0" />
      )}
      {glyph}
      {row.ordinal !== null && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            selected ? "text-foreground/70" : "text-text-faint",
          )}
        >
          {row.ordinal}
        </span>
      )}
      <TooltipHint
        side="right"
        align="center"
        content={
          row.summary === null ? (
            row.label
          ) : (
            <div className="flex flex-col gap-0.5">
              <span>{row.label}</span>
              <span className="text-background/70">{row.summary}</span>
            </div>
          )
        }
      >
        <span
          onClick={onSelect}
          className={cn("min-w-0 flex-1 truncate text-sm", selected && "text-foreground")}
        >
          {row.label}
        </span>
      </TooltipHint>
      {row.outdated && (
        // The neutral pill keeps a hairline so its shape stays legible against the themed
        // selection fill of a soloed row, whose hue and tone it would otherwise wash into.
        <span className="shrink-0 rounded border border-border bg-border/60 px-1.5 py-0.5 text-xs text-foreground">
          Outdated
        </span>
      )}
      {/* Where the reader is in this chapter, at the row's outer edge — a pie part-way
          through, a check when it is done. An untouched row shows nothing: a rail of empty
          circles would be a column of noise on a review nobody has started, and the whole
          point of a status mark is that it means something when it is there. */}
      {row.read.read > 0 && (
        <TooltipHint side="right" align="center" content={readLabel(row.read)}>
          <span className="flex shrink-0 items-center">
            <ReadRing tally={row.read} />
          </span>
        </TooltipHint>
      )}
    </div>
  );
}

type LayerListProps = {
  layers: ReviewLayer[];
  activeLayerId: string | null;
  /** Whether the review carries a tour doc — the tree then leads with its row. */
  hasOverview: boolean;
  /** Whether that doc is the current stop. It is selected instead of any layer (the
   * store clears the solo when the doc opens), so exactly one row ever reads selected. */
  overviewOpen: boolean;
  /** The full loaded diff — never the soloed subset — so each layer's outdated flag is
   * resolved against the whole file set. */
  files: PatchFile[];
  /** True when the review pins its own frozen patch: every layer anchor places
   * against it, so no layer wears the outdated chip — the same rule the comment
   * surface applies to a frozen review. */
  frozen: boolean;
  /** Disclosure is owned by the parent (SidebarNav) so it can host the open tree in a
   * resizable panel and fall back to a plain bar when collapsed — the same split it
   * makes for the comment overview above. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Present when the tree lives in a panel the parent fits to the rows' own height:
   * the tree is the scroll viewport, the row block inside it the measured content. */
  fit?: FitToContentRefs;
};

/** The ordered-layers panel: solos a layer's extent across the file tree and the code
 * view. Selection is derived view state routed through the store — it never touches the
 * session's persisted diff/scroll. */
export function LayerList({
  layers,
  activeLayerId,
  hasOverview,
  overviewOpen,
  files,
  frozen,
  expanded,
  onToggleExpanded,
  fit,
}: LayerListProps): ReactElement | null {
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  const openOverview = useReviewStore((state) => state.openOverview);
  const readFiles = useReviewStore((state) => selectActiveSlice(state)?.readFiles ?? NO_READ_FILES);

  // The computed coverage of the loaded diff by these layers — same core the `rvw
  // coverage` CLI reports, so the header number and the CLI never disagree. `uncovered`
  // is the inferred remainder, present only when a coverable file sits in no layer at all.
  const summary = useMemo(() => coverageSummary(files, layers), [files, layers]);
  // With no authored layers there is nothing for a file to be missing from, so the
  // inferred row is suppressed — the section is then just the tour doc's own row.
  const uncovered = layers.length === 0 ? null : summary.uncoveredLayer;

  // Each layer's depth, section number and extent — the same outline the doc and the band
  // read, so a layer is `4.2.1` in all three or in none.
  const outline = useMemo(() => layerOutline(layers), [layers]);

  // Groups start open: the layers *are* the review, and a review that opens with its
  // chapters folded away hides the thing the rail exists to show. Collapsing is the
  // reader's move, held for as long as they are looking at this session.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // Resolve each layer's outdated flag once per layers/diff change, not per row per
  // render — the scan is O(files × hunks) per layer.
  const outdatedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const layer of layers) {
      if (resolveLayerScroll(layer, layers, files, frozen).kind === "outdated") {
        ids.add(layer.id);
      }
    }
    return ids;
  }, [layers, files, frozen]);

  // Each layer's progress over its extent, resolved once per (layers, diff, marks) rather
  // than per row per render — `layerTally` walks the subtree's ranges, which is the same
  // O(files × ranges) scan the outdated pass above pays for.
  const tallies = useMemo(() => {
    const byId = new Map<string, ReadTally>();
    for (const layer of layers) {
      byId.set(layer.id, layerTally(files, layer, layers, readFiles));
    }
    if (uncovered !== null) {
      byId.set(uncovered.id, layerTally(files, uncovered, layers, readFiles));
    }
    return byId;
  }, [layers, files, readFiles, uncovered]);

  const rows = useMemo((): Row[] => {
    // What the soloed layer implicates: everything inside its extent (those files are on
    // screen) and everything on the trail up to it (that is where it sits). Both read in
    // full ink, so a folded group still shows that the selection is somewhere inside it.
    const active = outline.find((entry) => entry.layer.id === activeLayerId);
    const related = new Set([
      ...(active?.subtree ?? []).map((layer) => layer.id),
      ...(active?.ancestors ?? []).map((layer) => layer.id),
    ]);
    const hiddenIds = new Set<string>();
    const layerRows = outline.map((entry): Row => {
      const hidden = entry.ancestors.some((ancestor) => hiddenIds.has(ancestor.id));
      if (hidden || collapsed.has(entry.layer.id)) {
        hiddenIds.add(entry.layer.id);
      }
      return {
        id: entry.layer.id,
        kind: "layer",
        depth: entry.depth,
        ordinal: entry.ordinal,
        label: entry.layer.label,
        summary: entry.layer.summary,
        expandable: entry.children.length > 0,
        hidden,
        outdated: outdatedIds.has(entry.layer.id),
        related: related.has(entry.layer.id),
        read: tallies.get(entry.layer.id) ?? NO_TALLY,
      };
    });
    return [
      ...(hasOverview
        ? [
            {
              id: OVERVIEW_ROW_ID,
              kind: "overview" as const,
              depth: 0,
              ordinal: null,
              label: "Overview",
              summary: null,
              expandable: false,
              hidden: false,
              outdated: false,
              related: false,
              // The doc is prose, not files: it is read when the reader has read it, which
              // nothing can measure. It carries no mark rather than a false one.
              read: NO_TALLY,
            },
          ]
        : []),
      ...layerRows,
      ...(uncovered === null
        ? []
        : [
            {
              id: uncovered.id,
              kind: "uncovered" as const,
              depth: 0,
              ordinal: null,
              label: "Not covered",
              summary: uncovered.summary,
              expandable: false,
              hidden: false,
              outdated: false,
              related: false,
              read: tallies.get(uncovered.id) ?? NO_TALLY,
            },
          ]),
    ];
  }, [outline, collapsed, outdatedIds, hasOverview, uncovered, activeLayerId, tallies]);

  const selectedId = overviewOpen ? OVERVIEW_ROW_ID : activeLayerId;

  // A layer reached from anywhere else — the band's chevrons, a doc section, a comment —
  // must be visible here: the rail is where the reader tracks where they are, and a
  // selection hidden inside a folded group silently loses them. Revealing beats
  // preserving the fold.
  useEffect(() => {
    if (activeLayerId === null) {
      return;
    }
    const entry = outline.find((candidate) => candidate.layer.id === activeLayerId);
    if (entry === undefined || entry.ancestors.length === 0) {
      return;
    }
    setCollapsed((current) => {
      if (!entry.ancestors.some((ancestor) => current.has(ancestor.id))) {
        return current;
      }
      const next = new Set(current);
      for (const ancestor of entry.ancestors) {
        next.delete(ancestor.id);
      }
      return next;
    });
  }, [activeLayerId, outline]);

  useEffect(() => {
    // Keep the selected row visible as the selection walks the tree.
    if (selectedId !== null) {
      document.getElementById(rowDomId(selectedId))?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedId, rows]);

  // Nothing to walk and no doc to walk back to: the section is absent entirely.
  if (layers.length === 0 && !hasOverview) {
    return null;
  }

  const visible = rows.filter((row) => !row.hidden);

  /** Go where a row points: the doc row opens the doc, a layer row solos it. */
  const select = (id: string): void => {
    if (id === OVERVIEW_ROW_ID) {
      openOverview();
      return;
    }
    setActiveLayer(id);
  };

  const toggle = (id: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });

  const rowAtEvent = (target: EventTarget | null): Row | null => {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    const element = target.closest("[data-row-id]");
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    return rows.find((row) => row.id === element.dataset["rowId"]) ?? null;
  };

  /** Move the selection `direction` steps through the rows currently on screen — a folded
   * group's contents are skipped, because the arrows walk what the reader can see. */
  const step = (direction: 1 | -1): void => {
    if (visible.length === 0) {
      return;
    }
    const index = visible.findIndex((row) => row.id === selectedId);
    const next =
      index === -1
        ? direction === 1
          ? 0
          : visible.length - 1
        : Math.min(Math.max(index + direction, 0), visible.length - 1);
    const target = visible[next];
    if (target !== undefined) {
      select(target.id);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = rows.find((row) => row.id === selectedId) ?? null;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "ArrowRight": {
        // The tree convention: open a folded group, then step into it.
        event.preventDefault();
        if (current === null || !current.expandable) {
          break;
        }
        if (collapsed.has(current.id)) {
          toggle(current.id);
        } else {
          step(1);
        }
        break;
      }
      case "ArrowLeft": {
        // …and its mirror: fold an open group, else rise to the parent.
        event.preventDefault();
        if (current === null) {
          break;
        }
        if (current.expandable && !collapsed.has(current.id)) {
          toggle(current.id);
          break;
        }
        const parent = outline.find((entry) => entry.layer.id === current.id)?.parent;
        if (parent !== undefined && parent !== null) {
          select(parent.id);
        }
        break;
      }
      case "Home": {
        event.preventDefault();
        const first = visible[0];
        if (first !== undefined) {
          select(first.id);
        }
        break;
      }
      case "End": {
        event.preventDefault();
        const last = visible[visible.length - 1];
        if (last !== undefined) {
          select(last.id);
        }
        break;
      }
      case "Escape":
        if (activeLayerId !== null) {
          event.preventDefault();
          setActiveLayer(null);
        }
        break;
      default:
        break;
    }
  };

  // The disclosure's own content, shared by both branches below: the twisty, the
  // section glyph, and the count that keeps the collapsed bar informative.
  const disclosure = (
    <>
      {expanded ? (
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <LayersIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {/* A doc with no layers behind it has nothing to count; the section is named for
          what it holds instead of reading "0 layers". */}
      {layers.length === 0 ? "Layers" : layers.length === 1 ? "1 layer" : `${layers.length} layers`}
    </>
  );
  const headerRef = useRef<HTMLDivElement>(null);
  // Stretches to the bar's full height so the whole left of the row is the hit target,
  // matching the comment overview's full-width disclosure button.
  const toggleClass =
    "flex h-full min-w-0 flex-1 items-center gap-1.5 text-xs text-text-muted hover:text-foreground";

  return (
    // Open, it fills its resize panel (the seam handle below draws the separator line)
    // and the tree scrolls within whatever height the panel was fitted or dragged to.
    // Collapsed, the section *is* the bar, carrying its own border down to the file tree.
    <div
      className={cn(
        "flex flex-col",
        expanded ? "h-full min-h-0" : "shrink-0 border-b border-border",
      )}
    >
      <div ref={headerRef} className="flex h-9 shrink-0 items-center gap-1 px-2">
        {/* The narrow rail has no room for a coverage chip beside the controls, so the
            full readout — headline % and the line/file counts — lives in a tooltip on
            the disclosure; the inferred "Not covered" row carries the at-a-glance signal. */}
        {/* Anchored to the whole header row, not the trigger: the readout clears the
            sidebar entirely and opens over the diff, so it never has to fit the rail's
            width. The trigger alone would fall short of the edge whenever "Show all"
            is present and shortens it. */}
        <TooltipHint
          disabled={summary.coverableLines === 0}
          side="right"
          align="center"
          anchor={headerRef}
          content={
            <div className="flex flex-col gap-0.5">
              <span className="tabular-nums">{summary.linePct}% covered by layers</span>
              <span className="tabular-nums text-background/70">
                {summary.coveredLines}/{summary.coverableLines} changed lines ·{" "}
                {summary.coveredFiles} of {summary.coverableFiles} files
              </span>
            </div>
          }
        >
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
            className={toggleClass}
          >
            {disclosure}
          </button>
        </TooltipHint>
        {/* Collapsed, the rows that would explain a solo aren't on screen — so the way
            back to the full diff rides with them, not on the bare bar. */}
        {expanded && activeLayerId !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => setActiveLayer(null)}
          >
            Show all
          </Button>
        )}
      </div>
      {expanded && (
        <div
          ref={fit?.viewportRef}
          role="tree"
          aria-label="Layers"
          aria-activedescendant={selectedId === null ? undefined : rowDomId(selectedId)}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            const row = rowAtEvent(event.target);
            if (row === null) {
              return;
            }
            // Clicking the soloed row again clears back to the full diff. The doc row has
            // no such toggle — leaving it is "Browse all files", not a second click.
            if (row.kind !== "overview" && row.id === activeLayerId) {
              setActiveLayer(null);
              return;
            }
            select(row.id);
          }}
          // pb-1 only (no top padding): the header already carries its own bottom inset,
          // so a tree top pad would push the first row down and make the header read
          // as bottom-heavy — the gap above the bar's label must equal the gap down to
          // the first row.
          className="min-h-0 flex-1 overflow-y-auto pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <div ref={fit?.contentRef}>
            {visible.map((row) => (
              <TreeRow
                key={row.id}
                row={row}
                selected={row.id === selectedId}
                expanded={!collapsed.has(row.id)}
                onSelect={() => select(row.id)}
                onToggle={() => toggle(row.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
