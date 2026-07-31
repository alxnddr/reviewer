import { useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Layers as LayersIcon } from "lucide-react";
import type { ReviewLayer } from "../../../shared/review";
import { clamp } from "../../../shared/clamp";
import type { PatchFile } from "../../../shared/diff/patch";
import type { FitToContentRefs } from "@/lib/fit-panel";
import { layerOutline, resolveLayerScroll } from "../../../shared/layers";
import { coverageFor } from "@/lib/soloed-diff";
import { layerTally, NO_READ_FILES, type ReadTally } from "@/lib/read-progress";
import { useScrollIntoViewById } from "@/lib/use-scroll-into-view";
import { RAIL_ACTIVE_ITEM, RAIL_GLYPH, RAIL_LIST, RailRow, RailSection } from "@/components/rail";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { ReadRing, readLabel } from "@/components/ReadRing";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The review's table of contents, as a tree. `layers` nests, so the rail is a tree widget
// and not a flat list pretending: a row indents under its parent, a parent discloses, and
// the section number (`4.2.1`) is the same one the doc and the band print.
//
// Every row here is a layer. The tour doc used to lead the tree as a row of its own, which
// meant a widget where selecting a row solos a layer had one row that soloed nothing and
// went somewhere else entirely; it now sits above this section as its own rail item
// (`OverviewRow`), and everything below is uniformly layers.
//
// Every row is a real place to stand, parents included — selecting one solos its whole
// extent (itself plus everything under it), selecting a child narrows to that section.
// That is the aggregation rule from shared/layers.ts, and it is why there is no second kind
// of row here with different rules: one row type, one gesture, two scopes.
//
// Hand-built `tree`/`treeitem` rather than a component library: the active descendant *is*
// the soloed layer, so roving and soloing are the same move, and the arrow keys have to
// walk what is on screen (a collapsed subtree is skipped) while the diff-side chevrons walk
// the whole review. The pure stepping/solo/outline logic lives in shared/layers.ts.

/** Per-level indent. Enough to read as nesting at a glance in a 256px rail, small enough
 * that the cap (five levels) still leaves a usable label column. */
const INDENT_PX = 12;
/** The twisty's slot, held open on childless rows so labels line up within a level. */
const TWISTY_PX = 16;

/** Nothing measured: any layer the loaded diff carries no file for. A shared constant so
 * those rows hand `ReadRing` one stable reference rather than a fresh object per render. */
const NO_TALLY: ReadTally = { read: 0, total: 0 };

/** Stable empty arrays, so a layer-less session and an unloaded diff hand the selectors
 * below one constant reference rather than a fresh [] that would re-render every tick. */
const EMPTY_LAYERS: ReviewLayer[] = [];
const EMPTY_FILES: PatchFile[] = [];

function rowDomId(id: string): string {
  return `layer-row-${id}`;
}

/** What the rail draws, flattened to rows in document order. The tree shape survives as
 * `depth` + `expandable`, which is all a row needs to render and all the keyboard needs to
 * move: everything structural was already decided by `layerOutline`. */
type Row = {
  id: string;
  kind: "layer" | "uncovered";
  depth: number;
  /** Null on the inferred row, which is no authored step. */
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
  /** The row the keyboard is on — the soloed one, or the cursor while nothing is. */
  current: boolean;
  expanded: boolean;
  onToggle: () => void;
};

/** One row: indent, twisty, section number, label. One line — the rail is scanned, and a
 * second line of prose per row buries the shape the indentation exists to show. The
 * summary rides in the hover hint, where it costs nothing.
 *
 * Nothing here selects. The tree container delegates every click through `data-row-id`
 * below, so selecting a row and clicking the soloed row again to clear it have exactly one
 * owner — a second handler on the label would fire the first half of that pair twice and
 * leave the clear reachable only by whichever handler read the staler `activeLayerId`. */
function TreeRow({ row, selected, current, expanded, onToggle }: LayerRowProps): ReactElement {
  const glyph =
    row.kind === "uncovered" ? <AlertTriangle aria-hidden="true" className={RAIL_GLYPH} /> : null;

  return (
    <RailRow
      role="treeitem"
      id={rowDomId(row.id)}
      data-row-id={row.id}
      aria-selected={selected}
      aria-level={row.depth + 1}
      {...(row.expandable ? { "aria-expanded": expanded } : {})}
      indent={row.depth * INDENT_PX}
      selected={selected}
      // A row inside the soloed layer's extent, or on the trail up to it, reads in full
      // ink rather than a second fill: "part of what you are looking at" must never
      // compete with "this is the thing you picked".
      quiet={!row.related}
      // The row the arrow keys are on is this tree's `aria-activedescendant`, so it is
      // the row the focus ring belongs to.
      className={cn("pr-2", current && RAIL_ACTIVE_ITEM)}
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
          {expanded ? (
            <ChevronDown className={RAIL_GLYPH} />
          ) : (
            <ChevronRight className={RAIL_GLYPH} />
          )}
        </button>
      ) : (
        <span style={{ width: TWISTY_PX }} className="shrink-0" />
      )}
      {glyph}
      {row.ordinal !== null && (
        // The number reads as part of the name, not as metadata beside it: same size, same
        // ink as the label it numbers, inherited from the row so it tracks the row's state
        // instead of keeping its own pair of greys.
        <span className="shrink-0 tabular-nums">{row.ordinal}</span>
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
        <span className="min-w-0 flex-1 truncate text-sm">{row.label}</span>
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
    </RailRow>
  );
}

type LayerListProps = {
  /** Disclosure is owned by the rail (`ReviewRail`) so it can host the open tree in a
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
 * session's persisted diff/scroll.
 *
 * A section, so it reads its own state (the rail's rule, `ReviewRail.tsx`); what it takes
 * from the rail is the disclosure and the panel it is fitted through. */
export function LayerList({
  expanded,
  onToggleExpanded,
  fit,
}: LayerListProps): ReactElement | null {
  const layers = useReviewStore((state) => selectActiveSlice(state)?.layers ?? EMPTY_LAYERS);
  const activeLayerId = useReviewStore((state) => selectActiveSlice(state)?.activeLayerId ?? null);
  // Whether the tour doc is the current stop. No row here is selected while it is (the
  // store clears the solo when the doc opens, and the doc's own row lives above this
  // section) — but the escape back to the full diff still belongs in this header, because
  // leaving the doc and leaving a soloed layer are the same move to the same place.
  const overviewOpen = useReviewStore((state) => selectActiveSlice(state)?.overviewOpen ?? false);
  // The full loaded diff — never the soloed subset — so each layer's outdated flag and
  // each row's tally are resolved against the whole file set.
  const files = useReviewStore((state) => {
    const diff = selectActiveSlice(state)?.diff;
    return diff !== undefined && diff.phase === "loaded" ? diff.files : EMPTY_FILES;
  });
  // True when the review pins its own frozen patch: every layer anchor places against it,
  // so no layer wears the outdated chip — the same rule the comment surface applies to a
  // frozen review.
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  const readFiles = useReviewStore((state) => selectActiveSlice(state)?.readFiles ?? NO_READ_FILES);

  // The computed coverage of the loaded diff by these layers — same core the `rvw
  // coverage` CLI reports, so the header number and the CLI never disagree. `uncovered`
  // is the inferred remainder, present only when a coverable file sits in no layer at all.
  // Through the shared derivation, so the header shares the walk the solo already paid for
  // rather than scanning the diff a second time for the same report.
  const summary = useMemo(() => coverageFor(files, layers), [files, layers]);
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
        summary: entry.layer.summary ?? null,
        expandable: entry.children.length > 0,
        hidden,
        outdated: outdatedIds.has(entry.layer.id),
        related: related.has(entry.layer.id),
        read: tallies.get(entry.layer.id) ?? NO_TALLY,
      };
    });
    return [
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
              summary: uncovered.summary ?? null,
              expandable: false,
              hidden: false,
              outdated: false,
              related: false,
              read: tallies.get(uncovered.id) ?? NO_TALLY,
            },
          ]),
    ];
  }, [outline, collapsed, outdatedIds, uncovered, activeLayerId, tallies]);

  // Where the keyboard is, when nothing is soloed. Arrow keys in this tree solo as they
  // move — roving and soloing are one gesture here — so a reader who has only *arrived*
  // has no soloed row for the focus ring to sit on, and a ring around the whole tree
  // says "you are on the list" when the next keypress will act on a row. The cursor is
  // that row, named before it is chosen: it takes the ring, it is what
  // `aria-activedescendant` points at, and it is where the first arrow steps from. It
  // solos nothing by existing, and it goes away when focus does.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const selectedId = activeLayerId;
  const currentId = selectedId ?? cursorId;

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

  // Keep the selected row visible as the selection walks the tree.
  useScrollIntoViewById(selectedId === null ? null : rowDomId(selectedId), { block: "nearest" }, [
    selectedId,
    rows,
  ]);

  // Nothing to walk: the section is absent entirely. A review with a doc but no layers is
  // now just the doc's own row above, with no empty Layers bar under it.
  if (layers.length === 0) {
    return null;
  }

  const visible = rows.filter((row) => !row.hidden);

  /** Every row is a layer, so going where one points is one call. */
  const select = (id: string): void => setActiveLayer(id);

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
    const index = visible.findIndex((row) => row.id === currentId);
    const next =
      index === -1
        ? direction === 1
          ? 0
          : visible.length - 1
        : clamp(index + direction, 0, visible.length - 1);
    const target = visible[next];
    if (target !== undefined) {
      select(target.id);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = rows.find((row) => row.id === currentId) ?? null;
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
        const last = visible.at(-1);
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

  // No count on the bar. It read as informative and wasn't: how many layers a review has
  // is not a number anyone acts on — you read the layers, you don't tally them — and the
  // one place it appeared was the collapsed bar, so the only thing it actually did was
  // make the label change out from under the reader at the moment they clicked to fold
  // the section. A heading that renames itself when you collapse it is a heading you have
  // to re-read. The comment bar keeps its count because that one *is* acted on, and it
  // keeps it in both states for exactly this reason.
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
      <RailSection
        expanded={expanded}
        onSelect={onToggleExpanded}
        bordered={false}
        icon={<LayersIcon aria-hidden="true" className={RAIL_GLYPH} />}
        // The narrow rail has no room for a coverage chip beside the controls, so the
        // full readout — headline % and the line/file counts — rides the bar's own hint;
        // the inferred "Not covered" row carries the at-a-glance signal.
        tooltipDisabled={summary.coverableLines === 0}
        tooltip={
          <div className="flex flex-col gap-0.5">
            <span className="tabular-nums">{summary.linePct}% covered by layers</span>
            <span className="tabular-nums text-background/70">
              {summary.coveredLines}/{summary.coverableLines} changed lines · {summary.coveredFiles}{" "}
              of {summary.coverableFiles} files
            </span>
          </div>
        }
        action={
          // The way out of wherever the reader is standing, whether that is a soloed layer
          // or the doc — both are places the rail put them, and both are left by the same
          // call to the same destination, so one control serves both rather than the doc
          // having to grow its own.
          //
          // Collapsed, the rows that would explain a solo aren't on screen — so this rides
          // with them, not on the bare bar.
          expanded && (activeLayerId !== null || overviewOpen) ? (
            <Button
              variant="chrome"
              size="sm"
              // Size and ink overriding the variant's own: it rides the Layers bar and has
              // to read as part of it — same 14px, same muted ink, same lift to full ink
              // under the pointer as the bar's own label (see `RailSection`).
              className="shrink-0 text-sm text-text-muted"
              onClick={() => setActiveLayer(null)}
            >
              View all
            </Button>
          ) : undefined
        }
      >
        Layers
      </RailSection>
      {expanded && (
        <div
          ref={fit?.viewportRef}
          role="tree"
          aria-label="Layers"
          aria-activedescendant={currentId === null ? undefined : rowDomId(currentId)}
          tabIndex={0}
          onFocus={() => {
            if (selectedId === null && cursorId === null) {
              setCursorId(visible[0]?.id ?? null);
            }
          }}
          onBlur={() => setCursorId(null)}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            const row = rowAtEvent(event.target);
            if (row === null) {
              return;
            }
            // Clicking the soloed row again clears back to the full diff.
            if (row.id === activeLayerId) {
              setActiveLayer(null);
              return;
            }
            select(row.id);
          }}
          // pb-1 only (no top padding): the header already carries its own bottom inset,
          // so a tree top pad would push the first row down and make the header read
          // as bottom-heavy — the gap above the bar's label must equal the gap down to
          // the first row.
          className={cn("min-h-0 flex-1 overflow-y-auto pb-1", RAIL_LIST)}
        >
          <div ref={fit?.contentRef}>
            {visible.map((row) => (
              <TreeRow
                key={row.id}
                row={row}
                selected={row.id === selectedId}
                current={row.id === currentId}
                expanded={!collapsed.has(row.id)}
                onToggle={() => toggle(row.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
