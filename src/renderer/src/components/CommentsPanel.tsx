import { useMemo, type ReactElement } from "react";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import type { Comment } from "../../../shared/review";
import type { PatchFile } from "@/lib/diff/patch";
import { orderedComments, type CommentNavEntry } from "@/lib/diff/comment-navigation";
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
};

/** A one-line anchor label under a file header, where the path is already shown. */
function lineLabel(comment: Comment): string {
  return comment.startLine === comment.endLine
    ? `L${comment.startLine}`
    : `L${comment.startLine}–${comment.endLine}`;
}

/** The body collapsed to a single scannable line: newlines and runs of space fold
 * to one space so the row's `truncate` shows a clean preview (the full body reads
 * on the card in the diff). */
function bodyPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** The sidebar comment overview: a collapsed count-bar (the ambient "there are N
 * comments" the reviewer was missing) that expands to the whole list, grouped by
 * file in reading order, each row jumping to its comment. Mirrors
 * `UnplaceableComments`' disclosure pattern; the active row (the one the reader
 * stepped to with `n`/`p` or clicked) is lit so the panel and the diff agree. Null
 * when the session has no comments, so the bar is absent on a plain diff. */
export function CommentsPanel({
  files,
  comments,
  frozen,
  activeCommentId,
  onFocusComment,
  expanded,
  onToggleExpanded,
  fill,
}: CommentsPanelProps): ReactElement | null {
  const entries = useMemo(
    () => orderedComments(files, comments, frozen),
    [files, comments, frozen],
  );

  if (comments.length === 0) {
    return null;
  }
  const count = comments.length;
  // Grouped by file, preserving the ordered-entry sequence (file diff order, then
  // outdated-first, then by line). Unplaceable entries trail in their own section.
  const placeable = entries.filter((entry) => entry.status !== "unplaceable");
  const unplaceable = entries.filter((entry) => entry.status === "unplaceable");
  const groups: { file: string; entries: CommentNavEntry[] }[] = [];
  for (const entry of placeable) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.file === entry.comment.file) {
      last.entries.push(entry);
    } else {
      groups.push({ file: entry.comment.file, entries: [entry] });
    }
  }

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
        <ul className={cn("overflow-y-auto pb-2", fill ? "min-h-0 flex-1" : "max-h-64")}>
          {groups.map((group) => (
            <li key={group.file}>
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted"
                  title={group.file}
                >
                  {group.file}
                </span>
                <span className="shrink-0 text-xs text-text-muted tabular-nums">
                  {group.entries.length}
                </span>
              </div>
              <ul>
                {group.entries.map((entry) => (
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
          ))}
          {unplaceable.length > 0 && (
            <li>
              <div className="px-3 pt-2 pb-1 text-xs text-text-muted">Not in this diff</div>
              <ul>
                {unplaceable.map((entry) => (
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
          )}
        </ul>
      )}
    </div>
  );
}

type CommentRowProps = {
  entry: CommentNavEntry;
  active: boolean;
  onFocus: () => void;
};

/** One comment in the list: its line ref (or an Outdated/stranded tag) over a
 * one-line body preview. The active row is lit to match the ringed card in the diff. */
function CommentRow({ entry, active, onFocus }: CommentRowProps): ReactElement {
  const { comment, status } = entry;
  return (
    <button
      type="button"
      onClick={onFocus}
      aria-current={active}
      className={cn(
        "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left",
        active ? "bg-selected" : "hover:bg-border/40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-xs text-text-muted">{lineLabel(comment)}</span>
        {status === "outdated" && (
          <span className="shrink-0 rounded bg-border/60 px-1 py-0.5 text-[10px] text-foreground">
            Outdated
          </span>
        )}
      </div>
      {/* One-line preview: the list stays scannable; the full body reads on the card. */}
      <span className="w-full truncate text-xs text-foreground/80">
        {bodyPreview(comment.body)}
      </span>
    </button>
  );
}
