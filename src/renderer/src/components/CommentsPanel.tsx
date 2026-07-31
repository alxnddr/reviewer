import { memo, useMemo, type ReactElement } from "react";
import { History, MapPinOff, MessageSquare } from "lucide-react";
import type { Comment } from "../../../shared/review";
import { countLabel } from "../../../shared/plural";
import type { PatchFile } from "../../../shared/diff/patch";
import type { FitToContentRefs } from "@/lib/fit-panel";
import { orderedComments, type CommentNavEntry } from "@/lib/diff/comment-navigation";
import { CopyAllCommentsPromptButton } from "@/components/CopyPromptButton";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { TooltipHint } from "@/components/ui/tooltip";
import { commentLocation } from "@/lib/comment-location";
import { useScrollIntoViewById } from "@/lib/use-scroll-into-view";
import { flattenMarkdown } from "../../../shared/markdown";
import {
  RAIL_GLYPH,
  RailCaption,
  RailRowButton,
  RailRowMeta,
  RailSection,
} from "@/components/rail";
import { cn } from "@/lib/utils";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

/** Stable empty arrays, so a session with none of either — and an unloaded diff — hands
 * the selectors below one constant reference rather than a fresh [] per tick. */
const EMPTY_COMMENTS: Comment[] = [];
const EMPTY_FILES: PatchFile[] = [];

type CommentsPanelProps = {
  /** Disclosure is owned by the rail (`ReviewRail`) so it can host the expanded
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

/** How far a comment row hangs under its file heading: the heading's glyph and the gap
 * after it, so the preview starts exactly where the file name does. Derived from the
 * rail's own glyph size rather than guessed as a padding class. */
const COMMENT_INDENT_PX = 20;

/** A comment body as a rail can show it: markdown flattened to its words
 * (`flattenMarkdown`), with code runs kept mono. Nobody reads markup in a 256px column —
 * a body opening `**[BUG]**` spends the row's first characters on asterisks and brackets,
 * and the bold they ask for is a distinction this register does not draw anyway. What
 * survives is the sans/mono split, because a `symbol` reads as machine text at any size
 * and it is most of what makes a one-line preview recognisable as the comment it stands
 * for. The card in the diff renders the same body in full, one click away.
 *
 * Ink is left to the caller: this runs inside a 13px row and inside an inverted hint,
 * both of which set their own. */
function PlainBody({ body }: { body: string }): ReactElement {
  // Held against the body, because flattening is a full remark parse and the panel
  // re-renders on every step of the `n`/`p` walk — a list of N comments would otherwise
  // re-parse all N on each keypress, for a body that has not changed since it was
  // written. The same memo `Markdown` keeps over its own pipeline, for the same reason.
  const runs = useMemo(() => flattenMarkdown(body), [body]);

  return (
    <>
      {runs.map((run, index) =>
        run.code ? (
          <code key={index} className="font-mono">
            {run.text}
          </code>
        ) : (
          <span key={index}>{run.text}</span>
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
 * the grouping only inserts headings, it never reorders. Keyed on the entry's host
 * `path` rather than the authored `comment.file`, so a heading names a file the diff
 * and the tree actually carry: comments authored on either side of a rename are one
 * group under the file's current name, not two alternating ones under a name the diff
 * no longer has. An unplaceable entry's path *is* its authored one. */
function groupByFile(
  entries: readonly CommentNavEntry[],
): { file: string; rows: CommentNavEntry[] }[] {
  const groups: { file: string; rows: CommentNavEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last !== undefined && last.file === entry.path) {
      last.rows.push(entry);
    } else {
      groups.push({ file: entry.path, rows: [entry] });
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
 * leaves the rest to the card in the diff, one click away, or to the hover hint.
 *
 * A section, so it reads its own state (the rail's rule, `ReviewRail.tsx`); what it takes
 * from the rail is the disclosure and the panel it is fitted through. */
export function CommentsPanel({
  expanded,
  onToggleExpanded,
  fill,
  fit,
}: CommentsPanelProps): ReactElement | null {
  // The full loaded diff, never the soloed subset: the panel is the whole-review overview,
  // so it lists every comment and a click into a soloed-out file clears the solo (which is
  // `focusComment`'s own doing, in the store).
  const files = useReviewStore((state) => {
    const diff = selectActiveSlice(state)?.diff;
    return diff !== undefined && diff.phase === "loaded" ? diff.files : EMPTY_FILES;
  });
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  const activeCommentId = useReviewStore(
    (state) => selectActiveSlice(state)?.activeCommentId ?? null,
  );
  const focusComment = useReviewStore((state) => state.focusComment);
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
  useScrollIntoViewById(
    activeCommentId === null ? null : rowDomId(activeCommentId),
    { block: "nearest" },
    [activeCommentId, expanded],
  );

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
              {/* The handler is passed down as-is rather than closed over the id here:
                  a fresh closure per render is a changed prop, which would defeat the
                  row's memo on every step of the walk. The row knows its own id. */}
              <CommentRow
                entry={entry}
                active={entry.comment.id === activeCommentId}
                onFocus={focusComment}
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
      {/* The disclosure doubles as this panel's F6 landing spot (see lib/focus-regions):
          it is the first focusable thing in the region, so arriving here and pressing Tab
          walks the comment rows in order. */}
      <RailSection
        data-comments-panel
        expanded={expanded}
        onSelect={onToggleExpanded}
        bordered={false}
        icon={<MessageSquare aria-hidden="true" className={RAIL_GLYPH} />}
        // Beside the count, in both disclosure states: the count is how much is left to
        // answer and this is the way to go answer it, so it is on screen whenever the
        // number it acts on is. Unlike the Layers bar's action it does not hide when the
        // list folds — the reader who has collapsed the list is the one most likely to be
        // done reading and about to hand the review off.
        action={<CopyAllCommentsPromptButton />}
      >
        {/* The count stays in both states. Unlike the layer count it is a number a reviewer
            acts on — how much is left to answer — so it is worth a permanent slot, and
            keeping it permanent is also what stops the heading from renaming itself the
            instant you click to fold it. Open, the rows below happen to add up to it; that
            is a reason to trust it, not a reason to take it away. */}
        {countLabel(count, "comment")}
      </RailSection>
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
                  <RailCaption className="text-text-faint">
                    <MapPinOff aria-hidden="true" className="size-3 shrink-0" />
                    Not in this diff
                  </RailCaption>
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
    <RailCaption className="sticky top-0 z-10 h-8 overflow-hidden bg-sidebar pt-1">
      <FileTypeIcon path={path} className={RAIL_GLYPH} />
      {/* Only a path with a directory can lose anything to the narrowing, so only
          that one arms a hint — on a root-level file it would repeat the row. */}
      <TooltipHint content={dir === "" ? null : path} side="right" align="center">
        <span className="flex min-w-0 items-baseline gap-1.5">
          {/* The name never gives up room (`shrink-0`): it is the heading, and a rail
              narrow enough to threaten it should spend the directory first.

              It sets at the rail's own 14px, like the rows it heads — a heading a step
              *smaller* than its own items is backwards, and it was the last of the 11/12px
              text this column had accumulated. Weight and full ink are what separate it
              from the rows, which is the same pair the file tree uses. */}
          <span className="shrink-0 truncate text-sm font-medium text-foreground">{name}</span>
          {dir !== "" && (
            // A directory elides from the *front* (`…/lib/diff`): its tail is the part
            // that says which one it is, and the head is the part every path in the
            // repo shares. `direction: rtl` moves the ellipsis to the start — the text
            // itself has no strong RTL characters, so the segments keep their order —
            // and `text-left` keeps a short directory beside its name instead of
            // drifting to the far edge.
            <span className="min-w-0 truncate text-left text-xs text-text-faint [direction:rtl]">
              {dir}
            </span>
          )}
        </span>
      </TooltipHint>
    </RailCaption>
  );
}

type CommentRowProps = {
  entry: CommentNavEntry;
  active: boolean;
  /** Takes the id rather than closing over it, so the panel can hand every row the
   * one store action and the memo below holds. */
  onFocus: (commentId: string) => void;
};

/** One comment: its body on a single elided line, indented under its file heading,
 * with the line it sits on held in a quiet figure column at the right — the diff's
 * own gutter idiom, in the shell's tabular figures, and the one piece of metadata the
 * row cannot infer from the heading above it. An outdated anchor has no line to name (it pins to the file
 * header on the surface), so the column carries the drift glyph instead of a number
 * that would be a guess. The active row is lit to match the ringed card in the diff.
 *
 * Memoised, because the one prop the walk changes is `active` and it changes for two
 * rows out of N: `activeCommentId` re-renders the whole panel on every `n`/`p` step,
 * and a row whose entry and lit state are both unchanged has nothing new to draw. The
 * entries it reads are already held (`orderedComments` above), so the identities line
 * up. */
const CommentRow = memo(function CommentRow({
  entry,
  active,
  onFocus,
}: CommentRowProps): ReactElement {
  const { comment, status } = entry;
  // The placed line — where the comment actually renders on the current diff, which
  // is what a reader jumping there will see in the gutter, not the authored line it
  // may have drifted from. A stranded comment never placed, so it keeps its own.
  const line = entry.line ?? comment.startLine;

  return (
    <RailRowButton
      id={rowDomId(comment.id)}
      onClick={() => onFocus(comment.id)}
      aria-current={active}
      selected={active}
      // Indented to line the preview up with the heading's file name (the glyph and its
      // gap), so a file and everything under it share one left edge.
      indent={COMMENT_INDENT_PX}
      className="group gap-2"
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
              <PlainBody body={comment.body} />
            </span>
            {/* Where it sits, but only when the row can't say it: a placed comment
                already shows its file in the heading above and its line at the right,
                so repeating them here would be the noise the hint exists to avoid.
                A drifted or stranded one has no line on screen — it gets the authored
                anchor, and the word for why it is off it. */}
            {status !== "placed" && (
              <span className="text-background/70">
                {status === "outdated" ? "Outdated · " : "Not in this diff · "}
                <span className="break-all tabular-nums">{commentLocation(comment)}</span>
              </span>
            )}
          </div>
        }
      >
        {/* One line: `truncate`'s `nowrap` folds the flattened body's block breaks into
            spaces, so a comment written as three paragraphs previews as its opening
            sentence rather than as its first word. */}
        <span className="min-w-0 flex-1 truncate text-sm">
          <PlainBody body={comment.body} />
        </span>
      </TooltipHint>
      {status === "outdated" ? (
        <History aria-hidden="true" className="size-3 shrink-0 text-warning" />
      ) : (
        <RailRowMeta>{line}</RailRowMeta>
      )}
    </RailRowButton>
  );
});
