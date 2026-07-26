import { useState, type ReactElement } from "react";
import { AlertTriangle, ArrowRight, MessageSquare } from "lucide-react";
import type { OverviewChapter, OverviewFileEntry } from "@/lib/overview";
import { UNCOVERED_LAYER_ID } from "@/lib/coverage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ReviewProse } from "@/components/ReviewProse";

// One layer as a section of the overview document: its number and title, its own prose in
// full, the files it covers, and the way into the diff. The doc is read top to bottom, so
// this is a section of prose with the facts under it — not a card summarising a page the
// reader has to open before they learn anything.
//
// Nesting is rendered the way a document renders it: as heading rank and a section number
// (§4, §4.2, §4.2.1), never as an indent. Every section is read at the same width, so the
// reading column never jogs sideways to state something the number already says.
//
// Every figure is derived (lib/overview.ts) from the layers and the loaded diff, and always
// over the layer's *extent* — itself plus everything nested under it — so a group states
// the totals of what it contains by the same rule that gives a leaf its own.

/** Files past this fold behind a disclosure: a layer that spans twenty paths would
 * otherwise bury the next section, and the count is the part that matters at a glance. */
const FILES_SHOWN = 6;

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The DOM id a layer's section carries, so returning to the doc can scroll to the one the
 * reader just came out of. */
export function layerSectionDomId(layerId: string): string {
  return `overview-layer-${layerId}`;
}

/** Added/removed line counts, in the diff's own signal colours. A zero side is dropped
 * rather than printed as `+0` — the noise would outweigh the fact. Tabular, not mono: the
 * digits only need to align in a column, and the doc's headline stat row sets the
 * precedent — mono is for code, not for counting. */
function LineCounts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}): ReactElement {
  return (
    <span className="shrink-0 text-xs tabular-nums">
      {additions > 0 && <span className="text-diff-add-fg">+{additions}</span>}
      {additions > 0 && deletions > 0 && " "}
      {deletions > 0 && <span className="text-diff-del-fg">−{deletions}</span>}
      {additions === 0 && deletions === 0 && <span className="text-text-faint">0</span>}
    </span>
  );
}

type FileRowProps = {
  entry: OverviewFileEntry;
  onOpen: () => void;
};

/** One file the layer covers: its path and the layer's own footprint in it. A file the
 * loaded diff no longer carries stays listed — the layer still claims it — but says so
 * and does not pretend to navigate anywhere useful. */
function FileRow({ entry, onOpen }: FileRowProps): ReactElement {
  const missing = entry.status === null;
  return (
    <button
      type="button"
      disabled={missing}
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left",
        missing ? "cursor-default" : "hover:bg-border/50",
      )}
    >
      {/* The type glyph the file tree draws for the same path, so a file looks like itself
          wherever it is named. It goes dim on a file the diff no longer carries — the row
          is a record of what the layer claims, not a live link. */}
      <FileTypeIcon path={entry.path} className={cn("size-4", missing && "opacity-40")} />
      {/* On the path, not the row: the row spans the section and never clips, and a
          disabled button takes no pointer events to open a hint from anyway. */}
      <TooltipHint content={entry.path} whenTruncated side="top" align="start">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            missing ? "text-text-faint line-through" : "text-text-muted",
          )}
        >
          {entry.path}
        </span>
      </TooltipHint>
      {missing ? (
        <span className="shrink-0 text-xs text-text-faint">not in this diff</span>
      ) : (
        <LineCounts additions={entry.additions} deletions={entry.deletions} />
      )}
    </button>
  );
}

/** How a section sits in the document at each depth. Rank falls away quickly — past the
 * top level the number carries the nesting and the type only has to stay out of its way —
 * and the rhythm above a section tightens with it, so a group and its children read as one
 * block rather than as a run of equals. Only a top-level section takes the rule, which
 * makes the chapter boundaries the strongest horizontal line on the page.
 *
 * A top-level section's space is split either side of that rule — margin above it, equal
 * padding below — so the line sits centred in the gap between two chapters instead of
 * riding up against the end of the one before it. No section carries bottom space: every
 * gap belongs to the section beneath it, which is the only way a rule can know how much
 * room is above it. */
function rankStyle(depth: number): { section: string; heading: string; ordinal: string } {
  if (depth === 0) {
    return {
      section: "mt-7 border-t border-border pt-7",
      heading: "text-lg leading-7 font-medium",
      ordinal: "text-base text-text-faint",
    };
  }
  if (depth === 1) {
    return {
      section: "mt-6",
      heading: "text-base font-medium",
      ordinal: "text-sm text-text-faint",
    };
  }
  return {
    section: "mt-5",
    heading: "text-base font-medium",
    ordinal: "text-sm text-text-faint",
  };
}

type OverviewLayerSectionProps = {
  chapter: OverviewChapter;
  /** The layer the reader most recently came out of — the doc scrolls to it on return,
   * and it says so, since an unexplained scroll into the middle of a document reads as a
   * bug rather than as a bookmark. */
  lastRead: boolean;
  /** Every path in the loaded diff — what a `[label](path)` in this layer's prose may
   * resolve to. The whole diff, not the layer's own files: the prose is read here, on the
   * doc, where the whole change is navigable. */
  filePaths: string[];
  /** Open this layer in the diff — the section's primary action. On a group that means its
   * whole extent, which is exactly what the section describes. */
  onOpen: () => void;
  /** Open this layer with the diff already on `path`. */
  onOpenFile: (path: string) => void;
  /** Follow a file reference in the prose: the full diff at that file, like the doc's own
   * body chips. A prose link may name a file this layer does not cover, which soloing
   * would hide. */
  onSelectFile: (path: string) => void;
  /** Open this layer focused on its first comment; absent when it holds none. */
  onOpenComments: (() => void) | null;
};

export function OverviewLayerSection({
  chapter,
  lastRead,
  filePaths,
  onOpen,
  onOpenFile,
  onSelectFile,
  onOpenComments,
}: OverviewLayerSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { layer, files, hasChildren } = chapter;
  const uncovered = layer.id === UNCOVERED_LAYER_ID;
  const shown = expanded ? files : files.slice(0, FILES_SHOWN);
  const rest = files.length - shown.length;
  const rank = rankStyle(chapter.depth);

  return (
    <section id={layerSectionDomId(layer.id)} className={cn("scroll-mt-6", rank.section)}>
      <h2 className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1", rank.heading)}>
        {/* The section number leads the title rather than sitting in a gutter: `4.2.1` in a
            fixed column would either clip or hold a wide empty aisle open for every
            shallower section on the page. */}
        <span className={cn("shrink-0 tabular-nums", rank.ordinal)}>
          {chapter.ordinal ?? (
            <AlertTriangle aria-hidden="true" className="size-3.5 text-text-muted" />
          )}
        </span>
        <TooltipHint content={layer.label} whenTruncated side="top" align="start">
          <button
            type="button"
            onClick={onOpen}
            className="max-w-full truncate text-left text-foreground hover:underline"
          >
            {layer.label}
          </button>
        </TooltipHint>
        {!uncovered && (
          <span className="shrink-0 rounded border border-border px-1.5 py-px text-xs font-normal text-text-muted">
            {layer.kind}
          </span>
        )}
        {chapter.outdated && (
          <span className="shrink-0 rounded border border-border bg-border/60 px-1.5 py-px text-xs font-normal text-foreground">
            Outdated
          </span>
        )}
      </h2>

      {/* The one-line summary reads as the section's deck; the long-form description
          follows it as the body. A layer with no description keeps the deck alone — that
          is then the whole of what its author said about this slice. */}
      <p className="mt-1.5 text-sm text-text-muted">{layer.summary}</p>
      {layer.description !== undefined && (
        <ReviewProse
          text={layer.description}
          filePaths={filePaths}
          onSelectFile={onSelectFile}
          className="mt-3 space-y-3 text-base leading-relaxed text-foreground"
        />
      )}

      {/* A group's files are listed by the sections under it, one row each, right below —
          printing them here too would say everything twice. Its fact row still carries the
          totals, because the totals are what a group is. */}
      {files.length > 0 && !hasChildren && (
        <div className="mt-4 flex flex-col gap-0.5">
          {shown.map((entry) => (
            <FileRow key={entry.path} entry={entry} onOpen={() => onOpenFile(entry.path)} />
          ))}
          {(rest > 0 || expanded) && (
            <Button
              variant="ghost"
              size="xs"
              className="self-start text-text-muted hover:bg-border/50 dark:hover:bg-border/50"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show fewer files" : `Show ${countLabel(rest, "more file")}`}
            </Button>
          )}
        </div>
      )}

      {/* The measured facts and the way in, closing the section: what it covers, what it
          holds, and the door to the code. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-text-faint tabular-nums">
        <span>
          {countLabel(files.length, "file")}
          {hasChildren && " across the sections below"}
        </span>
        {(chapter.additions > 0 || chapter.deletions > 0) && (
          <LineCounts additions={chapter.additions} deletions={chapter.deletions} />
        )}
        {onOpenComments !== null && (
          <TooltipHint content="Read the first of them" side="top" align="center">
            <button
              type="button"
              onClick={onOpenComments}
              className="flex items-center gap-1 rounded px-1 text-xs text-text-muted tabular-nums hover:bg-border/50 hover:text-foreground"
            >
              <MessageSquare aria-hidden="true" className="size-3.5" />
              {countLabel(chapter.comments, "comment")}
            </button>
          </TooltipHint>
        )}
        {lastRead && <span className="text-text-muted">last read</span>}
        <Button
          variant="ghost"
          size="xs"
          onClick={onOpen}
          className="ml-auto shrink-0 text-text-muted hover:bg-border/50 hover:text-foreground dark:hover:bg-border/50"
        >
          Open in the diff
          <ArrowRight aria-hidden="true" data-icon="inline-end" />
        </Button>
      </div>
    </section>
  );
}
