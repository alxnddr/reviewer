import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileWarning, Layers, MessageSquare, PackageCheck, Search } from "lucide-react";
import type { RecentReview } from "../../../shared/recent-reviews";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { filterRecents, recentRange, recentTitle, showsRange } from "@/lib/recent-reviews";
import { absoluteTime, shortAge } from "@/lib/relative-time";
import { useCoarseNow } from "@/lib/use-coarse-now";
import { useRecentReviewsStore } from "@/stores/recent-reviews";
import { useReviewStore } from "@/stores/review";

// Every review `rvw` has emitted on this machine, newest first — the way back to a review the
// reader has already closed, or one their agent wrote while they were somewhere else.
//
// It floats, and it is glass, which the app's own rule (see Glass.tsx / index.css) otherwise
// reserves for controls that live over the reader's content for as long as they are working.
// This is the third case and a different one: it is a lens held up over the page rather than a
// slab dropped on it, and it is gone the moment it is used. What glass buys here is that the
// diff behind it stays *present* — the reader can see they are on top of their work rather
// than having navigated away from it — which is exactly the reassurance a picker opened by
// accident needs to give.
//
// It is virtualized because the directory it lists is append-only: one file per review, never
// swept, for as long as the reader keeps using the app. A year in, this is a list of hundreds,
// and every row carries a hover hint and its own age — the same reasoning that virtualized the
// commit brush, and the same fixed-height treatment, since every row here is exactly two lines.
//
// The keyboard contract is the combobox one, not roving tabindex: focus never leaves the
// filter field, and the cursor is `aria-activedescendant` pointing at a row. That is the only
// arrangement that survives virtualization — a focused row that scrolls out of the window is
// unmounted, and focus would land back on the body mid-list.

/** Two lines of text plus the row's own padding. Fixed, so the virtualizer needs no
 * measurement pass and an index maps straight to an offset. */
const ROW_PX = 56;

/** Rows kept mounted past each edge, so a flick of the wheel lands on painted rows. */
const OVERSCAN = 6;

/** How far ⇞/⇟ jump. A screenful is the honest answer but depends on the panel's height at
 * the time; a round number that is clearly more than an arrow and clearly less than End is
 * what the key is actually for. */
const PAGE_ROWS = 8;

export function RecentReviews(): ReactElement {
  const open = useRecentReviewsStore((state) => state.open);
  const close = useRecentReviewsStore((state) => state.close);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <DialogPrimitive.Portal>
        {/* Dimmer than the kit's backdrop and blurred a little harder: this panel is itself
            translucent, and over an un-dimmed diff the two layers of code — the real one
            behind and the rows in front — compete at the same contrast. */}
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/15 duration-150 supports-backdrop-filter:backdrop-blur-sm data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
        {/* Held above centre rather than in it. A list that grows downward from a fixed top
            edge does not jump as it is filtered, and the reader's eye is already at the top
            of it, on the field they are typing into. */}
        <DialogPrimitive.Popup
          data-glass
          className="fixed top-[10vh] left-1/2 z-50 flex max-h-[72vh] w-[min(46rem,calc(100%-4rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl duration-150 outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
        >
          <RecentReviewsPanel />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The panel's insides, mounted only while it is open — which is what makes "the cursor
 * starts at the top" and "the field has focus" properties of opening rather than effects that
 * have to be undone on close. */
function RecentReviewsPanel(): ReactElement {
  const phase = useRecentReviewsStore((state) => state.phase);
  const dir = useRecentReviewsStore((state) => state.dir);
  const truncated = useRecentReviewsStore((state) => state.truncated);
  const unreadable = useRecentReviewsStore((state) => state.unreadable);
  const query = useRecentReviewsStore((state) => state.query);
  const allReviews = useRecentReviewsStore((state) => state.reviews);
  const activeIndex = useRecentReviewsStore((state) => state.activeIndex);
  const setQuery = useRecentReviewsStore((state) => state.setQuery);
  const moveCursor = useRecentReviewsStore((state) => state.moveCursor);
  const setCursor = useRecentReviewsStore((state) => state.setCursor);
  const close = useRecentReviewsStore((state) => state.close);
  const openReviewByPath = useReviewStore((state) => state.openReviewByPath);

  // Filtered here rather than through a store selector: the filter builds a new array every
  // time it runs, and a zustand selector that never returns a stable reference re-renders on
  // every store read. The store applies the same function to move its cursor, so the two
  // cannot disagree about which row is row 3.
  const reviews = useMemo(() => filterRecents(allReviews, query), [allReviews, query]);
  const total = allReviews.length;
  const listId = useId();
  const titleId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const now = useCoarseNow();

  /** A row taking the cursor on hover — but only for a pointer that has actually moved.
   *
   * Chromium re-dispatches `mousemove` when content appears *under* a stationary pointer, so
   * without this the panel opened by ⇧⌘R hands its cursor to whichever row happens to land
   * beneath the mouse, wherever the reader last left it. The list then looks right and Enter
   * opens the wrong review — the worst kind of wrong, because nothing on screen says so.
   * Comparing client coordinates against the last event tells a real gesture from a
   * synthesized one; `mouseenter` cannot, since it fires for both. */
  const hoverRow = useCallback(
    (index: number, event: ReactMouseEvent<HTMLDivElement>): void => {
      const last = pointerRef.current;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      // The first event of an opening only establishes where the pointer is — it is the one
      // most likely to be the synthesized one. A real hover travels, so its next event lands
      // a pixel later and takes the cursor then; clicking is unaffected either way, since a
      // click carries its own row index rather than reading the cursor.
      if (last === null || (last.x === event.clientX && last.y === event.clientY)) {
        return;
      }
      setCursor(index);
    },
    [setCursor],
  );

  // The panel exists to be typed into, and it is mounted only while open, so this is once per
  // opening. Explicit rather than left to the dialog's own initial-focus rule: which element
  // that lands on is a detail of the primitive, and everything here depends on it being this
  // field — the arrow keys are bound to it, and the cursor is its `aria-activedescendant`.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rowDomId = useCallback((index: number) => `${listId}-row-${index}`, [listId]);

  const virtualizer = useVirtualizer({
    count: reviews.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: OVERSCAN,
  });

  // The cursor is moved by the keyboard, so the list — not the reader — is responsible for
  // keeping it in view. `auto` scrolls only when the row is actually outside, which is what
  // keeps a ↓ through the middle of a screenful from scrolling on every press.
  useEffect(() => {
    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    }
  }, [activeIndex, virtualizer]);

  const openAt = useCallback(
    (index: number): void => {
      const review = reviews[index];
      if (review === undefined) {
        return;
      }
      // Closed first, and closed unconditionally. An artifact that will not open reports
      // through the app's standing review-open banner, which is *behind* this panel — leaving
      // it up would swallow the only explanation the reader gets.
      close();
      void openReviewByPath(review.path);
    },
    [reviews, close, openReviewByPath],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      // Every key here is a list command typed while focus is in a text field, so each one
      // that the field would otherwise act on (Home/End move the caret) is claimed explicitly.
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveCursor(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          moveCursor(-1);
          return;
        case "PageDown":
          event.preventDefault();
          moveCursor(PAGE_ROWS);
          return;
        case "PageUp":
          event.preventDefault();
          moveCursor(-PAGE_ROWS);
          return;
        case "Home":
          event.preventDefault();
          moveCursor(-reviews.length);
          return;
        case "End":
          event.preventDefault();
          moveCursor(reviews.length);
          return;
        case "Enter":
          event.preventDefault();
          openAt(activeIndex);
          return;
        default:
          return;
      }
    },
    [moveCursor, openAt, activeIndex, reviews.length],
  );

  return (
    <>
      {/* The panel's name, for the screen reader only: on screen the search field and the
          rows say what this is, and a heading above them would be a label on a thing that is
          already labelled. Through the primitive's own Title so the popup picks it up as its
          accessible name without a second `aria-labelledby` to keep in sync. */}
      <DialogPrimitive.Title id={titleId} className="sr-only">
        Recent reviews
      </DialogPrimitive.Title>
      <header className="flex items-center gap-2.5 border-b border-foreground/10 px-4">
        <Search aria-hidden="true" className="size-4 shrink-0 text-text-faint" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-labelledby={titleId}
          aria-activedescendant={activeIndex >= 0 ? rowDomId(activeIndex) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search your reviews"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-13 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-text-faint"
        />
        {/* The count is of what is on screen, and says so when a filter is narrowing it —
            "12 of 340" is the fact a reader typing into a search field wants; a bare "12"
            leaves them wondering whether the rest were dropped or never existed. */}
        {phase === "loaded" && total > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-text-faint">
            {reviews.length === total
              ? `${total} ${total === 1 ? "review" : "reviews"}`
              : `${reviews.length} of ${total}`}
          </span>
        )}
      </header>

      {phase !== "loaded" ? (
        // Not a spinner. The read is one directory listing and a few small parses — it
        // resolves inside a frame or two on any real reviews folder — so a spinner would be a
        // flash of anxiety, where an empty field of the right height is simply the panel
        // before its rows land.
        <div className="min-h-40 flex-1" />
      ) : reviews.length === 0 ? (
        <EmptyRecents query={query} total={total} dir={dir} unreadable={unreadable} />
      ) : (
        <div
          ref={scrollRef}
          id={listId}
          role="listbox"
          aria-labelledby={titleId}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const review = reviews[item.index];
              return review === undefined ? null : (
                <RecentRow
                  key={review.path}
                  id={rowDomId(item.index)}
                  review={review}
                  now={now}
                  active={item.index === activeIndex}
                  offset={item.start}
                  onHover={(event) => hoverRow(item.index, event)}
                  onOpen={() => openAt(item.index)}
                />
              );
            })}
          </div>
        </div>
      )}

      <footer className="flex items-center justify-between gap-4 border-t border-foreground/10 px-4 py-2 text-xs text-text-faint">
        {/* The directory, always — this panel is a view of one folder on disk, and a reader
            who wants to go and look at it, or point a script at it, should not have to find
            that out from the docs. Truncation is reported in the same breath, because "these
            are your reviews" would otherwise be false. */}
        <span className="min-w-0 truncate font-mono" title={dir ?? undefined}>
          {dir ?? ""}
          {truncated > 0 && ` · ${truncated} older not shown`}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⏎</Kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd>
            close
          </span>
        </span>
      </footer>
    </>
  );
}

/** The three ways this list is empty, which are three different sentences. A filter that
 * matched nothing is the reader's own doing and needs no explanation beyond saying so; a
 * directory that would not open is a fault worth naming; a directory with nothing in it is the
 * ordinary state of a machine that has not been reviewed on yet, and gets the same answer the
 * start screen gives — ask your agent. */
function EmptyRecents({
  query,
  total,
  dir,
  unreadable,
}: {
  query: string;
  total: number;
  dir: string | null;
  unreadable: boolean;
}): ReactElement {
  const filtered = total > 0;
  return (
    <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-1.5 px-8 py-10 text-center">
      <p className="text-sm text-foreground">
        {filtered
          ? "No review matches that"
          : unreadable
            ? "That folder would not open"
            : "No reviews yet"}
      </p>
      <p className="max-w-sm text-xs leading-relaxed text-text-muted">
        {filtered ? (
          <>
            Nothing in your reviews matches <span className="font-mono">{query.trim()}</span>.
          </>
        ) : unreadable ? (
          <>
            <span className="font-mono">{dir}</span> exists but could not be read — check its
            permissions.
          </>
        ) : (
          <>
            Reviews your agent publishes with <span className="font-mono">rvw</span> land in{" "}
            <span className="font-mono">{dir}</span> and show up here.
          </>
        )}
      </p>
    </div>
  );
}

/** One review, two lines: what the change is, then which change it is. The same division the
 * commit rows in the rail make, and for the same reason — line one is read, line two is
 * checked. */
function RecentRow({
  id,
  review,
  now,
  active,
  offset,
  onHover,
  onOpen,
}: {
  id: string;
  review: RecentReview;
  now: Date;
  active: boolean;
  offset: number;
  onHover: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onOpen: () => void;
}): ReactElement {
  const summary = review.summary;
  return (
    // Not a <button>: focus stays in the filter field (see the module note), so this is an
    // option in a listbox that the pointer can also click. `onMouseMove` rather than
    // `onMouseEnter` — a list that scrolls under a stationary pointer fires enter events for
    // rows the reader never moved to, and the cursor would jump away from their arrow keys.
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onOpen}
      // Height stated, not implied by the content: the virtualizer places rows by index times
      // `ROW_PX`, so a row that lays out to anything else would drift from its own slot.
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        height: `${ROW_PX}px`,
        transform: `translateY(${offset}px)`,
      }}
      className={cn(
        "flex w-full cursor-pointer flex-col justify-center gap-0.5 rounded-lg px-2.5",
        active && "bg-foreground/8 dark:bg-foreground/10",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {recentTitle(review)}
        </span>
        <span
          className="shrink-0 text-xs tabular-nums text-text-faint"
          title={absoluteTime(review.modified)}
        >
          {shortAge(review.modified, now)}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
        {summary === null ? (
          <span className="flex items-center gap-1.5 text-text-faint">
            <FileWarning aria-hidden="true" className="size-3.5 shrink-0" />
            Not a readable review
          </span>
        ) : (
          <>
            <span className="shrink-0 font-medium text-text-muted">{summary.repoName}</span>
            {/* Absent when the line above already *is* the range — an untitled review would
                otherwise print its endpoints twice, once as its name and once as its
                subtitle. */}
            {showsRange(review) && (
              <>
                <span aria-hidden="true" className="text-text-faint">
                  ·
                </span>
                <span className="min-w-0 truncate font-mono">{recentRange(summary)}</span>
              </>
            )}
            {summary.comments > 0 && (
              <Meta icon={<MessageSquare aria-hidden="true" className="size-3 shrink-0" />}>
                {summary.comments}
              </Meta>
            )}
            {summary.layers > 0 && (
              <Meta icon={<Layers aria-hidden="true" className="size-3 shrink-0" />}>
                {summary.layers}
              </Meta>
            )}
            {/* The one badge on the row, and it earns its place by predicting the click:
                a refs-only review of a repo that has since moved will not open, and this
                is the artifact that opens anywhere. */}
            {summary.portable && (
              <span
                title="Carries its own diff — opens without the repo"
                className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-foreground/8 px-1.5 py-0.5 text-[11px] text-text-muted dark:bg-foreground/12"
              >
                <PackageCheck aria-hidden="true" className="size-3" />
                self-contained
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Meta({ icon, children }: { icon: ReactElement; children: number }): ReactElement {
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums">
      {icon}
      {children}
    </span>
  );
}
