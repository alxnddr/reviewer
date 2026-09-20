import type { Element } from "hast";
import type { MermaidConfig } from "mermaid";
import { errorMessage } from "../../../shared/errors";

// The decisions behind a ```mermaid fence, with no mermaid in them. `MermaidDiagram.tsx` is
// the effectful half — the lazy load of the library, the `initialize` per theme, the SVG
// insertion — and everything it *decides* is here so it can be tested under node, where there
// is no DOM for mermaid to measure text in and therefore no way to render a diagram at all.
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

/** The hardening mermaid is initialized with, every time it is. One exported constant so it is
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
 * No `theme` here on purpose: theming is driven from the resolved settings
 * (`themedMermaidConfig` below lays it over this), and is not part of the hardening this
 * constant exists to pin. */
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

// ── Theme ───────────────────────────────────────────────────────────────────────────────
// A diagram is drawn in the app's palette, not in one of mermaid's. The colours are the
// tokens `design/globals.css` defines per `html[data-theme]` block — the ones
// `lib/apply-settings.ts` puts in force — read back off the document by that module and
// handed here as data, so there is no second palette to keep in step with the first and a
// seventh theme themes its diagrams by existing.
//
// Mermaid's five built-in themes were the alternative (`default` on light, `dark` on dark) and
// were rejected for the reason the settings dialog has six themes rather than two: mermaid's
// `dark` is `#1f2020` nodes drawn for a `#333` page, which is nobody's Dracula and nobody's Nord.
//
// What mermaid 12 does with these, read from `themes/theme-base.js` and `config.ts` in its
// dist because the docs state none of it:
//
//   - Only `base` is modifiable, and it derives what it is not given through khroma —
//     `secondaryColor` is `primaryColor` turned 120° around the hue wheel, `lineColor` is
//     `invert(background)`. khroma parses hex, `rgb()` and `hsl()` and **throws** on
//     `oklch()`, which is what half this palette is written in. So the tokens arrive here
//     already resolved to `#rrggbb` (the browser's own colour parser does it, in
//     `readPalette`), and anything that is not exactly that is dropped rather than passed on:
//     a throw inside `initialize` would take every diagram in the app down to its fence.
//   - The hue rotation is why the neutrals are all set explicitly. On the grey Pierre themes
//     rotating a grey is a no-op, but Dracula's and Nord's surfaces carry a tint, and their
//     derived secondaries come out as a *differently* tinted grey that is in no palette.
//   - The base theme's note is `#fff5ad` with `#333` text whatever `darkMode` says — a
//     highlighter-yellow card in the middle of Nord — so the note is set too.
//   - `initialize` rebuilds the site config from mermaid's defaults on every call
//     (`setSiteConfig`), so re-initializing for a new theme leaves nothing of the old one
//     behind, and it copies its argument before writing derived variables into it.

/** The palette tokens a diagram is drawn in, by their `design/globals.css` names. */
export const DIAGRAM_TOKENS = [
  "background",
  "foreground",
  "secondary",
  "popover",
  "sidebar",
  "border",
  "border-strong",
  "text-muted",
] as const;

export type DiagramToken = (typeof DIAGRAM_TOKENS)[number];

/** What the document is wearing, as far as a diagram cares. Every colour is optional because
 * each is read through a parser that can decline it; see `plainColor`. */
export type DiagramPalette = {
  dark: boolean;
  colors: Partial<Record<DiagramToken, string>>;
  /** The prose's font stack, so a node label is set in the face of the sentence above it
   * rather than in mermaid's Trebuchet. Empty when there was none to read. */
  fontFamily: string;
};

/** Which token each mermaid variable takes. Nodes are the app's raised-surface grey with the
 * strong border, lines and arrowheads are the muted text colour (a diagram's edges are
 * secondary to its labels, as a rail's rules are to its rows), and an edge label sits on the
 * page background so it cuts the line it is written over instead of striking through it. */
const VARIABLE_TOKENS = {
  background: "background",
  primaryColor: "secondary",
  primaryTextColor: "foreground",
  primaryBorderColor: "border-strong",
  secondaryColor: "popover",
  secondaryTextColor: "foreground",
  secondaryBorderColor: "border",
  tertiaryColor: "sidebar",
  tertiaryTextColor: "foreground",
  tertiaryBorderColor: "border",
  textColor: "foreground",
  lineColor: "text-muted",
  arrowheadColor: "text-muted",
  edgeLabelBackground: "background",
  // The state diagram's name for the same thing; underived, it is the node fill, and every
  // transition label becomes a small grey plate.
  labelBackgroundColor: "background",
  noteBkgColor: "popover",
  noteTextColor: "foreground",
  noteBorderColor: "border-strong",
} as const satisfies Record<string, DiagramToken>;

const PLAIN_COLOR = /^#[\da-f]{6}$/iu;

/** A colour mermaid can be trusted with: `#rrggbb` and nothing else. That is the only form
 * `readPalette` produces, it is the form khroma cannot fail on, and it sits inside the
 * `[\d "#%(),.;A-Za-z]` pattern mermaid's own directive sanitizer holds a theme variable to —
 * which these never meet, arriving by `initialize`, but a value that would not survive the
 * library's own filter has no business going in by the door beside it. */
export function plainColor(value: string | undefined): string | null {
  return value !== undefined && PLAIN_COLOR.test(value) ? value.toLowerCase() : null;
}

/** mermaid's `themeVariables` for a palette. A token that did not resolve to a plain colour
 * costs the variables that wanted it — mermaid derives those, as it would have unthemed —
 * and never the diagram. */
export function diagramThemeVariables(palette: DiagramPalette): Record<string, string | boolean> {
  const variables: Record<string, string | boolean> = { darkMode: palette.dark };
  if (palette.dark) {
    // The base theme casts `drop-shadow(1px 2px 2px rgba(185,185,185,1))` under every node
    // whatever `darkMode` says. On a light page that is a shadow; on a dark one a light-grey
    // shadow is a glow, and the app's own dark themes elevate by fill, never by cast shadow
    // (`--elevation-surface` in `design/globals.css`). mermaid writes this one straight into
    // `filter:`, and spells its own absence `none`.
    variables["dropShadow"] = "none";
  }
  for (const [variable, token] of Object.entries(VARIABLE_TOKENS)) {
    const color = plainColor(palette.colors[token]);
    if (color !== null) {
      variables[variable] = color;
    }
  }
  if (palette.fontFamily.trim() !== "") {
    variables["fontFamily"] = palette.fontFamily;
  }
  return variables;
}

/** `MERMAID_CONFIG` with a palette laid over it — what `initialize` is actually given. The
 * hardening is spread in whole and the theme keys are the only additions, which
 * `mermaid.test.ts` pins: theming must not be the edit that thins the hardening out. */
export function themedMermaidConfig(palette: DiagramPalette): MermaidConfig {
  return { ...MERMAID_CONFIG, theme: "base", themeVariables: diagramThemeVariables(palette) };
}

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
