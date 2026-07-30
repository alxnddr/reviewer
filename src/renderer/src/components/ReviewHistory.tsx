import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { Search } from "lucide-react";
import { RecentReviewLines } from "@/components/RecentReviewLines";
import { START_INSET, StartHeading, StartRule } from "@/components/StartChrome";
import { filterRecents, groupRecents } from "@/lib/recent-reviews";
import { cn } from "@/lib/utils";
import { useCoarseNow } from "@/lib/use-coarse-now";
import { useRecentReviewsStore } from "@/stores/recent-reviews";
import { useReviewStore } from "@/stores/review";

// Every review on this machine, newest first — the body of the start screen.
//
// The screen used to offer a *button* that opened the recents picker, which is one indirection
// too many for the thing a returning reader is almost always there to do: come back to a
// review. A door labelled "Recent reviews" asks them to remember that they have some; a list of
// them, on the page, is the same information in the form they can act on.
//
// It is banded by date rather than run as a flat column with a timestamp per row, because the
// question brought to it is temporal — "the one from this morning", "the one from last week" —
// and a column of `2h / 5h / 3d / 3d / 12d` makes the reader do that arithmetic themselves.
// `groupRecents` owns the banding.
//
// The search field is *in* the page, not behind a shortcut. The ⇧⌘R picker still exists and is
// still the right thing when you are inside a review — it opens over your work, searches, and is
// gone again — but reaching for a modal while standing on a page whose whole content is that
// same list would be a door into the room you are in. Both filter through `filterRecents`, so
// the two lists cannot disagree about what a query matches.
//
// Two elements, not one: a bar that stays put and a scroller under it. That is what makes the
// list the part of the screen that moves — the instructions above it are two lines a reader
// reads once and then scrolls past forever, and the field that narrows a long list must not
// scroll off the top of it.
//
// Everything main answered with is listed (it caps its own read at RECENT_MAX and reports what
// it left off) — there is a scrollbar, so there is no reason to show eight and hide the rest.

export function ReviewHistory(): ReactElement {
  const phase = useRecentReviewsStore((state) => state.phase);
  const reviews = useRecentReviewsStore((state) => state.reviews);
  const dir = useRecentReviewsStore((state) => state.dir);
  const truncated = useRecentReviewsStore((state) => state.truncated);
  const unreadable = useRecentReviewsStore((state) => state.unreadable);
  const openReviewByPath = useReviewStore((state) => state.openReviewByPath);
  const now = useCoarseNow();
  // Local, not in the store: a query is one reader's half-typed thought on one tab, and every
  // start tab keeps its own (App keys this screen by the tab it belongs to).
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const total = reviews.length;
  const matches = useMemo(() => filterRecents(reviews, query), [reviews, query]);
  const groups = useMemo(() => groupRecents(matches, now), [matches, now]);

  const open = (path: string): void => void openReviewByPath(path);

  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      // The first match, which is what a reader who typed three letters and pressed return
      // meant — the same bargain the picker's own Enter makes.
      case "Enter": {
        const first = matches[0];
        if (first !== undefined) {
          event.preventDefault();
          open(first.path);
        }
        break;
      }
      // Out of the field and onto the rows, which are ordinary buttons from there on.
      case "ArrowDown":
        event.preventDefault();
        listRef.current?.querySelector("button")?.focus();
        break;
      // Clears the filter rather than leaving the tab: nothing here is dismissible, and a
      // reader pressing Escape over a narrowed list means "show me all of them again".
      case "Escape":
        if (query !== "") {
          event.preventDefault();
          setQuery("");
        }
        break;
      default:
        break;
    }
  };

  return (
    <>
      {/* pt-5 rather than the header's own top inset: the air above a heading is what separates
          it from the section before it, and this is the one gap on the screen that divides its
          two halves. */}
      <div className="shrink-0 px-6 pt-5">
        {/* The list's own name, the field that narrows it, and the hairline that closes the
            region — which is also the scroll boundary, so a row sliding up has an edge to slide
            under. The field is absent on a machine with no reviews: a search box over nothing
            is a control that cannot do anything, on the one screen that has to teach. */}
        <div className="mx-auto w-full max-w-3xl">
          <div className={cn(START_INSET, "pb-2")}>
            <StartHeading>Recent reviews</StartHeading>
            {phase === "loaded" && total > 0 && (
              <div className="mt-1.5 flex h-6 items-center gap-2.5">
                {/* The glyph leads the row at the shared text inset, so it starts where the row
                    titles under it start — the search field's own text then follows it, which is
                    a search field's anatomy rather than a fourth left edge. */}
                <Search aria-hidden="true" className="size-3.5 shrink-0 text-text-faint" />
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Search your reviews"
                  placeholder="Search your reviews"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onFieldKeyDown}
                  className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-text-faint"
                />
                {/* The count of what is on screen, and it says so while a filter is narrowing
                    it — "12 of 340" is the fact a reader typing into a field wants; a bare "12"
                    leaves them wondering whether the rest were dropped or never existed. */}
                <span className="shrink-0 text-xs tabular-nums text-text-faint">
                  {matches.length === total ? total : `${matches.length} of ${total}`}
                </span>
              </div>
            )}
          </div>
          <StartRule />
        </div>
      </div>

      {/* The one scroll box on this screen. tabIndex -1 like the tour doc's: not a Tab stop of
          its own, but focusing a scroll container is what gives PgDn and the arrows something
          to scroll, and it is where F6 lands a reader who wanted the list. */}
      <div
        ref={listRef}
        data-review-history
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-2 outline-none"
      >
        <div className="mx-auto max-w-3xl">
          {phase === "loaded" ? (
            <>
              {total === 0 ? (
                <EmptyHistory dir={dir} unreadable={unreadable} />
              ) : matches.length === 0 ? (
                <NoMatches query={query} />
              ) : (
                groups.map((group) => (
                  <div key={group.label} className="mt-2 first:mt-0">
                    {/* The band's name in the metadata register, once, above its rows — the
                        date fact the rows themselves then never have to spell out. */}
                    <h3 className="px-2.5 py-1 text-xs text-text-faint">{group.label}</h3>
                    {group.reviews.map((review) => (
                      <button
                        key={review.path}
                        type="button"
                        onClick={() => open(review.path)}
                        className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-border/40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <RecentReviewLines review={review} now={now} />
                      </button>
                    ))}
                  </div>
                ))
              )}
              {/* Under all three — a list, a filter that matched nothing, and the absence of any
                  reviews are equally owed the answer to "where do these come from", and it is a
                  place on disk the reader can go and look at. */}
              <HistoryFoot dir={dir} truncated={truncated} />
            </>
          ) : (
            // Not a spinner. The read is one directory listing and a few small parses — it
            // resolves inside a frame or two on any real reviews folder — so a spinner would
            // be a flash of anxiety where an empty field is simply the list before its rows
            // land.
            <div className="min-h-24" />
          )}
        </div>
      </div>
    </>
  );
}

/** A query that matched nothing. The reader's own doing, so it needs no explanation beyond
 * saying so — and it names what it searched for, which is the one thing they might have
 * mistyped. */
function NoMatches({ query }: { query: string }): ReactElement {
  return (
    <p className="mt-3 px-2.5 text-sm leading-relaxed text-text-muted">
      No review matches <span className="font-mono text-[0.95em]">{query.trim()}</span>.
    </p>
  );
}

/** The two ways this list is empty *without* a filter, which are two different sentences: a
 * folder that would not open is a fault worth naming, and a folder with nothing in it is the
 * ordinary state of a machine that has not been reviewed on yet — where the answer is the one
 * the top of this screen already gave, plus the other way a review can arrive. */
function EmptyHistory({
  dir,
  unreadable,
}: {
  dir: string | null;
  unreadable: boolean;
}): ReactElement {
  return (
    <div className="mt-3 px-2.5">
      <p className="text-sm text-foreground">
        {unreadable ? "That folder would not open" : "No reviews yet"}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-text-muted">
        {unreadable ? (
          <>
            <span className="font-mono text-[0.95em]">{dir}</span> exists but could not be read —
            check its permissions.
          </>
        ) : (
          <>
            The first review your agent publishes opens here on its own. A review file from
            somewhere else works too: drop a{" "}
            <span className="font-mono text-[0.95em]">.reviewer.json</span> onto this window.
          </>
        )}
      </p>
    </div>
  );
}

/** Where the rows came from, and anything main left out of them — the same rule the CLI follows
 * about capping something silently. */
function HistoryFoot({
  dir,
  truncated,
}: {
  dir: string | null;
  truncated: number;
}): ReactElement | null {
  if (dir === null) {
    return null;
  }
  return (
    <p className="mt-3 px-2.5 pb-1 text-xs leading-relaxed text-text-faint">
      Reviews live in <span className="font-mono">{dir}</span>
      {truncated > 0 && `, and ${truncated} older ones are not listed`}.
    </p>
  );
}
