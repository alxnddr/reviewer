import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { LogEntry } from "../../../shared/git";
import {
  RAIL_ACTIVE_ITEM,
  RAIL_LIST,
  RAIL_ROW_TALL_PX,
  RailNote,
  RailRow,
  RailRowMeta,
} from "@/components/rail";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { absoluteTime, shortAge } from "@/lib/relative-time";
import { useCoarseNow } from "@/lib/use-coarse-now";
import { brushContains, logEntryKey, type BrushRange } from "@/lib/selection";
import { useReviewStore } from "@/stores/review";

// Hand-built listbox: no registry piece offers brush range-selection — pointer
// drag across rows plus shift/arrow extension. The ARIA contract is a
// multiselectable listbox whose options form one contiguous band; the store's
// reducer guarantees contiguity.
//
// Virtualized, unlike every other list in the rail. The others are bounded by something
// a person wrote — a review's layers, its comments, one diff's files — and render whole.
// This one is bounded by the repository: `git log` comes back with up to 2000 entries
// (LOG_MAX_COUNT), and every row here carries a hover hint, so rendering the lot would
// mount two thousand tooltip triggers and reconcile them on every frame of a
// range-brush drag — the one gesture in this list that has to stay smooth.
//
// Fixed-size, because the rail has exactly one row height (RAIL_ROW_PX): no measurement
// pass, no cumulative offsets, and an index maps to an offset exactly. The rendered rows
// stay in normal flow inside one translated block (TanStack's own recommendation over
// absolutely positioning each row), so a row is laid out here exactly as it is anywhere
// else in the rail and `elementFromPoint` still finds it mid-drag.

/** How close to the list edge (px) a drag must get before the list auto-scrolls. */
const DRAG_SCROLL_MARGIN = 24;

/** Rows kept mounted beyond each edge of the viewport. Enough that a flick of the wheel
 * lands on painted rows, small enough that the list stays cheap. */
const OVERSCAN = 8;

function rowDomId(index: number): string {
  return `commit-brush-option-${index}`;
}

function rowIndexAtPoint(x: number, y: number): number | null {
  const row = document.elementFromPoint(x, y)?.closest("[data-brush-index]");
  if (!(row instanceof HTMLElement) || row.dataset["brushIndex"] === undefined) {
    return null;
  }
  const index = Number(row.dataset["brushIndex"]);
  return Number.isInteger(index) ? index : null;
}

type CommitRowProps = {
  entry: LogEntry;
  index: number;
  selected: boolean;
  focused: boolean;
  now: Date;
  /** Where this row sits in the virtual list, in px from its top. */
  offset: number;
};

/** One commit: what it is, then which one it is.
 *
 * Line one is the subject, in the ink you read with — a thirty-row history set entirely
 * in muted grey is a wall, and the subject is the one thing on the row anyone actually
 * reads — with the age at the outer edge, in the rail's meta column. Line two is the
 * identity: the short sha, then who wrote it. Those two are not decoration a hint can
 * absorb; they are how a reviewer confirms the commit is the one they meant, and a
 * confirmation you have to hover for is one you will not make.
 *
 * The band of selected rows is a flat fill running the rail's full width, like every
 * other selection in the rail. It used to round its top and bottom rows into a pill —
 * the only rounded corners in a column of square ones, which said the band was a
 * floating object rather than a run of rows, and put a hairline of unfilled surface
 * beside the first and last commit of the very range being selected. */
function CommitRow({ entry, index, selected, focused, now, offset }: CommitRowProps): ReactElement {
  const sub =
    entry.kind === "uncommitted"
      ? "working tree"
      : `${entry.commit.shortSha} · ${entry.commit.author}`;

  return (
    <RailRow
      role="option"
      id={rowDomId(index)}
      data-brush-index={index}
      aria-selected={selected}
      lines="two"
      selected={selected}
      quiet={false}
      className={cn(
        // The focus end of the band — where shift+arrow extends from, and this
        // listbox's `aria-activedescendant` — wears the ring while the list has the
        // keyboard, which is the whole of this list's focus indicator.
        focused && RAIL_ACTIVE_ITEM,
      )}
      // Each row placed at its own offset rather than the whole block translated to the
      // first one's: the rendered range is not always contiguous — the focused row is
      // kept mounted wherever it is (see `rangeExtractor`) — and a translated block can
      // only express a run.
      style={{ position: "absolute", top: 0, left: 0, transform: `translateY(${offset}px)` }}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {entry.kind === "uncommitted" ? (
          // The one row that is not a commit, and the one whose meaning is not on it:
          // what counts as "uncommitted" (staged? unstaged? both?) is exactly the
          // question a reviewer has before they trust the diff it loads. It carries no
          // age — it is always now — so the meta column simply stays empty.
          <TooltipHint
            side="right"
            align="center"
            content="Everything not yet committed — staged and unstaged, against HEAD"
          >
            <span className="min-w-0 flex-1 truncate">Uncommitted changes</span>
          </TooltipHint>
        ) : (
          <>
            {/* The hint hangs off the subject, not the row: the row is the drag target
                for range-brushing, and a popup tracking the pointer through a drag would
                follow it across the whole list. It carries what the two lines cannot —
                the subject in full, and the date behind the age. */}
            <TooltipHint
              side="right"
              align="center"
              content={
                <div className="flex flex-col gap-0.5">
                  <span className="whitespace-pre-wrap">{entry.commit.subject}</span>
                  <span className="text-background/70">
                    {`${entry.commit.author} · ${absoluteTime(entry.commit.authoredAt)}`}
                  </span>
                </div>
              }
            >
              <span className="min-w-0 flex-1 truncate">{entry.commit.subject}</span>
            </TooltipHint>
            <RailRowMeta>{shortAge(entry.commit.authoredAt, now)}</RailRowMeta>
          </>
        )}
      </span>
      {/* The sha keeps tabular figures so the column of them reads as a column; the
          author trails it in the same quiet ink. */}
      <span
        className={cn(
          "w-full min-w-0 truncate text-xs",
          selected ? "text-foreground/80" : "text-text-muted",
        )}
      >
        <span className="tabular-nums">{sub}</span>
      </span>
    </RailRow>
  );
}

type CommitBrushListProps = {
  entries: LogEntry[];
  brush: BrushRange | null;
  /** The line under the list (the range affordance), or null. */
  foot: ReactNode;
  /** What the list says when there are no rows to brush. */
  emptyMessage: ReactNode;
};

export function CommitBrushList({
  entries,
  brush,
  foot,
  emptyMessage,
}: CommitBrushListProps): ReactElement {
  const previewBrush = useReviewStore((state) => state.previewBrush);
  const commitBrush = useReviewStore((state) => state.commitBrush);
  const applyBrush = useReviewStore((state) => state.applyBrush);

  const listRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);

  const now = useCoarseNow();

  const focusIndex = brush?.focus ?? null;
  // Where the keyboard is when the brush names nothing — a restored session whose
  // selection the log could no longer place. Same job as the layer tree's cursor: the
  // row the ring sits on and the row the first arrow steps from, chosen on arrival and
  // dropped when focus leaves, so a focused list never has to ring itself.
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const currentIndex = focusIndex ?? cursorIndex;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => RAIL_ROW_TALL_PX,
    overscan: OVERSCAN,
    // The focus row stays mounted however far it is scrolled away, because
    // `aria-activedescendant` names it by id and an id that resolves to nothing is a
    // broken listbox — worse for a screen reader than an off-screen row is for anyone
    // else. This is the same lever the docs use to pin sticky headers.
    rangeExtractor: useCallback(
      (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        const rendered = defaultRangeExtractor(range);
        return currentIndex === null || rendered.includes(currentIndex)
          ? rendered
          : [...rendered, currentIndex].toSorted((a, b) => a - b);
      },
      [currentIndex],
    ),
  });

  useEffect(() => {
    // Keyboard moves must keep the focus row visible; during a drag the
    // auto-scroll loop owns the scroll position instead. `auto` alignment is
    // `scrollIntoView({ block: "nearest" })` — it moves only when the row is off screen,
    // and only far enough — which the DOM call itself can no longer do here, since the
    // row it would scroll to may not be mounted.
    if (focusIndex !== null && !draggingRef.current) {
      virtualizer.scrollToIndex(focusIndex, { align: "auto" });
    }
  }, [focusIndex, virtualizer]);

  useEffect(() => {
    return () => {
      if (dragScrollFrameRef.current !== null) {
        cancelAnimationFrame(dragScrollFrameRef.current);
      }
    };
  }, []);

  if (entries.length === 0) {
    return <RailNote>{emptyMessage}</RailNote>;
  }

  const extendAtPoint = (x: number, y: number): void => {
    const index = rowIndexAtPoint(x, y);
    if (index !== null) {
      previewBrush({ type: "extend", index });
    }
  };

  /** Holding a drag past the list edge keeps scrolling and extending — a range
   * taller than the visible list must not require wiggling the pointer. */
  const dragScrollStep = (): void => {
    dragScrollFrameRef.current = null;
    const list = listRef.current;
    const point = dragPointRef.current;
    if (!draggingRef.current || list === null || point === null) {
      return;
    }
    const rect = list.getBoundingClientRect();
    const pastTop = rect.top + DRAG_SCROLL_MARGIN - point.y;
    const pastBottom = point.y - (rect.bottom - DRAG_SCROLL_MARGIN);
    const overshoot = Math.max(pastTop, pastBottom);
    if (overshoot <= 0) {
      return;
    }
    const step = Math.min(Math.max(overshoot / 2, 2), 24);
    list.scrollTop += pastTop > 0 ? -step : step;
    const clampedY = Math.min(Math.max(point.y, rect.top + 4), rect.bottom - 4);
    extendAtPoint(point.x, clampedY);
    dragScrollFrameRef.current = requestAnimationFrame(dragScrollStep);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    const index = rowIndexAtPoint(event.clientX, event.clientY);
    if (index === null) {
      return;
    }
    draggingRef.current = true;
    dragPointRef.current = { x: event.clientX, y: event.clientY };
    listRef.current?.setPointerCapture(event.pointerId);
    previewBrush(event.shiftKey ? { type: "extend", index } : { type: "set", index });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) {
      return;
    }
    dragPointRef.current = { x: event.clientX, y: event.clientY };
    extendAtPoint(event.clientX, event.clientY);
    if (dragScrollFrameRef.current === null) {
      dragScrollFrameRef.current = requestAnimationFrame(dragScrollStep);
    }
  };

  const endDrag = (): void => {
    if (draggingRef.current) {
      draggingRef.current = false;
      dragPointRef.current = null;
      commitBrush();
    }
  };

  const items = virtualizer.getVirtualItems();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        applyBrush({ type: "step", direction: 1, extend: event.shiftKey });
        break;
      case "ArrowUp":
        event.preventDefault();
        applyBrush({ type: "step", direction: -1, extend: event.shiftKey });
        break;
      case "Home":
        event.preventDefault();
        applyBrush(event.shiftKey ? { type: "extend", index: 0 } : { type: "set", index: 0 });
        break;
      case "End": {
        event.preventDefault();
        const last = entries.length - 1;
        applyBrush(event.shiftKey ? { type: "extend", index: last } : { type: "set", index: last });
        break;
      }
      default:
        break;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Commits"
        aria-multiselectable="true"
        aria-activedescendant={currentIndex === null ? undefined : rowDomId(currentIndex)}
        tabIndex={0}
        onFocus={() => {
          if (focusIndex === null && cursorIndex === null) {
            setCursorIndex(0);
          }
        }}
        onBlur={() => setCursorIndex(null)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        // Runs edge to edge: the rows carry their own inset, so the scroll track sits
        // flush against the sidebar border instead of leaving a gutter. ring-inset keeps
        // the focus ring inside that flush edge rather than under the border.
        className={cn("min-h-0 flex-1 overflow-y-auto", RAIL_LIST)}
      >
        {/* The full height of every row, so the scrollbar means what it says, with the
            mounted block translated to where those rows would have been. */}
        <div
          role="presentation"
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => {
            const entry = entries[item.index];
            return entry === undefined ? null : (
              <CommitRow
                key={logEntryKey(entry)}
                entry={entry}
                index={item.index}
                offset={item.start}
                selected={brush !== null && brushContains(brush, item.index)}
                focused={currentIndex === item.index}
                now={now}
              />
            );
          })}
        </div>
      </div>
      {foot}
    </div>
  );
}
