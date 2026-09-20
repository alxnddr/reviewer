import type { Element } from "hast";
import type { MermaidConfig } from "mermaid";
import { errorMessage } from "../../../shared/errors";

// The decisions behind a ```mermaid fence, with no mermaid in them. `MermaidDiagram.tsx` is
// the effectful half — the lazy load of the library, the one `initialize`, the SVG insertion —
// and everything it *decides* is here so it can be tested under node, where there is no DOM
// for mermaid to measure text in and therefore no way to render a diagram at all.
//
// The only thing this module takes from the library is a type, and `verbatimModuleSyntax`
// erases an `import type` entirely — which matters, because `MermaidDiagram.test.ts` asserts
// that no module in `src/` reaches mermaid's *code* except through `import(`. The dependency
// is the largest thing in the renderer, and a review without a diagram must never pay for it.

/** A fenced block as its author wrote it: the info string's first word, and the text. */
export type Fence = { language: string | null; text: string };

const LANGUAGE_CLASS = "language-";

/** Reads a fence off the `pre` element remark-rehype built for it: one `code` child, whose
 * `className` carries `language-<info>` when the author gave the fence a language and is
 * absent when they did not. Anything not of that shape is not a fence this app produced, and
 * answers null rather than a guess.
 *
 * Read here, from the hast node, rather than from the `className` the `code` renderer is
 * handed: by the time `code` renders it is already *inside* the `<pre>` the block would have
 * been, and a diagram is not preformatted text — the decision has to be taken one element up,
 * where the whole block can still be swapped for something else. */
export function readFence(pre: Element | undefined): Fence | null {
  const code = pre?.children[0];
  if (pre?.children.length !== 1 || code?.type !== "element" || code.tagName !== "code") {
    return null;
  }
  const classes = code.properties["className"];
  const language =
    (Array.isArray(classes) ? classes : [])
      .map(String)
      .find((name) => name.startsWith(LANGUAGE_CLASS))
      ?.slice(LANGUAGE_CLASS.length) ?? null;
  const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  return { language, text };
}

/** The source of a mermaid fence, or null for every other block. Lower-cased because the
 * class is the author's info string verbatim and ```` ```Mermaid ```` is the same request. */
export function mermaidSource(pre: Element | undefined): string | null {
  const fence = readFence(pre);
  return fence?.language?.toLowerCase() === "mermaid" ? fence.text : null;
}

/** Far past anything a review's diagram legitimately is — a sequence across four processes is
 * a few hundred characters — and well under mermaid's own 50 000 default, because the text
 * is artifact data and the layout it drives runs on the renderer's main thread. */
export const MERMAID_MAX_TEXT_SIZE = 10_000;

/** What mermaid is initialized with, once per app. One exported constant so the hardening is
 * a value a test can pin (`mermaid.test.ts`) rather than an argument literal that a later
 * edit can thin out unnoticed.
 *
 * The threat: a diagram's text is **artifact data**, written by whatever agent authored the
 * review, and mermaid lets a diagram reconfigure its own renderer from inside that text —
 * `%%{init: {"securityLevel": "loose"}}%%` on the first line is a directive, and under
 * `loose` a node may carry a click handler and raw HTML labels. That is the
 * directive-override attack, and two keys close it together:
 *
 *   - `securityLevel: "strict"` is mermaid's default. It is written down anyway so that the
 *     safe value is a line someone has to delete rather than a default someone has to know.
 *   - `secure` is the list of keys a directive may **not** set. It is mermaid 12's whole
 *     default list restated: the four keys the feature was specified with, plus the two the
 *     library has added since (`suppressErrorRendering`, `maxEdges`). Mermaid 12 happens to
 *     *union* a caller's list into its default (probed: `initialize({ secure: ["x"] })`
 *     answers all six plus `x`), so four would have been enough today — but that merge is
 *     undocumented behaviour of one major version, and the list is spelled out in full so
 *     the hardening rests on what this file says rather than on it.
 *
 * `suppressErrorRendering` is what makes the failure path this app's and not the library's:
 * without it a diagram that does not parse is drawn as mermaid's own "Syntax error in text"
 * bomb, *and* the scratch element it was measured in is left behind in `document.body` (the
 * render throws before its cleanup). With it, the render just throws, and `MermaidDiagram`
 * shows the fence. It is in `secure` for that reason — a directive turning it back off would
 * be a diagram choosing to litter the page.
 *
 * No `theme` here on purpose: theming is driven from the resolved settings, and is not part
 * of the hardening this constant exists to pin. */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  secure: [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "suppressErrorRendering",
    "maxEdges",
  ],
  maxTextSize: MERMAID_MAX_TEXT_SIZE,
  suppressErrorRendering: true,
} satisfies MermaidConfig;

/** Whether a fence is worth loading mermaid for at all. */
export type DiagramPlan = { kind: "draw" } | { kind: "refuse"; reason: string };

/** Decided before the library is touched, for the two sources it would mishandle. An
 * over-long text does not throw inside mermaid — it is silently swapped for a diagram *of the
 * words* "Maximum text size in diagram exceeded", which is an error dressed as a result and
 * would be inserted as one. An empty fence is simply not a diagram. Both are the author's
 * typo, and should look like one. */
export function planDiagram(source: string): DiagramPlan {
  if (source.trim() === "") {
    return { kind: "refuse", reason: "The fence is empty." };
  }
  if (source.length > MERMAID_MAX_TEXT_SIZE) {
    return {
      kind: "refuse",
      reason: `The source is ${source.length} characters; a diagram may be at most ${MERMAID_MAX_TEXT_SIZE}.`,
    };
  }
  return { kind: "draw" };
}

/** What became of a fence: the markup to insert, or the one line that says why there is
 * none. There is deliberately no third arm — "drawn, but empty" is a failure. */
export type DiagramOutcome = { kind: "drawn"; svg: string } | { kind: "failed"; reason: string };

/** A render that resolved. An empty string is the one success that is not one: inserted, it
 * is exactly the empty box the fallback exists to prevent. */
export function renderedOutcome(svg: string): DiagramOutcome {
  return svg.trim() === ""
    ? { kind: "failed", reason: "The diagram rendered to nothing." }
    : { kind: "drawn", svg };
}

const ERROR_LINE_LIMIT = 160;

/** A render (or the chunk load) that threw, as one short line. Mermaid's parse errors are
 * a paragraph — the message, the offending line, a caret ruler under it, the expected token
 * set — and the source is already on screen right above, so only the first line is kept: it
 * is the one that carries the line number. */
export function failedOutcome(error: unknown): DiagramOutcome {
  const line =
    errorMessage(error)
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "")
      // "Parse error on line 3:" introduces the paragraph that was just dropped; with
      // nothing after it, the colon is a sentence that stops mid-breath.
      ?.replace(/:$/u, "") ?? "";
  if (line === "") {
    return { kind: "failed", reason: "The diagram could not be drawn." };
  }
  return {
    kind: "failed",
    reason: line.length > ERROR_LINE_LIMIT ? `${line.slice(0, ERROR_LINE_LIMIT - 1)}…` : line,
  };
}
