import { useEffect, useMemo, type ReactElement } from "react";
import { ArrowRight, ListTree } from "lucide-react";
import type { Comment, ReviewLayer } from "../../../shared/review";
import { buildOverview } from "@/lib/overview";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { OverviewLayerSection, layerSectionDomId } from "@/components/OverviewLayerSection";
import { ReviewProse } from "@/components/ReviewProse";
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

/** One `·`-separated fact row under the title — the shape of the change at a glance.
 * Every number is measured against the diff on screen; the ones that need a loaded diff
 * are simply absent until there is one, rather than showing a stale or zero count. */
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
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
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
    () => buildOverview({ layers, files: files ?? [], comments, frozen }),
    [layers, files, comments, frozen],
  );
  const filePaths = useMemo(() => (files ?? []).map((file) => file.path), [files]);

  if (overview === null) {
    return null;
  }
  const loaded = files !== null;
  const firstLayerId = layers[0]?.id ?? null;

  // A layer is opened by soloing it; the file and comment doors do that first, then point
  // the diff at the exact place the reader clicked.
  const openLayer = (layerId: string): void => setActiveLayer(layerId);
  const openLayerFile = (layerId: string, path: string): void => {
    setActiveLayer(layerId);
    selectFile(path);
  };

  return (
    <div className="flex h-full flex-col bg-diff-surface">
      {/* The same 44px bar the chapter band uses, so the seam with the rail's header
          holds whichever surface is on screen. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-6">
        <span className="text-xs text-text-muted">Overview</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0 hover:bg-border/60 dark:hover:bg-border/60"
          onClick={() => setActiveLayer(null)}
        >
          <ListTree aria-hidden="true" />
          Browse all files
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Centred, unlike every other surface in the app: this one is a document, and a
            reading column pinned to the left edge of a wide pane leaves the page looking
            like it failed to load the rest of itself. On a narrow pane the margins fall to
            the padding and it reads exactly as it did before. */}
        <div className="mx-auto max-w-3xl px-6 py-6 select-text">
          <h1 className="text-lg leading-7 font-medium text-foreground">{overview.title}</h1>
          <div className="mt-2">
            <StatRow>
              {[
                ...(loaded
                  ? [
                      <span key="files">{countLabel(model.files, "file")}</span>,
                      <span key="lines">
                        <span className="text-diff-add-fg">+{model.additions}</span>{" "}
                        <span className="text-diff-del-fg">−{model.deletions}</span>
                      </span>,
                    ]
                  : []),
                <span key="layers">{countLabel(layers.length, "layer")}</span>,
                ...(model.comments > 0
                  ? [<span key="comments">{countLabel(model.comments, "comment")}</span>]
                  : []),
                ...(loaded && layers.length > 0
                  ? [
                      <TooltipHint
                        key="coverage"
                        content="Share of changed lines the layers cover"
                        side="bottom"
                        align="center"
                      >
                        <span>{model.linePct}% covered</span>
                      </TooltipHint>,
                    ]
                  : []),
              ]}
            </StatRow>
          </div>

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
                  lastRead={chapter.layer.id === lastChapterId}
                  filePaths={filePaths}
                  onOpen={() => openLayer(chapter.layer.id)}
                  onOpenFile={(path) => openLayerFile(chapter.layer.id, path)}
                  onSelectFile={(path) => selectFile(path)}
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

          <div className="mt-8 flex items-center gap-2">
            {firstLayerId !== null && (
              <Button onClick={() => setActiveLayer(firstLayerId)}>
                Open the first layer
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
              </Button>
            )}
            <Button variant="outline" onClick={() => setActiveLayer(null)}>
              Browse all files
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
