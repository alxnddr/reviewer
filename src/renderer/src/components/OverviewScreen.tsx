import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { Comment, ReviewLayer } from "../../../shared/review";
import type { PatchFile } from "../../../shared/diff/patch";
import { outlineDiff, outlineLanguage, tooLargeToRead } from "../../../shared/diff/outline";
import { dependencyDiff } from "../../../shared/diff/imports";
import { countLabel } from "../../../shared/plural";
import { buildChapterSnippets, buildOverview, type OverviewModel } from "@/lib/overview";
import { buildModuleMap } from "@/lib/module-map";
import { buildDepsGraph } from "@/lib/deps-graph";
import { chapterStripInput } from "@/lib/chapter-strip";
import { isMachineWritten } from "@/lib/initial-folds";
import { useElementWidth } from "@/lib/use-element-width";
import {
  chapterRows,
  chapterSlots,
  createBadgeLookup,
  frontArrangement,
  visualNaturalWidth,
  guideSymbols,
  shapeGroups,
} from "@/lib/guide";
import { reviewDrift } from "@/lib/review-drift";
import { shortSha } from "@/lib/refs";
import { NO_READ_FILES } from "@/lib/read-progress";
import { createScrollCapture, docMountReturn, type DocReturn } from "@/lib/scroll";
import { assertNever } from "../../../shared/assert";
import { Button } from "@/components/ui/button";
import { GLASS_PRIMARY } from "@/components/Glass";
import { ReadRing } from "@/components/ReadRing";
import {
  ChapterRow,
  layerSectionDomId,
  type ChapterRowActions,
} from "@/components/guide/ChapterRow";
import { ChapterStrip } from "@/components/guide/ChapterStrip";
import { MapCard } from "@/components/guide/MapCard";
import { VisualCard } from "@/components/guide/VisualCard";
import type { AnchorDoor } from "@/components/guide/anchor-door";
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

/** Everything the guide computes beyond the overview model, memoised on its real inputs: the
 * badge lookup, the chapter tints, the outline diff and its Shape grouping, the module map, the
 * dependency graph, the strip, and the chapters folded into rows. Each is a pure function in `lib/` with its own tests;
 * this only decides when they re-run — on a new diff or new layers, never because the reader
 * scrolled or marked a file. (The strip and the rows read the model, which does change with a
 * read mark: that is their progress fills.) */
function useGuideModel(
  layers: readonly ReviewLayer[],
  files: readonly PatchFile[] | null,
  model: OverviewModel,
) {
  const badgeOf = useMemo(() => createBadgeLookup(layers), [layers]);
  const slots = useMemo(() => chapterSlots(layers), [layers]);
  const outline = useMemo(() => outlineDiff(files ?? [], { skip: isMachineWritten }), [files]);
  const symbols = useMemo(() => guideSymbols(outline, badgeOf), [outline, badgeOf]);
  const shape = useMemo(() => shapeGroups(outline, symbols), [outline, symbols]);
  // The authored layers, not `effectiveLayers`: the inferred "not covered" layer would own the
  // very files the map hatches (`buildModuleMap`).
  const moduleMap = useMemo(() => buildModuleMap(files ?? [], layers), [files, layers]);
  // The Deps tab: the dependency diff is a function of the diff alone; the module graph over it
  // takes the map only for its frame names.
  const dependencies = useMemo(
    () => dependencyDiff(files ?? [], { skip: isMachineWritten }),
    [files],
  );
  const deps = useMemo(
    () => buildDepsGraph(dependencies, files ?? [], moduleMap),
    [dependencies, files, moduleMap],
  );
  const strip = useMemo(
    () => chapterStripInput(model, files ?? [], layers),
    [model, files, layers],
  );
  const rows = useMemo(() => chapterRows(model.chapters), [model]);
  // The code files the outline and the import read both left out for size (`tooLargeToRead`),
  // so the Shape and Deps tabs can say so rather than draw a silence that reads "declares
  // nothing". Machine-written files are not listed: they are skipped by design, not by budget.
  const unread = useMemo(
    () =>
      (files ?? [])
        .filter(
          (file) =>
            outlineLanguage(file.path) !== null &&
            !file.isBinary &&
            !isMachineWritten(file) &&
            tooLargeToRead(file),
        )
        .map((file) => file.path),
    [files],
  );
  return { badgeOf, slots, symbols, shape, moduleMap, deps, strip, rows, unread };
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
  const frontRef = useRef<HTMLDivElement>(null);
  const frontWidth = useElementWidth(frontRef);

  const files = diff !== null && diff.phase === "loaded" ? diff.files : null;
  // The chapter cards on their own memo, keyed on the layers and the diff only: they are the part
  // of the model that reads code, and a read mark or a comment edit — which do re-run
  // `buildOverview` — changes nothing about them (`buildChapterSnippets`).
  const snippets = useMemo(
    () => buildChapterSnippets({ layers, files: files ?? [] }),
    [layers, files],
  );
  const model = useMemo(
    () => buildOverview({ layers, files: files ?? [], comments, frozen, readFiles }, snippets),
    [layers, files, comments, frozen, readFiles, snippets],
  );
  const filePaths = useMemo(() => (files ?? []).map((file) => file.path), [files]);
  const guide = useGuideModel(layers, files, model);
  const visual = overview?.visual;
  const naturalWidth = useMemo(
    () => (visual === undefined ? 0 : visualNaturalWidth(visual, guide.badgeOf)),
    [visual, guide.badgeOf],
  );
  // Whether the picture sits beside the lede or under it is measured, not a breakpoint: a flow
  // that would wrap in the right column but fits the page goes under (`frontArrangement`). With
  // no picture there is nothing to sit beside: the prose takes the single reading column. It
  // was "beside", which squeezed every pre-guide review's front into five twelfths of the page
  // next to seven twelfths of nothing.
  const front = {
    ref: frontRef,
    arrangement: visual === undefined ? "below" : frontArrangement(naturalWidth, frontWidth),
  };

  // Every element of the guide that points at code — a box in a diagram, a line of a skeleton,
  // a changed symbol — goes through the prose's own door (`focusReference`), so following one
  // is a navigation act exactly like following a `[label](path:12)` chip: it leaves the
  // document, starting the trip the Back pill serves (`components/guide/anchor-door.tsx`).
  const door = useMemo<AnchorDoor>(
    () => ({
      paths: new Set(filePaths),
      open: (anchor) =>
        focusReference(anchor.file, {
          side: anchor.side,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
        }),
    }),
    [filePaths, focusReference],
  );

  if (overview === null) {
    return null;
  }
  const loaded = files !== null;
  const drift = reviewDrift({ reviewedHead, reviewDiff, log });
  const firstLayerId = layers[0]?.id ?? null;
  const resumeLayerId = model.resumeLayerId;
  const steps = overview.steps ?? [];
  // A review from before the guide contract carries its whole front in `body`. Folding the only
  // prose it has into "Reviewer's notes" would open the page on nothing, so without a lede or
  // steps the body *is* the front, read open, and the notes at the end are not drawn twice.
  const bodyIsFront = overview.lede === undefined && steps.length === 0;
  const chapterCount = guide.rows.filter((row) => row.chapter.ordinal !== null).length;

  // Just the file count, never the read tally. The rail's foot carries "3 of 11 files read"
  // permanently, one pane away and always on screen; growing this slot into the same
  // sentence mid-review meant the number was on the page twice and the headline changed
  // shape under the reader as they worked. What this row is for is describing the change —
  // how much of it they have been through is the sidebar's standing job, and the chapter
  // strip's fills below.
  //
  // Layer coverage is deliberately not here either. It is a figure about how well the review
  // was *authored*; the strip's hatched remainder and the map's hatched tiles say the same
  // thing in a form the reader can actually open. The chapter count is here because the
  // guide's chapters no longer each lead with a section number a reader could count by.
  const stats: ReactElement[] = loaded
    ? [
        <span key="files">{countLabel(model.files, "file")}</span>,
        <span key="lines">
          <span className="text-diff-add-fg">+{model.additions}</span>{" "}
          <span className="text-diff-del-fg">−{model.deletions}</span>
        </span>,
        ...(chapterCount > 0
          ? [<span key="chapters">{countLabel(chapterCount, "chapter")}</span>]
          : []),
      ]
    : [];

  // A layer is opened by soloing it. The file and comment doors solo it *and* point the diff
  // at the exact place the reader clicked, and each is one store action rather than two calls
  // from here: the second call would find the document already closed, which makes it a
  // navigation act, which ends the trip the first call started (`openLayerFile`).
  const actions: ChapterRowActions = {
    onOpen: (layerId) => setActiveLayer(layerId),
    onOpenFile: (layerId, path) => openLayerFile(layerId, path),
    onToggleRead: (chapter) =>
      setLayerRead(chapter.layer.id, chapter.read.read < chapter.read.total),
    onOpenComments: (chapter) => {
      if (chapter.firstCommentId !== null) {
        openLayerComment(chapter.layer.id, chapter.firstCommentId);
      }
    },
    onSelectReference: focusReference,
  };
  const links = { paths: filePaths, onSelect: focusReference };

  return (
    <div className="relative flex h-full flex-col bg-diff-surface">
      {/* No header bar. Every other surface opens with one because it has something only a
          bar can say — which diff, which chapter. This one had a label the rail's own
          selected row already carries and the page's title repeats two lines down; a bar
          whose every part is said elsewhere on the same screen is a rule with chrome
          attached. The document simply starts, and the extra top inset stands in for the
          bar's height so the title still clears the window's chrome. */}
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
        {/* Centred and wide: the guide is two columns — the argument and its evidence — so it
            takes the width a diff would, where the old single reading column stopped at 48rem.
            The two columns are a *container* query (`@container`), not a viewport one: what
            decides whether there is room beside the prose is the pane, which the sidebar's
            seam resizes, not the window. Below that width everything stacks, evidence under
            argument, and reads as the single column it used to be. */}
        {/* pb-28 is the island's own height plus its inset plus air: the end of the document
            has to be able to scroll clear of the pill, or the last thing a reader reaches is
            permanently half-covered by the control that took them there. */}
        <div className="@container mx-auto max-w-6xl px-8 pt-10 pb-28 select-text">
          {/* The title, and the author's verdict on the same line — the one thing on this
              page the app did not measure, so it sits with the one other thing the author
              wrote at the top rather than among the counted facts below. */}
          <h1 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xl leading-8 font-medium text-foreground">
            {overview.title}
            {overview.verdict !== undefined && <VerdictChip verdict={overview.verdict} />}
          </h1>
          {stats.length > 0 && (
            <div className="mt-1.5">
              <StatRow>{stats}</StatRow>
            </div>
          )}

          {/* The branch has moved since this was written. A line of its own rather than more
              items in the row above — this is a sentence about *when* the review is from, not
              a measurement of the change. It appears only when the two shas actually differ. */}
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

          {/* The front: one sentence and the steps the change takes, beside one proven picture
              of its shape. Read first because it is what a reader who reads nothing else
              should leave with — and short because the old front, 100–250 words of prose,
              was the part nobody read. */}
          <div
            ref={front.ref}
            className={cn(
              "mt-10 grid grid-cols-1 gap-x-12 gap-y-8",
              front.arrangement === "beside" && "grid-cols-[minmax(0,5fr)_minmax(0,7fr)]",
            )}
          >
            <div className={cn("min-w-0", front.arrangement === "below" && "max-w-3xl")}>
              <h2 className="text-lg font-medium text-foreground">Overview</h2>
              {overview.lede !== undefined && (
                <Markdown
                  text={overview.lede}
                  links={links}
                  className="mt-3 text-base leading-relaxed text-text-muted"
                />
              )}
              {steps.length > 0 && (
                <ol className="mt-4 list-decimal space-y-2 pl-6 text-base leading-relaxed text-foreground marker:text-text-faint">
                  {steps.map((step, index) => (
                    <li key={index} className="pl-1">
                      <Markdown text={step} links={links} />
                    </li>
                  ))}
                </ol>
              )}
              {bodyIsFront && overview.body !== undefined && (
                <Markdown
                  text={overview.body}
                  links={links}
                  diagrams
                  className="mt-3 space-y-3 text-base leading-relaxed text-foreground"
                />
              )}
            </div>
            {overview.visual !== undefined && (
              <VisualCard visual={overview.visual} badgeOf={guide.badgeOf} door={door} />
            )}
          </div>

          {/* The map: the whole change at a glance, before its chapters. The strip says how big
              each chapter is and how far through it the reader is; the card under it says where
              the change lives (Map) and what it declares (Shape). Both computed — nothing on
              this section is authored. */}
          {loaded && model.files > 0 && (
            <section aria-labelledby="guide-map-heading" className="mt-14">
              <h2 id="guide-map-heading" className="text-lg font-medium text-foreground">
                Map
              </h2>
              {guide.strip.chapters.length > 0 && (
                <div className="mt-4">
                  <ChapterStrip
                    input={guide.strip}
                    slots={guide.slots}
                    onOpen={(layerId) => setActiveLayer(layerId)}
                  />
                </div>
              )}
              <div className="mt-4">
                <MapCard
                  root={guide.moduleMap}
                  groups={guide.shape}
                  slots={guide.slots}
                  deps={guide.deps}
                  unread={guide.unread}
                  badgeOf={guide.badgeOf}
                  door={door}
                  onOpenFile={(path) => focusReference(path, null)}
                />
              </div>
            </section>
          )}

          {/* No chapter index here. One stood between the prose and the sections — a line per
              chapter with its summary, read ring, file count and line counts — and the reader,
              using it on a sixteen-chapter review, called it useless: the rail's Layers list
              names the same chapters in the same order on the same screen. The strip above is
              the index now, and it is a picture of size and progress rather than a list. */}
          {guide.rows.length > 0 && (
            <div className="mt-14">
              {guide.rows.map((row) => (
                <ChapterRow
                  key={row.chapter.layer.id}
                  row={row}
                  total={chapterCount}
                  filePaths={filePaths}
                  symbols={guide.symbols}
                  badgeOf={guide.badgeOf}
                  door={door}
                  actions={actions}
                />
              ))}
            </div>
          )}

          {/* The author's longer notes, folded at the end: what used to be the whole front of
              the document is now the part a reader opens if the chapters left them wanting
              more. A native disclosure — the browser owns its keyboard and its state. */}
          {!bodyIsFront && overview.body !== undefined && (
            <details className="group mt-6 border-t border-border pt-6">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-base font-medium text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-text-faint transition-transform duration-(--duration-fast) group-open:rotate-90"
                />
                Reviewer’s notes
              </summary>
              <Markdown
                text={overview.body}
                links={links}
                diagrams
                className="mt-3 max-w-3xl space-y-3 text-base leading-relaxed text-foreground"
              />
            </details>
          )}

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
