import { useState, type ReactElement } from "react";
import { AlertTriangle, MessageSquare } from "lucide-react";
import type { OverviewChapter, OverviewFileEntry } from "@/lib/overview";
import type { ReadTally } from "@/lib/read-progress";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ReadRing } from "@/components/ReadRing";
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

/** One file, read — the tally a single file's tick is drawn from, so the doc's rows use the
 * same glyph as every aggregate rather than a second check of their own. */
const READ_ONE: ReadTally = { read: 1, total: 1 };

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
      {/* A read file's tick sits ahead of its glyph, in a slot every row holds open: the
          column then reads down the section as a checklist of what is left, and a row does
          not shift sideways at the moment it is finished. */}
      <span className="flex size-3 shrink-0 items-center justify-center">
        {entry.read && <ReadRing tally={READ_ONE} />}
      </span>
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
  /** Flip the whole chapter's files between read and unread — the doc's own copy of the
   * chapter band's control, for the reader taking stock rather than reading. */
  onToggleRead: () => void;
};

export function OverviewLayerSection({
  chapter,
  filePaths,
  onOpen,
  onOpenFile,
  onSelectFile,
  onOpenComments,
  onToggleRead,
}: OverviewLayerSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { layer, files, hasChildren } = chapter;
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
        {/* The chapter's own progress, and the way to settle it in one go — first in the
            fact row, because on a page read top to bottom this is the fact the reader is
            keeping. It is a button here, unlike the rail's status mark, because the doc has
            the width for a hit target and this is where a reader takes stock of chapters
            rather than reading one. A chapter with nothing in this diff shows nothing. */}
        {chapter.read.total > 0 && (
          <TooltipHint
            side="top"
            align="start"
            content={
              chapter.read.read === chapter.read.total
                ? "Mark this layer’s files unread"
                : "Mark this layer’s files read"
            }
          >
            <button
              type="button"
              aria-pressed={chapter.read.read === chapter.read.total}
              onClick={onToggleRead}
              className="-mx-1 flex items-center gap-1.5 rounded px-1 tabular-nums hover:bg-border/50 hover:text-foreground"
            >
              <ReadRing tally={chapter.read} />
              {chapter.read.read === chapter.read.total
                ? "Read"
                : `${chapter.read.read} of ${chapter.read.total} read`}
            </button>
          </TooltipHint>
        )}
        <span>
          {countLabel(files.length, "file")}
          {hasChildren && " across the sections below"}
        </span>
        {(chapter.additions > 0 || chapter.deletions > 0) && (
          <LineCounts additions={chapter.additions} deletions={chapter.deletions} />
        )}
        {/* The findings, at the row's outer edge — the one door this row still needs. The
            heading above is already the way into the layer, so a second "open this layer"
            button here was the same click twice; what only this control can do is land on
            the first finding rather than the top of the section. */}
        {onOpenComments !== null && (
          <TooltipHint content="Open the layer on the first of them" side="top" align="end">
            <button
              type="button"
              onClick={onOpenComments}
              className="ml-auto flex shrink-0 items-center gap-1 rounded px-1 text-xs text-text-muted tabular-nums hover:bg-border/50 hover:text-foreground"
            >
              <MessageSquare aria-hidden="true" className="size-3.5" />
              {countLabel(chapter.comments, "comment")}
            </button>
          </TooltipHint>
        )}
      </div>
    </section>
  );
}
