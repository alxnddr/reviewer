import { useEffect, useMemo, type ReactElement } from "react";
import { ArrowRight } from "lucide-react";
import type { Comment, ReviewLayer } from "../../../shared/review";
import { buildOverview } from "@/lib/overview";
import { NO_READ_FILES } from "@/lib/read-progress";
import { Button } from "@/components/ui/button";
import { GLASS_PRIMARY } from "@/components/Glass";
import { ReadRing } from "@/components/ReadRing";
import { OverviewLayerSection, layerSectionDomId } from "@/components/OverviewLayerSection";
import { ReviewProse } from "@/components/ReviewProse";
import { cn } from "@/lib/utils";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The tour doc: where a review starts, and the one place the whole review can be *read*
// rather than clicked through. The author's prose opens it, then every layer follows as a
// section of the same document — its heading, its own long-form description in full, and
// the files it covers. A reader who never leaves this screen still gets the argument of
// the change end to end; the doors are there for when they want the code (the heading and
// the files open that layer in the diff, the comment count lands on its first finding).
//
// Every number on it is measured here, against the layers and the loaded diff — the
// artifact's prose is never asked to state a count it would then have to keep in sync.
//
// It replaces the diff pane rather than floating over it: this is a stop in the review,
// not a modal — nothing is suspended behind it, and the rail beside it keeps working.

// Stable empties so the selectors return one reference for a session with none.
const EMPTY_COMMENTS: Comment[] = [];
const EMPTY_LAYERS: ReviewLayer[] = [];

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The one `·`-separated fact row under the title — the shape of the change at a glance.
 * Every number is measured against the diff on screen; the ones that need a loaded diff are
 * simply absent until there is one, rather than showing a stale or zero count.
 *
 * Three items, where there were six. The row is read left to right in one pass, so what
 * made it crowded was never the width — it was having to step over five `·` to find the one
 * number you came for. Two of the six were said twice on the same screen (the layer count
 * *is* the numbered sections below it; the comment count is permanently in the rail), and
 * two more were the same eleven files counted twice, once alone and once as a denominator. */
function StatRow({ children }: { children: ReactElement[] }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted tabular-nums">
      {children.map((child, index) => (
        <span key={index} className="flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden="true" className="text-text-faint">
              ·
            </span>
          )}
          {child}
        </span>
      ))}
    </div>
  );
}

export function OverviewScreen(): ReactElement | null {
  const overview = useReviewStore((state) => selectActiveSlice(state)?.overview ?? null);
  const layers = useReviewStore((state) => selectActiveSlice(state)?.layers ?? EMPTY_LAYERS);
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const diff = useReviewStore((state) => selectActiveSlice(state)?.diff ?? null);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  const lastChapterId = useReviewStore((state) => selectActiveSlice(state)?.lastChapterId ?? null);
  const readFiles = useReviewStore((state) => selectActiveSlice(state)?.readFiles ?? NO_READ_FILES);
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  const setLayerRead = useReviewStore((state) => state.setLayerRead);
  const selectFile = useReviewStore((state) => state.selectFile);
  const focusComment = useReviewStore((state) => state.focusComment);

  // Coming back from a layer lands on that layer's section, not at the top of a long
  // page: the doc is a hub the reader returns to repeatedly, and re-finding their place
  // every time is the friction that would make them stop coming back. On the first open
  // there is no last layer, so the doc simply starts at its title.
  useEffect(() => {
    if (lastChapterId === null) {
      return;
    }
    document.getElementById(layerSectionDomId(lastChapterId))?.scrollIntoView({ block: "start" });
    // On mount and whenever the target changes — which only ever happens through explicit
    // navigation (entering a layer, or a rail heading asking for its section), never
    // through reading. So this lands the reader somewhere they asked to be and then leaves
    // their scrolling alone.
  }, [lastChapterId]);

  const files = diff !== null && diff.phase === "loaded" ? diff.files : null;
  const model = useMemo(
    () => buildOverview({ layers, files: files ?? [], comments, frozen, readFiles }),
    [layers, files, comments, frozen, readFiles],
  );
  const filePaths = useMemo(() => (files ?? []).map((file) => file.path), [files]);

  if (overview === null) {
    return null;
  }
  const loaded = files !== null;
  const firstLayerId = layers[0]?.id ?? null;
  const resumeLayerId = model.resumeLayerId;

  // Just the file count, never the read tally. The rail's foot carries "3 of 11 files read"
  // permanently, one pane away and always on screen; growing this slot into the same
  // sentence mid-review meant the number was on the page twice and the headline changed
  // shape under the reader as they worked. What this row is for is describing the change —
  // how much of it they have been through is the sidebar's standing job.
  //
  // Layer coverage is deliberately not here either. It is a figure about how well the review
  // was *authored*, and this headline is read by someone about to do the reading — a
  // percentage they cannot act on and did not ask for. The rail states it where it belongs,
  // next to the layers themselves, and the "Not covered" chapter says the same thing in a
  // form the reader can actually open.
  const stats: ReactElement[] = loaded
    ? [
        <span key="files">{countLabel(model.files, "file")}</span>,
        <span key="lines">
          <span className="text-diff-add-fg">+{model.additions}</span>{" "}
          <span className="text-diff-del-fg">−{model.deletions}</span>
        </span>,
      ]
    : [];

  // A layer is opened by soloing it; the file and comment doors do that first, then point
  // the diff at the exact place the reader clicked.
  const openLayer = (layerId: string): void => setActiveLayer(layerId);
  const openLayerFile = (layerId: string, path: string): void => {
    setActiveLayer(layerId);
    selectFile(path);
  };

  return (
    <div className="relative flex h-full flex-col bg-diff-surface">
      {/* No header bar. Every other surface opens with one because it has something only a
          bar can say — which diff, which chapter. This one had a label the rail's own
          selected row already carries and the page's title repeats two lines down, plus a
          "Browse all files" button the footer's action row already holds; a bar whose every
          part is said elsewhere on the same screen is a rule with chrome attached. The
          document simply starts, and the extra top inset stands in for the bar's height so
          the title still clears the window's chrome. */}
      {/* tabIndex -1, not 0: the doc is not a Tab stop of its own (the reader would land on
          a whole page before reaching its first link), but it is F6's landing spot for this
          screen, and focusing a scroll container is what gives PgDn and the arrows something
          to scroll. */}
      <div
        data-overview-doc
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {/* Centred, unlike every other surface in the app: this one is a document, and a
            reading column pinned to the left edge of a wide pane leaves the page looking
            like it failed to load the rest of itself. On a narrow pane the margins fall to
            the padding and it reads exactly as it did before. */}
        {/* pb-28 is the island's own height plus its inset plus air: the end of the document
            has to be able to scroll clear of the pill, or the last thing a reader reaches is
            permanently half-covered by the control that took them there. */}
        <div className="mx-auto max-w-3xl px-6 pt-10 pb-28 select-text">
          <h1 className="text-lg leading-7 font-medium text-foreground">{overview.title}</h1>
          {stats.length > 0 && (
            <div className="mt-2">
              <StatRow>{stats}</StatRow>
            </div>
          )}

          <ReviewProse
            text={overview.body}
            filePaths={filePaths}
            onSelectFile={(path) => selectFile(path)}
            className="mt-5 space-y-3 text-base leading-relaxed text-foreground"
          />

          {/* The layers, in authored order, as the rest of the document — no section
              heading over them: they *are* the document past the opening prose, and each
              one's own heading already names it. A rollup is followed by the sections it
              stands for, each saying which rollup it belongs to, so the reading order is
              the one the rail steps rather than a tree the reader has to reassemble. */}
          {model.chapters.length > 0 && (
            // No spacing of its own: each section owns the gap above it (and a top-level
            // one splits that gap either side of its rule), so the first section's margin
            // is the space under the prose.
            <div>
              {model.chapters.map((chapter) => (
                <OverviewLayerSection
                  key={chapter.layer.id}
                  chapter={chapter}
                  filePaths={filePaths}
                  onOpen={() => openLayer(chapter.layer.id)}
                  onOpenFile={(path) => openLayerFile(chapter.layer.id, path)}
                  onSelectFile={(path) => selectFile(path)}
                  onToggleRead={() =>
                    setLayerRead(chapter.layer.id, chapter.read.read < chapter.read.total)
                  }
                  onOpenComments={
                    chapter.firstCommentId === null
                      ? null
                      : () => {
                          const commentId = chapter.firstCommentId;
                          openLayer(chapter.layer.id);
                          if (commentId !== null) {
                            focusComment(commentId);
                          }
                        }
                  }
                />
              ))}
            </div>
          )}

          {/* Nothing but the ending. The two ways *on* moved to the island below, which is
              on screen the whole time — reaching them here meant scrolling past the entire
              review first, which is backwards for the control a reader wants at the moment
              they decide to stop reading the summary and go.

              "Mark all unread" went too, and not for room: the rail's tree already ends in a
              Reset that clears the same files by the same call, and it is on screen from the
              first render rather than at the bottom of a long page. Two buttons, one job, one
              of them permanently visible — the doc's copy was the one adding nothing. */}
          {/* The end of the walkthrough, stated once, where the reader lands when they come
              back to the hub after the last chapter. */}
          {loaded && model.read.total > 0 && model.read.read === model.read.total && (
            <p className="mt-8 flex items-center gap-1.5 text-sm text-text-muted">
              <ReadRing tally={model.read} />
              {`Every file in this review is read — all ${model.read.total} of them.`}
            </p>
          )}
        </div>
      </div>

      {/* The island. Pinned to the pane, outside the scroll box, so the two ways on are one
          click away from anywhere in the document rather than one click away from its end.

          It floats rather than docking as a bar for the same reason it is glass: a solid
          footer strip would draw a permanent horizontal line under the reading column and
          cut the page short, which is exactly the shape the header bar above had and exactly
          why it went. A pill hovering clear of both edges reads as something laid over the
          page, which is what it is.

          The outer row is `pointer-events-none` so only the pill itself takes the pointer —
          the strip beside it stays the document's, and text under it is still selectable. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-6">
        <div data-glass className="pointer-events-auto flex items-center rounded-full p-1">
          {/* One action. "Browse all files" left when the rail grew a permanent "View all"
              in its Layers header — same call, same destination, on screen the whole time
              and next to the rows it is about. Two doors to one room, and this was the one
              that had to be carried.

              Nothing here is filled either. The app's one saturated accent, parked over a
              reading column for as long as the reader is on the page, is a blue lozenge in
              the corner of their eye on every line — and the eye keeps going back to it. The
              glass already says "this is a control, above the page"; the label only has to
              be legible, so the weight comes from ink at 500 and hover is a wash faint
              enough to read as glass catching light. */}
          {resumeLayerId !== null ? (
            <Button
              variant="ghost"
              className={cn("rounded-full", GLASS_PRIMARY)}
              onClick={() => setActiveLayer(resumeLayerId)}
            >
              {model.read.read === 0 ? "Start reviewing" : "Continue reviewing"}
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>
          ) : (
            firstLayerId !== null && (
              <Button
                variant="ghost"
                className={cn("rounded-full", GLASS_PRIMARY)}
                onClick={() => setActiveLayer(firstLayerId)}
              >
                Open the first layer
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
