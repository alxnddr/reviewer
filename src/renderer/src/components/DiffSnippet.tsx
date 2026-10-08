import type { ReactElement } from "react";
import { countLabel } from "../../../shared/plural";
import type { HunkSnippet } from "@/lib/diff/snippet";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { CODE_FACE } from "@/components/guide/anchor-door";
import { cn } from "@/lib/utils";

// A chapter's key hunk, rendered as plain rows: both line numbers, the `+`/`−` marker in the
// diff's signal colour, and the text on its change-tinted row — the guide's right-hand card
// (`components/guide/ChapterRow.tsx`), read beside the chapter's prose the way Capy's guide sets
// one real diff card beside each chapter.
//
// Deliberately unhighlighted and single-line-clipped: it is a taste of the code, never the code
// view. Highlighting is `@pierre/diffs`' job and lives behind its worker pool; spinning that up
// per card for ten chapters would be the diff surface rebuilt inside the overview, and the door
// to the real thing is the header, one click away. The rows come from `hunkSnippet`
// (`lib/diff/snippet.ts`), which decides the window; this only draws it.

type DiffSnippetProps = {
  /** The path the lines come from, shown as the card's header. */
  file: string;
  snippet: HunkSnippet;
  /** Open the code this card shows — the header is the door. Absent: the header is a label. */
  onOpen?: (() => void) | undefined;
  /** Shown at the header's right edge: where the card came from (`focus`, first range). */
  aside?: string | undefined;
  className?: string;
};

function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { name: path, dir: "" }
    : { name: path.slice(cut + 1), dir: path.slice(0, cut + 1) };
}

export function DiffSnippet({
  file,
  snippet,
  onOpen,
  aside,
  className,
}: DiffSnippetProps): ReactElement {
  const { name, dir } = splitPath(file);
  const header = (
    <>
      <FileTypeIcon path={file} className="size-3.5 shrink-0" />
      <span className="shrink-0 text-foreground">{name}</span>
      <span className="min-w-0 truncate text-text-faint">{dir}</span>
      {snippet.context !== null && (
        <span className="hidden min-w-0 truncate font-mono text-text-faint @lg:inline">
          {snippet.context}
        </span>
      )}
      {aside !== undefined && <span className="ml-auto shrink-0 text-text-faint">{aside}</span>}
    </>
  );
  return (
    <div
      className={cn(
        "@container overflow-hidden rounded-lg border border-border bg-diff-surface",
        className,
      )}
    >
      {/* The header names the file, so it is chrome and sets in the shell sans; only the
          lines below it are code. */}
      {onOpen === undefined ? (
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs">
          {header}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-xs hover:bg-border/30"
        >
          {header}
        </button>
      )}
      <div className="py-1">
        {snippet.lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "flex items-baseline gap-2 border-l-2 border-transparent pr-3 text-xs leading-5",
              CODE_FACE,
              line.kind === "addition" && "border-diff-add-fg bg-diff-add-bg",
              line.kind === "deletion" && "border-diff-del-fg bg-diff-del-bg",
            )}
          >
            <span className="w-8 shrink-0 text-right tabular-nums text-text-faint">
              {line.oldLine ?? ""}
            </span>
            <span className="w-8 shrink-0 text-right tabular-nums text-text-faint">
              {line.newLine ?? ""}
            </span>
            <span
              className={cn(
                "w-2 shrink-0",
                line.kind === "addition" && "text-diff-add-fg",
                line.kind === "deletion" && "text-diff-del-fg",
              )}
            >
              {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
            </span>
            <span className="min-w-0 flex-1 truncate whitespace-pre text-foreground/90">
              {line.text}
            </span>
          </div>
        ))}
      </div>
      {snippet.hidden > 0 && (
        <div className="border-t border-border px-3 py-1 text-xs text-text-faint">
          {countLabel(snippet.hidden, "more line")}
        </div>
      )}
    </div>
  );
}
