import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { ArrowRight } from "lucide-react";
import type { Comment, ReviewLayer } from "../../../shared/review";
import { countLabel } from "../../../shared/plural";
import { buildOverview } from "@/lib/overview";
import { reviewDrift } from "@/lib/review-drift";
import { shortSha } from "@/lib/refs";
import { NO_READ_FILES } from "@/lib/read-progress";
import { createScrollCapture, docMountReturn, type DocReturn } from "@/lib/scroll";
import { assertNever } from "../../../shared/assert";
import { Button } from "@/components/ui/button";
import { GLASS_PRIMARY } from "@/components/Glass";
import { ReadRing } from "@/components/ReadRing";
import { OverviewLayerSection, layerSectionDomId } from "@/components/OverviewLayerSection";
import { Markdown } from "@/components/Markdown";
import { VerdictChip } from "@/components/VerdictChip";
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

/** The document's scroll position: reported while it is up, served when it mounts.
 *
 * The document replaces the diff pane, so every way out of it unmounts it and every way back
 * is a fresh mount at 0. It used to answer that with one effect — scroll to the section of the
 * chapter last soloed — which was right for a reader coming back from reviewing that chapter
 * and wrong for everyone else: `o`,`o` from 3,000 px came back at the title, so did every prose
 * reference (the most glance-shaped exit there is), and because the bookmark was never
 * cleared, a reference followed from the top of the page came back 5,000 px down on a chapter
 * left two moves earlier.
 *
 * Now the position is always recorded, and where the mount lands is a plan the *store* made
 * when it opened the document (`enterDoc` → `planDocReturn`): the exact position while the
 * reader's trip is live — they have not navigated by their own hand since the document closed
 * — and the hub's old landing, the section of the chapter they are in, once they have. Position
 * outranks the chapter on a live trip because the exits that solo a chapter are as easy to hit
 * by accident as any other, and an accident has to undo to the line it was made from; the
 * chapter outranks the position after a departure because a reader who went on to review
 * chapter 9 is done with the paragraph they left from. The plan is read once, at mount: it is a
 * request this mount owes, not a value the document follows, and nothing re-scrolls a
 * document somebody is reading.
 *
 * Pixels, not `{ section, offset }`. What made that a question is the mermaid fence, which
 * used to draw a beat after mount and move everything under it; `MermaidDiagram` now
 * redraws a diagram it has drawn before in its first render, so by the time this layout effect
 * runs the page is the height it was when the position was recorded.
 *
 * Capture is the diff pane's (`createScrollCapture`: debounced, flushed on unmount so the
 * last scroll before a click is never lost), bound to the session this mounted for — the
 * flush runs *after* a tab switch has moved `activeSessionId` on. The component is keyed per
 * session in `App.tsx` for the same reason.
 *
 * DOM-only, so untested by this repo's rule; every decision it acts on is in `lib/scroll.ts`
 * and the store, which are. */
function useDocPosition(): { ref: RefObject<HTMLDivElement | null>; onScroll: () => void } {
  const ref = useRef<HTMLDivElement>(null);
  const setDocScrollTop = useReviewStore((state) => state.setDocScrollTop);
  const [mount] = useState(() => {
    const state = useReviewStore.getState();
    const slice = selectActiveSlice(state);
    const docScrollTop = slice?.docScrollTop ?? 0;
    return {
      sessionId: state.activeSessionId,
      docScrollTop,
      docReturn: docMountReturn(slice?.docReturn ?? null, docScrollTop),
    };
  });

  useLayoutEffect(() => {
    const scroller = ref.current;
    if (scroller !== null) {
      serveDocReturn(scroller, mount.docReturn, mount.docScrollTop);
    }
  }, [mount]);

  const capture = useMemo(
    () =>
      createScrollCapture((scrollTop) => {
        if (mount.sessionId !== null) {
          setDocScrollTop(scrollTop, mount.sessionId);
        }
      }),
    [mount, setDocScrollTop],
  );
  useEffect(() => () => capture.flush(), [capture]);

  return {
    ref,
    onScroll: () => {
      if (ref.current !== null) {
        capture.notify(ref.current.scrollTop);
      }
    },
  };
}

function serveDocReturn(scroller: HTMLElement, docReturn: DocReturn, docScrollTop: number): void {
  switch (docReturn.kind) {
    case "top":
      return;
    case "position":
      scroller.scrollTop = docReturn.top;
      return;
    case "chapter": {
      // `getElementById`, never a selector: a layer id is data (`dom-ids.test.ts`). A chapter
      // with no section on the page falls back to where the reader was rather than the top.
      const section = document.getElementById(layerSectionDomId(docReturn.layerId));
      if (section === null) {
        scroller.scrollTop = docScrollTop;
      } else {
        section.scrollIntoView({ block: "start" });
      }
      return;
    }
    default:
      return assertNever(docReturn);
  }
}

export function OverviewScreen(): ReactElement | null {
  const overview = useReviewStore((state) => selectActiveSlice(state)?.overview ?? null);
  const layers = useReviewStore((state) => selectActiveSlice(state)?.layers ?? EMPTY_LAYERS);
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const diff = useReviewStore((state) => selectActiveSlice(state)?.diff ?? null);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  // The three inputs of the drift line, each read on its own so the doc re-renders for a
  // moved branch and for nothing else. `reviewedHead` lives on the origin because that is
  // what the session keeps of the artifact once the bytes are gone (`shared/review.ts`).
  const reviewDiff = useReviewStore((state) => selectActiveSlice(state)?.reviewDiff ?? null);
  const log = useReviewStore((state) => selectActiveSlice(state)?.log ?? null);
  const reviewedHead = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewOrigin?.reviewedHead ?? null,
  );
  const readFiles = useReviewStore((state) => selectActiveSlice(state)?.readFiles ?? NO_READ_FILES);
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  const setLayerRead = useReviewStore((state) => state.setLayerRead);
  const openLayerFile = useReviewStore((state) => state.openLayerFile);
  const openLayerComment = useReviewStore((state) => state.openLayerComment);
  const focusReference = useReviewStore((state) => state.focusReference);

  const doc = useDocPosition();

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
  const drift = reviewDrift({ reviewedHead, reviewDiff, log });
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

  // A layer is opened by soloing it. The file and comment doors solo it *and* point the diff
  // at the exact place the reader clicked, and each is one store action rather than two calls
  // from here: the second call would find the document already closed, which makes it a
  // navigation act, which ends the trip the first call started (`openLayerFile`).
  const openLayer = (layerId: string): void => setActiveLayer(layerId);

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
        ref={doc.ref}
        onScroll={doc.onScroll}
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
          {/* The title, and the author's verdict on the same line — the one thing on this
              page the app did not measure, so it sits with the one other thing the author
              wrote at the top rather than among the counted facts below. Baseline-aligned and
              wrapping as a unit, the same way a chapter heading carries its chips. */}
          <h1 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-lg leading-7 font-medium text-foreground">
            {overview.title}
            {overview.verdict !== undefined && <VerdictChip verdict={overview.verdict} />}
          </h1>
          {stats.length > 0 && (
            <div className="mt-2">
              <StatRow>{stats}</StatRow>
            </div>
          )}

          {/* The branch has moved since this was written. A line of its own rather than two
              more items in the row above — that row was cut to three on purpose, and this is
              a sentence about *when* the review is from, not a measurement of the change.
              It appears only when the two shas actually differ, so a review read the hour it
              was written says nothing at all. */}
          {drift !== null && (
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
              Written at
              <code className="font-mono text-xs text-foreground">
                {shortSha(drift.reviewedHead)}
              </code>
              <span aria-hidden="true" className="text-text-faint">
                ·
              </span>
              the branch is now at
              <code className="font-mono text-xs text-foreground">
                {shortSha(drift.currentHead)}
              </code>
              {/* Absent rather than zero when the reviewed commit is not in this walk at all
                  — a rebase or a force-push — because "0 commits since" would be a claim the
                  log cannot make. */}
              {drift.since !== null && (
                <>
                  <span aria-hidden="true" className="text-text-faint">
                    ·
                  </span>
                  {`${countLabel(drift.since, "commit")} since`}
                </>
              )}
            </p>
          )}

          <Markdown
            text={overview.body}
            links={{ paths: filePaths, onSelect: focusReference }}
            diagrams
            className="mt-5 space-y-3 text-base leading-relaxed text-foreground"
          />

          {/* No chapter index here. One stood between the prose and the sections — a line
              per chapter with its summary, read ring, file count and line counts — and the
              reader, using it on a sixteen-chapter review, called it useless: the rail's
              Layers list names the same chapters in the same order on the same screen, and
              every other fact on a row is said again by the section a scroll below. It cost
              most of a first screen at ten chapters to say nothing new. With the sidebar
              hidden the doc has no chapter list at all, and that is accepted: the sections
              are the list, and ⌘B brings the rail back. Do not re-add it without a new
              reason. */}

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
                  onSelectReference={focusReference}
                  onToggleRead={() =>
                    setLayerRead(chapter.layer.id, chapter.read.read < chapter.read.total)
                  }
                  onOpenComments={
                    chapter.firstCommentId === null
                      ? null
                      : () => {
                          if (chapter.firstCommentId !== null) {
                            openLayerComment(chapter.layer.id, chapter.firstCommentId);
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
          {resumeLayerId === null ? (
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
          ) : (
            <Button
              variant="ghost"
              className={cn("rounded-full", GLASS_PRIMARY)}
              onClick={() => setActiveLayer(resumeLayerId)}
            >
              {model.read.read === 0 ? "Start reviewing" : "Continue reviewing"}
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
