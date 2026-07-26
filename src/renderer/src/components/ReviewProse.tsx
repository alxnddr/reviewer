import { useMemo, type ReactElement, type RefObject } from "react";
import {
  parseLayerDescription,
  type DescriptionBlock,
  type DescriptionRun,
} from "@/lib/layer-description";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { InlineCode } from "@/components/InlineCode";

// The artifact's one prose tier, rendered: the markdown grammar a layer `description`
// and the overview `body` share (paragraphs, headings, lists, quotes, fences, rules;
// `code` spans, `[label](path)` links, strong and emphasis). Links resolve against the
// files actually in the diff, so a clickable chip always navigates to something on
// screen and an absent reference is inert — the rule `rvw check` gates against. One
// component so the chapter band and the tour doc can never render the same grammar two
// different ways.

type FileChipProps = {
  /** What the prose calls it — a `[label](path)` label, or the path itself. */
  label: string;
  /** What it resolves to, which is what the icon is drawn from: a chip may be labelled
   * anything, but it always stands for one real file in the diff. */
  path: string;
  onSelect: () => void;
};

/** A resolved file reference: a chip that jumps the diff to the file. Set in the prose's
 * own face, not mono — it names a file, it does not quote code, and a mono run inside a
 * sentence reads as a foreign body. Sized and padded a step tighter than the button's `xs`
 * so the chip sits *in* the line rather than swelling it. */
function FileChip({ label, path, onSelect }: FileChipProps): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onSelect}
      className="mx-0.5 h-5.5 gap-1 rounded border border-border-strong px-1.5 align-baseline text-sm hover:bg-border/60 dark:hover:bg-border/60"
    >
      {/* The file's own type glyph, exactly as the tree and the doc's file rows draw it —
          a file looks like itself wherever the app names it, mid-sentence included. */}
      <FileTypeIcon path={path} className="size-3.5" />
      {label}
    </Button>
  );
}

/** Unresolved reference: the target is not in this diff. Shown as a label, never a dead
 * click — and in the same face and inset as the live chip, so the only difference a reader
 * sees is the one that matters (no border weight, no hover, no icon). */
function DeadRef({ label }: { label: string }): ReactElement {
  return (
    <TooltipHint content="Not in this diff" side="top" align="center">
      <span className="mx-0.5 rounded border border-border/60 px-1.5 text-sm text-text-muted">
        {label}
      </span>
    </TooltipHint>
  );
}

function renderRuns(
  runs: readonly DescriptionRun[],
  onSelect: (file: string) => void,
): ReactElement[] {
  return runs.map((run, index) => renderRun(run, index, onSelect));
}

function renderRun(
  run: DescriptionRun,
  index: number,
  onSelect: (file: string) => void,
): ReactElement {
  switch (run.kind) {
    case "text":
      return <span key={index}>{run.text}</span>;
    case "code": {
      if (run.file === null) {
        return <InlineCode key={index}>{run.text}</InlineCode>;
      }
      const file = run.file;
      return <FileChip key={index} label={run.text} path={file} onSelect={() => onSelect(file)} />;
    }
    case "link": {
      if (run.file === null) {
        return <DeadRef key={index} label={run.label} />;
      }
      const file = run.file;
      return <FileChip key={index} label={run.label} path={file} onSelect={() => onSelect(file)} />;
    }
    // A step past the headings' `font-medium`: a heading gets its contrast from size
    // and placement, an inline bold has only weight — at 500 it disappears into the
    // sentence around it.
    case "strong":
      return (
        <strong key={index} className="font-semibold">
          {renderRuns(run.runs, onSelect)}
        </strong>
      );
    case "emphasis":
      return (
        <em key={index} className="italic">
          {renderRuns(run.runs, onSelect)}
        </em>
      );
  }
}

function renderBlock(
  block: DescriptionBlock,
  index: number,
  onSelect: (file: string) => void,
): ReactElement {
  switch (block.kind) {
    case "paragraph":
      return (
        <p key={index} className="break-words">
          {renderRuns(block.runs, onSelect)}
        </p>
      );
    case "heading": {
      // Two ranks, both under the section headings the prose already sits beneath:
      // `#`/`##` read at the body size in the medium weight (what a nested overview
      // section takes), deeper levels drop to the small size. Rendered as h3/h4 —
      // every surface that shows prose puts its own h1/h2 above it.
      const runs = renderRuns(block.runs, onSelect);
      return block.level <= 2 ? (
        <h3 key={index} className="text-base font-medium break-words">
          {runs}
        </h3>
      ) : (
        <h4 key={index} className="text-sm font-medium break-words">
          {runs}
        </h4>
      );
    }
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex} className="break-words">
          {renderRuns(item, onSelect)}
        </li>
      ));
      // Markers in the faint ink: they structure the text, they are not the text.
      const listClass = "space-y-1 pl-5 marker:text-text-faint";
      return block.ordered ? (
        <ol key={index} start={block.start} className={`list-decimal ${listClass}`}>
          {items}
        </ol>
      ) : (
        <ul key={index} className={`list-disc ${listClass}`}>
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote
          key={index}
          className="border-l-2 border-border-strong pl-3 break-words text-text-muted"
        >
          {renderRuns(block.runs, onSelect)}
        </blockquote>
      );
    case "codeBlock":
      // Quoted code is a foreign body and dresses like one: hairline frame, faint
      // tinted ground, mono a step under the reading size — the diff snippet's own
      // surface. It scrolls sideways rather than wrapping; wrapped code lies about
      // its line breaks.
      return (
        <pre
          key={index}
          className="overflow-x-auto rounded-md border border-border bg-border/20 px-3 py-2 font-mono text-sm leading-6"
        >
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      // The hairline the doc already draws at its section boundaries.
      return <hr key={index} className="border-border" />;
  }
}

type ReviewProseProps = {
  text: string;
  /** The files a reference may resolve to — the caller's navigable set (the soloed
   * subset in a chapter band, the whole diff in the tour doc). */
  filePaths: readonly string[];
  onSelectFile: (path: string) => void;
  className?: string;
  /** The measured block when a caller fits a panel to the prose's own height
   * (`lib/fit-panel.ts`); absent everywhere the prose just flows. */
  ref?: RefObject<HTMLDivElement | null> | undefined;
};

export function ReviewProse({
  text,
  filePaths,
  onSelectFile,
  className,
  ref,
}: ReviewProseProps): ReactElement {
  const diffFiles = useMemo(() => new Set(filePaths), [filePaths]);
  const blocks = useMemo(() => parseLayerDescription(text, diffFiles), [text, diffFiles]);

  return (
    <div ref={ref} className={className}>
      {blocks.map((block, blockIndex) => renderBlock(block, blockIndex, onSelectFile))}
    </div>
  );
}
