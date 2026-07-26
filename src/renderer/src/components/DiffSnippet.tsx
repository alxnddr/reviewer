import type { ReactElement } from "react";
import type { SnippetLine } from "@/lib/diff/snippet";
import { cn } from "@/lib/utils";

// A few real lines of a diff, rendered as plain rows: line numbers, the `+`/`−` marker in
// the diff's signal colour, and the text on its change-tinted row. Deliberately
// unhighlighted and single-line-clipped — it is a taste of the code, never the code view.
//
// Nothing places it at the moment: the tour doc used to head each layer with one, and
// reads better as continuous prose without them. It stays because the shape is right for
// the next surface that wants an inline preview (a comment's context, a search hit), and
// `buildOverview` still derives the lines it takes.

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

type DiffSnippetProps = {
  /** The path the lines come from, shown as the preview's header. */
  file: string;
  lines: SnippetLine[];
  /** Lines the range carries past the ones shown, so the preview says what it withheld
   * rather than silently trimming. */
  hidden: number;
  className?: string;
};

export function DiffSnippet({ file, lines, hidden, className }: DiffSnippetProps): ReactElement {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border", className)}>
      <div className="truncate border-b border-border bg-border/20 px-2 py-1 font-mono text-xs text-text-faint">
        {file}
      </div>
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "flex items-baseline gap-2 px-2 font-mono text-xs leading-5",
            line.kind === "addition" && "bg-diff-add-bg",
            line.kind === "deletion" && "bg-diff-del-bg",
          )}
        >
          <span className="w-8 shrink-0 text-right tabular-nums text-text-faint">{line.line}</span>
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
      {hidden > 0 && (
        <div className="px-2 py-1 text-xs text-text-faint">+ {countLabel(hidden, "more line")}</div>
      )}
    </div>
  );
}
