import { useMemo, type ReactElement } from "react";
import { flattenMarkdown } from "../../../shared/markdown";

/** Markdown as a rail can show it: flattened to its words (`flattenMarkdown`), with code
 * runs kept mono. Two callers — a comment body's preview in the comments rail, and a layer
 * summary in the layers rail's hint — both places where the full `Markdown` face would be
 * wrong. Nobody reads markup in a 256px column — a body opening `**[BUG]**` spends the row's
 * first characters on asterisks and brackets, and the bold they ask for is a distinction this
 * register does not draw anyway. What survives is the sans/mono split, because a `symbol`
 * reads as machine text at any size and it is most of what makes a one-line preview
 * recognisable as the prose it stands for. And a hint cannot hold `Markdown`'s reference
 * chips, which carry hints of their own. The full rendering is one click away.
 *
 * Ink is left to the caller: this runs inside a 13px row and inside an inverted hint,
 * both of which set their own. */
export function PlainMarkdown({ text }: { text: string }): ReactElement {
  // Held against the text, because flattening is a full remark parse and the comments
  // panel re-renders on every step of the `n`/`p` walk — a list of N comments would
  // otherwise re-parse all N on each keypress, for a body that has not changed since it
  // was written. The same memo `Markdown` keeps over its own pipeline, for the same reason.
  const runs = useMemo(() => flattenMarkdown(text), [text]);

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
