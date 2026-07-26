import { useEffect, useMemo, type ReactElement } from "react";
import { ChevronDown, ChevronRight, History, MapPinOff, MessageSquare } from "lucide-react";
import type { Comment } from "../../../shared/review";
import type { PatchFile } from "@/lib/diff/patch";
import type { FitToContentRefs } from "@/lib/fit-panel";
import { orderedComments, type CommentNavEntry } from "@/lib/diff/comment-navigation";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { TooltipHint } from "@/components/ui/tooltip";
import { commentLocation, segmentInlineCode } from "@/lib/comment-body";
import { cn } from "@/lib/utils";

type CommentsPanelProps = {
  /** The full loaded diff (not a soloed subset): the panel is the whole-review
   * overview, so it lists every comment and lets a click into a soloed-out file
   * clear the solo. */
  files: readonly PatchFile[];
  comments: Comment[];
  frozen: boolean;
  activeCommentId: string | null;
  onFocusComment: (commentId: string) => void;
  /** Disclosure is owned by the parent (SidebarNav) so it can host the expanded
   * list in a resizable panel and fall back to a plain bar when collapsed — the
   * same split DiffScreen makes for the layer intro. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** In `fill` mode the list flexes to its resizable panel's dragged height and the
   * seam handle draws the divider; otherwise it's a content-height band capped so a
   * long list scrolls in place (the collapsed bar and the no-resize fallback). */
  fill: boolean;
  /** Present when the list lives in a panel the parent fits to the rows' own height:
   * the scroll box is the viewport, the row block inside it the measured content —
   * the same wiring the layer tree above it uses. */
  fit?: FitToContentRefs;
};

function rowDomId(commentId: string): string {
  return `comment-row-${commentId}`;
}

/** The body collapsed to a single scannable line: newlines and runs of space fold
 * to one space so the row's `truncate` shows a clean preview (the full body reads
 * on the card in the diff, and on this row's hover hint). */
function bodyPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** A body's sans/mono split, inline — the same rule `CommentBody` applies on the
 * card, without its reading-register type and colour: here it runs inside a 13px
 * row and inside an inverted hint, both of which set their own ink. */
function InlineBody({ body }: { body: string }): ReactElement {
  return (
    <>
      {segmentInlineCode(body).map((segment, index) =>
        segment.code ? (
          <code key={index} className="font-mono">
            {segment.text}
          </code>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** A path split for the group heading: the name is what the reader scans for, the
 * directory only disambiguates two files sharing one name. */
function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

/** Consecutive entries sharing a file, in the order `orderedComments` produced —
 * the grouping only inserts headings, it never reorders. */
function groupByFile(
  entries: readonly CommentNavEntry[],
): { file: string; rows: CommentNavEntry[] }[] {
  const groups: { file: string; rows: CommentNavEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.file === entry.comment.file) {
      last.rows.push(entry);
    } else {
      groups.push({ file: entry.comment.file, rows: [entry] });
    }
  }
  return groups;
}

/** The sidebar comment overview: a collapsed count-bar (the ambient "there are N
 * comments" the reviewer was missing) that expands to the whole list, grouped by
 * file in reading order, each row jumping to its comment. Mirrors
 * `UnplaceableComments`' disclosure pattern; the active row (the one the reader
 * stepped to with `n`/`p` or clicked) is lit so the panel and the diff agree. Null
 * when the session has no comments, so the bar is absent on a plain diff.
 *
 * The list is built to be *scanned*, on the same one-line register as the layer
 * rail above it: a file heading, then one row per comment — the body's first
 * line, elided. Nobody reads a review in a 256px rail, so the row spends its width
 * on the only question it can answer at a glance ("which comment is this?") and
 * leaves the rest to the card in the diff, one click away, or to the hover hint. */
export function CommentsPanel({
  files,
  comments,
  frozen,
  activeCommentId,
  onFocusComment,
  expanded,
  onToggleExpanded,
  fill,
  fit,
}: CommentsPanelProps): ReactElement | null {
  const entries = useMemo(
    () => orderedComments(files, comments, frozen),
    [files, comments, frozen],
  );

  // Placeable entries group under their file; stranded ones trail behind a divider
  // that says why they are apart. Both use the same heading and the same row.
  const { placed, stranded } = useMemo(
    () => ({
      placed: groupByFile(entries.filter((entry) => entry.status !== "unplaceable")),
      stranded: groupByFile(entries.filter((entry) => entry.status === "unplaceable")),
    }),
    [entries],
  );

  // The rail is where the reader tracks which comment they are on, so a selection
  // walked off screen with `n`/`p` is brought back — the same rule the layer tree
  // applies to its soloed row. Inert while collapsed: no row is mounted to find.
  useEffect(() => {
    if (activeCommentId !== null) {
      document.getElementById(rowDomId(activeCommentId))?.scrollIntoView({ block: "nearest" });
    }
  }, [activeCommentId, expanded]);

  if (comments.length === 0) {
    return null;
  }
  const count = comments.length;

  const renderGroups = (groups: { file: string; rows: CommentNavEntry[] }[]): ReactElement[] =>
    groups.map((group) => (
      <li key={group.file}>
        <FileHeading path={group.file} />
        <ul>
          {group.rows.map((entry) => (
            <li key={entry.comment.id}>
              <CommentRow
                entry={entry}
                active={entry.comment.id === activeCommentId}
                onFocus={() => onFocusComment(entry.comment.id)}
              />
            </li>
          ))}
        </ul>
      </li>
    ));

  return (
    // Fill mode fills the resize panel (the seam handle below draws the divider);
    // collapsed / no-resize is a content-height bar that carries its own bottom border.
    <div
      className={cn("flex flex-col", fill ? "h-full min-h-0" : "shrink-0 border-b border-border")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
        className="flex h-9 w-full shrink-0 items-center gap-1.5 px-2 text-xs text-text-muted hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3.5" />
        )}
        <MessageSquare aria-hidden="true" className="size-3.5" />
        {count === 1 ? "1 comment" : `${count} comments`}
      </button>
      {expanded && (
        <div
          ref={fit?.viewportRef}
          className={cn("overflow-y-auto pb-1", fill ? "min-h-0 flex-1" : "max-h-64")}
        >
          <div ref={fit?.contentRef}>
            <ul>
              {renderGroups(placed)}
              {stranded.length > 0 && (
                <li>
                  {/* Not a file heading: it says why the groups under it are set apart,
                      so it takes the stranded surface's own glyph and stays out of the
                      sticky stack — a divider that stuck would compete with the heading
                      it introduces. */}
                  <div className="flex h-7 items-center gap-1.5 px-2 text-2xs text-text-faint">
                    <MapPinOff aria-hidden="true" className="size-3 shrink-0" />
                    Not in this diff
                  </div>
                  <ul>{renderGroups(stranded)}</ul>
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/** The file a run of comments belongs to. Sticky, so scrolling deep into one file's
 * comments never loses which file they are in. The name carries the ink and the
 * directory trails it faintly — a path truncated from the right cuts off exactly
 * the part the reader was looking for, so the name is placed where it cannot be
 * cut and the directory absorbs the narrowing instead. */
function FileHeading({ path }: { path: string }): ReactElement {
  const { dir, name } = splitPath(path);
  return (
    // The 4px of air rides *inside* the sticky box (h-8 + pt-1, not a margin above
    // it): a margin would leave a gap the rows underneath scroll through while the
    // heading is pinned, and a heading with a stripe of moving text above it stops
    // reading as a heading.
    <div className="sticky top-0 z-10 flex h-8 items-center gap-1.5 overflow-hidden bg-sidebar px-2 pt-1">
      <FileTypeIcon path={path} className="size-3.5" />
      {/* Only a path with a directory can lose anything to the narrowing, so only
          that one arms a hint — on a root-level file it would repeat the row. */}
      <TooltipHint content={dir === "" ? null : path} side="right" align="center">
        <span className="flex min-w-0 items-baseline gap-1.5">
          {/* The name never gives up room (`shrink-0`): it is the heading, and a rail
              narrow enough to threaten it should spend the directory first. */}
          <span className="shrink-0 truncate text-xs font-medium text-foreground">{name}</span>
          {dir !== "" && (
            // A directory elides from the *front* (`…/lib/diff`): its tail is the part
            // that says which one it is, and the head is the part every path in the
            // repo shares. `direction: rtl` moves the ellipsis to the start — the text
            // itself has no strong RTL characters, so the segments keep their order —
            // and `text-left` keeps a short directory beside its name instead of
            // drifting to the far edge.
            <span className="min-w-0 truncate text-left text-2xs text-text-faint [direction:rtl]">
              {dir}
            </span>
          )}
        </span>
      </TooltipHint>
    </div>
  );
}

type CommentRowProps = {
  entry: CommentNavEntry;
  active: boolean;
  onFocus: () => void;
};

/** One comment: its body on a single elided line, indented under its file heading,
 * with the line it sits on held in a quiet mono column at the right — the diff's
 * own gutter idiom, and the one piece of metadata the row cannot infer from the
 * heading above it. An outdated anchor has no line to name (it pins to the file
 * header on the surface), so the column carries the drift glyph instead of a number
 * that would be a guess. The active row is lit to match the ringed card in the diff. */
function CommentRow({ entry, active, onFocus }: CommentRowProps): ReactElement {
  const { comment, status } = entry;
  // The placed line — where the comment actually renders on the current diff, which
  // is what a reader jumping there will see in the gutter, not the authored line it
  // may have drifted from. A stranded comment never placed, so it keeps its own.
  const line = entry.line ?? comment.startLine;

  return (
    <button
      type="button"
      id={rowDomId(comment.id)}
      onClick={onFocus}
      aria-current={active}
      // pl-7 lines the preview up with the heading's file name (px-2 + the glyph
      // and its gap), so a file and everything under it share one left edge.
      className={cn(
        "group flex h-7 w-full items-center gap-2 pr-2 pl-7 text-left",
        active ? "bg-selected" : "hover:bg-border/30",
      )}
    >
      {/* The hint hangs off the preview, not the row: the row is the hit target and a
          hint on it would repeat what the row already shows. This one says what the
          line cannot hold — the body in full, and the anchor it was authored against. */}
      <TooltipHint
        side="right"
        align="center"
        content={
          <div className="flex min-w-0 flex-col gap-1">
            <span className="whitespace-pre-wrap">
              <InlineBody body={comment.body} />
            </span>
            {/* Where it sits, but only when the row can't say it: a placed comment
                already shows its file in the heading above and its line at the right,
                so repeating them here would be the noise the hint exists to avoid.
                A drifted or stranded one has no line on screen — it gets the authored
                anchor, and the word for why it is off it. */}
            {status !== "placed" && (
              <span className="text-background/70">
                {status === "outdated" ? "Outdated · " : "Not in this diff · "}
                <span className="font-mono break-all">{commentLocation(comment)}</span>
              </span>
            )}
          </div>
        }
      >
        {/* The preview keeps the body's sans/mono split — a `symbol` reads as machine
            text here exactly as it does on the card, which is most of what makes a
            one-line preview recognisable as the comment it stands for. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            active ? "text-foreground" : "text-text-muted group-hover:text-foreground",
          )}
        >
          <InlineBody body={bodyPreview(comment.body)} />
        </span>
      </TooltipHint>
      {status === "outdated" ? (
        <History aria-hidden="true" className="size-3 shrink-0 text-warning" />
      ) : (
        <span className="shrink-0 font-mono text-2xs tabular-nums text-text-faint">{line}</span>
      )}
    </button>
  );
}
