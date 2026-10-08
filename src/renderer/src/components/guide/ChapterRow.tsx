import { useState, type ReactElement, type ReactNode } from "react";
import { AlertTriangle, MessageSquare } from "lucide-react";
import type { AnchorSpan } from "../../../../shared/review";
import { countLabel } from "../../../../shared/plural";
import { chapterCommentLabel, type OverviewChapter, type OverviewFileEntry } from "@/lib/overview";
import {
  badgeText,
  chapterCounter,
  chapterFigure,
  chapterPartFigure,
  chapterSymbols,
  type ChapterBadge,
  type GuideChapterRow,
  type GuideSymbol,
} from "@/lib/guide";
import type { ReadTally } from "@/lib/read-progress";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ReadRing } from "@/components/ReadRing";
import { Markdown, type ProseLinks } from "@/components/Markdown";
import { DiffSnippet } from "@/components/DiffSnippet";
import { VisualCard, VisualCountsLabel, VisualFigure } from "@/components/guide/VisualCard";
import { SymbolChips } from "@/components/guide/SymbolChips";
import type { AnchorDoor } from "@/components/guide/anchor-door";

// One chapter of the guide: a top-level layer as a row of two columns, the way Capy's guide sets
// a chapter — the argument on the left (its number out of how many, the Reviewed mark, the verb
// phrase that names it, its one-line summary, a short description, the files it covers and the
// symbols it changed) and its evidence on the right: the author's picture of it when there is
// one, else the hunk they named as its key (`focus`), else the hunk the app picks as most
// representative (`representativeAnchors`, through `chapterFigure`). Below a container width the two columns stack, evidence under argument.
//
// Chapters nested under it are drawn *inside* the row, compactly — number, label, summary, files,
// and the part's own picture or key hunk when its author gave it one (`chapterPartFigure`: never a
// computed excerpt, which would compete with the group's) — rather than as rows of their own: a group is one idea with parts, and ten equal-weight rows
// for a three-chapter review with two groups would hide the three. Each part keeps its own DOM
// id, so returning to the document lands on the part the reader was in (`serveDocReturn`).
//
// A skim chapter (and the inferred "not covered" one) is one compact line and its files: no
// prose, no right column — its whole claim is that it does not need reading.
//
// Every figure is derived (`lib/overview.ts`) from the layers and the loaded diff, over the
// layer's *extent* (itself plus everything nested under it).

/** Files past this fold behind a disclosure: a chapter that spans twenty paths would otherwise
 * bury the next one, and the count is the part that matters at a glance. */
const FILES_SHOWN = 6;

/** One file, read — the tally a single file's tick is drawn from. */
const READ_ONE: ReadTally = { read: 1, total: 1 };

/** The DOM id a chapter's (or a nested part's) block carries, so returning to the guide can
 * scroll to the one the reader just came out of. */
export function layerSectionDomId(layerId: string): string {
  return `overview-layer-${layerId}`;
}

function layerHeadingDomId(layerId: string): string {
  return `${layerSectionDomId(layerId)}-heading`;
}

/** Added/removed line counts in the diff's signal colours; a zero side is dropped. */
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

/** `Outdated` and `Skim` — one recipe so the two cannot drift apart. */
function ChapterChip({ children }: { children: string }): ReactElement {
  return (
    <span className="shrink-0 rounded border border-border bg-border/60 px-1.5 py-px text-xs font-normal text-foreground">
      {children}
    </span>
  );
}

function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { name: path, dir: "" }
    : { name: path.slice(cut + 1), dir: path.slice(0, cut + 1) };
}

/** One file the chapter covers: tick slot, type glyph, the name in ink and its directory in the
 * faint grey (Capy's file list), the author's note, and the chapter's own `+N −M` in it. A file
 * the loaded diff no longer carries stays listed — the layer still claims it — struck and inert. */
function FileRow({
  entry,
  onOpen,
}: {
  entry: OverviewFileEntry;
  onOpen: () => void;
}): ReactElement {
  const missing = entry.status === null;
  const { name, dir } = splitPath(entry.path);
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
      <span className="flex size-3 shrink-0 items-center justify-center">
        {entry.read && <ReadRing tally={READ_ONE} />}
      </span>
      <FileTypeIcon path={entry.path} className={cn("size-4", missing && "opacity-40")} />
      <TooltipHint content={entry.path} whenTruncated side="top" align="start">
        <span
          className={cn(
            "flex min-w-0 shrink items-baseline gap-1.5 truncate text-sm",
            missing && "line-through",
          )}
        >
          <span className={missing ? "text-text-faint" : "text-foreground"}>{name}</span>
          {dir !== "" && <span className="truncate text-xs text-text-faint">{dir}</span>}
        </span>
      </TooltipHint>
      {entry.note === null ? (
        <span className="min-w-0 flex-1" />
      ) : (
        <TooltipHint content={entry.note} whenTruncated side="top" align="start">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-text-faint">
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{entry.note}</span>
          </span>
        </TooltipHint>
      )}
      {missing ? (
        <span className="shrink-0 text-xs text-text-faint">not in this diff</span>
      ) : (
        <LineCounts additions={entry.additions} deletions={entry.deletions} />
      )}
    </button>
  );
}

function FileList({
  files,
  onOpenFile,
}: {
  files: readonly OverviewFileEntry[];
  onOpenFile: (path: string) => void;
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) {
    return null;
  }
  const shown = expanded ? files : files.slice(0, FILES_SHOWN);
  const rest = files.length - shown.length;
  return (
    <div className="-mx-1.5 flex flex-col gap-0.5">
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
  );
}

/** The Reviewed mark: the chapter's read glyph (empty ring, pie, check — the rail's) and the
 * word, as one control that flips the whole extent. Absent when nothing in this diff is left to
 * read. */
function ReviewedToggle({
  read,
  onToggle,
}: {
  read: ReadTally;
  onToggle: () => void;
}): ReactElement | null {
  if (read.total === 0) {
    return null;
  }
  const done = read.read === read.total;
  return (
    <TooltipHint
      side="top"
      align="start"
      content={done ? "Mark this chapter’s files unread" : "Mark this chapter’s files read"}
    >
      <button
        type="button"
        aria-pressed={done}
        onClick={onToggle}
        className="-mx-1 flex items-center gap-1.5 rounded px-1 text-sm text-text-muted tabular-nums hover:bg-border/50 hover:text-foreground"
      >
        <ReadRing tally={read} className="size-3.5" />
        {done || read.read === 0 ? "Reviewed" : `${read.read} of ${read.total} read`}
      </button>
    </TooltipHint>
  );
}

function CommentsDoor({
  chapter,
  onOpen,
}: {
  chapter: OverviewChapter;
  onOpen: () => void;
}): ReactElement | null {
  if (chapter.firstCommentId === null) {
    return null;
  }
  return (
    <TooltipHint content="Open the chapter on the first of them" side="top" align="end">
      <button
        type="button"
        onClick={onOpen}
        className="flex shrink-0 items-center gap-1 rounded px-1 text-xs text-text-muted tabular-nums hover:bg-border/50 hover:text-foreground"
      >
        <MessageSquare aria-hidden="true" className="size-3.5" />
        {chapterCommentLabel(chapter.comments, chapter.blocking)}
      </button>
    </TooltipHint>
  );
}

/** The number a chapter wears where it leads its own line: its badge text, or a warning glyph
 * for the inferred chapter, which is no authored step. */
function ChapterNumber({ chapter }: { chapter: OverviewChapter }): ReactElement {
  return chapter.ordinal === null ? (
    <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 self-center text-warning" />
  ) : (
    <span className="shrink-0 font-mono text-sm tabular-nums text-text-faint">
      {badgeText(chapter.ordinal)}
    </span>
  );
}

export type ChapterRowActions = {
  /** Open a chapter (any depth) in the diff — soloing it. */
  onOpen: (layerId: string) => void;
  onOpenFile: (layerId: string, path: string) => void;
  onToggleRead: (chapter: OverviewChapter) => void;
  onOpenComments: (chapter: OverviewChapter) => void;
  onSelectReference: ProseLinks["onSelect"];
};

type ChapterRowProps = {
  row: GuideChapterRow;
  /** How many top-level authored chapters there are — the `MM` of `NN / MM`. */
  total: number;
  filePaths: string[];
  symbols: readonly GuideSymbol[];
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null;
  door: AnchorDoor;
  actions: ChapterRowActions;
};

/** A layer's `summary`, on every row that shows one: inline markdown on one line, the `lede`'s
 * tier — so a code span is code here as it is in the steps (drawn as text it showed its
 * backticks), and a reference is a chip into the diff, which the gate holds to the
 * description's rule. */
function ChapterSummary({
  text,
  filePaths,
  actions,
  className,
}: {
  text: string;
  filePaths: string[];
  actions: ChapterRowActions;
  className: string;
}): ReactElement {
  return (
    <Markdown
      text={text}
      links={{ paths: filePaths, onSelect: actions.onSelectReference }}
      className={className}
    />
  );
}

/** A nested chapter's figure, compact and under its prose — the left column is narrower than the
 * evidence column a top-level figure gets, so the picture is drawn at the band's compact metrics
 * in a light frame (caption and counts, no fold: there is nothing beside it to make room for). */
function PartFigure({
  chapter,
  badgeOf,
  door,
  onOpenFile,
}: {
  chapter: OverviewChapter;
  badgeOf: ChapterRowProps["badgeOf"];
  door: AnchorDoor;
  onOpenFile: (path: string) => void;
}): ReactElement | null {
  const figure = chapterPartFigure(chapter);
  switch (figure.kind) {
    case "visual":
      return (
        <figure className="mt-3 min-w-0 rounded-lg border border-border bg-diff-surface">
          <figcaption className="flex items-baseline gap-2 px-3 pt-2 text-xs text-text-muted">
            <span className="min-w-0">{figure.visual.caption}</span>
            <span className="ml-auto">
              <VisualCountsLabel visual={figure.visual} />
            </span>
          </figcaption>
          <div className={figure.visual.kind === "skeleton" ? "pt-1 pb-2" : "px-1 pb-1"}>
            <VisualFigure visual={figure.visual} badgeOf={badgeOf} door={door} compact />
          </div>
        </figure>
      );
    case "snippet":
      return (
        <DiffSnippet
          file={figure.snippet.file}
          snippet={figure.snippet.snippet}
          onOpen={() => onOpenFile(figure.snippet.file)}
          className="mt-3"
        />
      );
    case "none":
      return null;
  }
}

/** A nested chapter, inside its group's row: number, label, summary, its authored figure,
 * files, its own Reviewed. */
function ChapterPart({
  chapter,
  filePaths,
  badgeOf,
  door,
  actions,
}: {
  chapter: OverviewChapter;
  filePaths: string[];
  badgeOf: ChapterRowProps["badgeOf"];
  door: AnchorDoor;
  actions: ChapterRowActions;
}): ReactElement {
  const { layer } = chapter;
  const headingId = layerHeadingDomId(layer.id);
  return (
    <div
      id={layerSectionDomId(layer.id)}
      aria-labelledby={headingId}
      role="group"
      className="scroll-mt-6 border-l border-border pl-4"
    >
      <h3 id={headingId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <ChapterNumber chapter={chapter} />
        <button
          type="button"
          onClick={() => actions.onOpen(layer.id)}
          className="min-w-0 text-left text-base font-medium text-foreground hover:underline"
        >
          {layer.label}
        </button>
        {chapter.outdated && <ChapterChip>Outdated</ChapterChip>}
        {chapter.skim && <ChapterChip>Skim</ChapterChip>}
        <span className="ml-auto">
          <ReviewedToggle read={chapter.read} onToggle={() => actions.onToggleRead(chapter)} />
        </span>
      </h3>
      {layer.summary !== undefined && (
        <ChapterSummary
          text={layer.summary}
          filePaths={filePaths}
          actions={actions}
          className="mt-0.5 text-sm text-text-muted"
        />
      )}
      {layer.description !== undefined && !chapter.skim && (
        <Markdown
          text={layer.description}
          links={{ paths: filePaths, onSelect: actions.onSelectReference }}
          diagrams
          className="mt-2 space-y-2 text-sm leading-relaxed text-foreground"
        />
      )}
      <PartFigure
        chapter={chapter}
        badgeOf={badgeOf}
        door={door}
        onOpenFile={(path) => actions.onOpenFile(layer.id, path)}
      />
      <div className="mt-2">
        <FileList files={chapter.files} onOpenFile={(path) => actions.onOpenFile(layer.id, path)} />
      </div>
    </div>
  );
}

/** The right column: the chapter's evidence. */
function ChapterEvidence({
  chapter,
  badgeOf,
  door,
  onOpenFile,
}: {
  chapter: OverviewChapter;
  badgeOf: ChapterRowProps["badgeOf"];
  door: AnchorDoor;
  onOpenFile: (path: string) => void;
}): ReactElement | null {
  const figure = chapterFigure(chapter);
  switch (figure.kind) {
    case "visual":
      return <VisualCard visual={figure.visual} badgeOf={badgeOf} door={door} />;
    case "snippet":
      return (
        <DiffSnippet
          file={figure.snippet.file}
          snippet={figure.snippet.snippet}
          onOpen={() => onOpenFile(figure.snippet.file)}
          className="shadow-xs"
        />
      );
    case "none":
      return null;
  }
}

/** The compact row: a skim chapter, or the inferred "not covered" one. One line, then files. */
function CompactRow({
  row,
  filePaths,
  actions,
}: Pick<ChapterRowProps, "row" | "filePaths" | "actions">): ReactElement {
  const { chapter } = row;
  const { layer } = chapter;
  const headingId = layerHeadingDomId(layer.id);
  return (
    <section
      id={layerSectionDomId(layer.id)}
      aria-labelledby={headingId}
      className="scroll-mt-6 border-t border-border py-6"
    >
      <h2 id={headingId} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <ChapterNumber chapter={chapter} />
        <button
          type="button"
          onClick={() => actions.onOpen(layer.id)}
          className="min-w-0 text-left text-base font-medium text-foreground hover:underline"
        >
          {layer.label}
        </button>
        {chapter.skim && (
          <TooltipHint
            content="Mechanical — the author marked this chapter skim, and its files open folded in the diff"
            side="top"
            align="start"
          >
            <ChapterChip>Skim</ChapterChip>
          </TooltipHint>
        )}
        {chapter.outdated && <ChapterChip>Outdated</ChapterChip>}
        {layer.summary !== undefined && (
          <ChapterSummary
            text={layer.summary}
            filePaths={filePaths}
            actions={actions}
            className="min-w-0 text-sm text-text-muted"
          />
        )}
        <span className="ml-auto flex items-center gap-3">
          <CommentsDoor chapter={chapter} onOpen={() => actions.onOpenComments(chapter)} />
          <ReviewedToggle read={chapter.read} onToggle={() => actions.onToggleRead(chapter)} />
        </span>
      </h2>
      <div className="mt-2 max-w-2xl">
        <FileList files={chapter.files} onOpenFile={(path) => actions.onOpenFile(layer.id, path)} />
      </div>
    </section>
  );
}

export function ChapterRow({
  row,
  total,
  filePaths,
  symbols,
  badgeOf,
  door,
  actions,
}: ChapterRowProps): ReactElement {
  const { chapter, children } = row;
  if (chapter.skim || chapter.ordinal === null) {
    return <CompactRow row={row} filePaths={filePaths} actions={actions} />;
  }
  const { layer } = chapter;
  const headingId = layerHeadingDomId(layer.id);
  const extent = new Set([layer.id, ...children.map((child) => child.layer.id)]);
  const chips = chapterSymbols(symbols, extent);
  const evidence: ReactNode = (
    <ChapterEvidence
      chapter={chapter}
      badgeOf={badgeOf}
      door={door}
      onOpenFile={(path) => actions.onOpenFile(layer.id, path)}
    />
  );
  return (
    <section
      id={layerSectionDomId(layer.id)}
      aria-labelledby={headingId}
      className="scroll-mt-6 border-t border-border py-10"
    >
      <div className="grid grid-cols-1 gap-x-12 gap-y-6 @4xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col">
          <h2
            id={headingId}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-lg leading-7 font-medium"
          >
            <button
              type="button"
              onClick={() => actions.onOpen(layer.id)}
              className="min-w-0 text-left text-foreground hover:underline"
            >
              {layer.label}
            </button>
            {chapter.outdated && <ChapterChip>Outdated</ChapterChip>}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-sm tabular-nums text-text-faint">
              {chapterCounter(chapter.ordinal ?? "", total)}
            </span>
            <ReviewedToggle read={chapter.read} onToggle={() => actions.onToggleRead(chapter)} />
            <span className="ml-auto">
              <CommentsDoor chapter={chapter} onOpen={() => actions.onOpenComments(chapter)} />
            </span>
          </div>
          {layer.summary !== undefined && (
            <ChapterSummary
              text={layer.summary}
              filePaths={filePaths}
              actions={actions}
              className="mt-4 text-base text-text-muted"
            />
          )}
          {layer.description !== undefined && (
            <Markdown
              text={layer.description}
              links={{ paths: filePaths, onSelect: actions.onSelectReference }}
              diagrams
              className="mt-3 space-y-3 text-base leading-relaxed text-foreground"
            />
          )}
          {/* A group's files are listed by its parts below — printing them here too would say
              everything twice. */}
          {children.length === 0 && (
            <div className="mt-5">
              <FileList
                files={chapter.files}
                onOpenFile={(path) => actions.onOpenFile(layer.id, path)}
              />
            </div>
          )}
          <SymbolChips symbols={chips} door={door} className="mt-4" />
          {children.length > 0 && (
            <div className="mt-6 flex flex-col gap-5">
              {children.map((child) => (
                <ChapterPart
                  key={child.layer.id}
                  chapter={child}
                  filePaths={filePaths}
                  badgeOf={badgeOf}
                  door={door}
                  actions={actions}
                />
              ))}
            </div>
          )}
        </div>
        {/* Sticky, so a long left column (a group with parts) keeps its evidence beside it. */}
        <div className="min-w-0">
          <div className="@4xl:sticky @4xl:top-6">{evidence}</div>
        </div>
      </div>
    </section>
  );
}
