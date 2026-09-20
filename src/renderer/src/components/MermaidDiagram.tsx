import { useEffect, useState, type ReactElement } from "react";
import type { Mermaid } from "mermaid";
import {
  MERMAID_CONFIG,
  failedOutcome,
  planDiagram,
  renderedOutcome,
  type DiagramOutcome,
} from "@/lib/mermaid";

// A ```mermaid fence, drawn. `Markdown` hands over the fence's text and the fence itself —
// the very `<pre>` it would otherwise have rendered — and this shows the diagram once there
// is one, and the fence at every other moment: while the library loads, and for good when
// the text does not parse. So an author's typo looks like a typo (the source, plus one line
// saying what mermaid objected to), a slow chunk looks like a code block for a beat instead
// of a hole the prose jumps around, and no path through here ends in an empty box.
//
// ── The raw-markup site ─────────────────────────────────────────────────────────────────
// The `dangerouslySetInnerHTML` below is the only place in the renderer where markup derived
// from **artifact-authored text** is inserted as markup. (`FileTypeIcon.tsx` sets
// `innerHTML` too, but to a build-time constant out of `@pierre/trees`; nothing a review says
// can reach it.) Everything else an artifact carries goes through react-markdown as React
// elements, and `Markdown.tsx` deliberately has no `rehype-raw` — this component must not
// become that escape hatch by another door, which is why it accepts a mermaid *source* and
// never markup, and why `MermaidDiagram.test.ts` asserts the attribute appears in this file
// and no other.
//
// What an attacker controls is the diagram text, in a `.reviewer.json` written by whatever
// agent produced the review. What makes inserting the result safe:
//
//   1. The string inserted is never the author's. It is the SVG mermaid serialized from its
//      own layout, and under `securityLevel: "strict"` mermaid passes that serialization
//      through DOMPurify before returning it (`mermaidAPI.render`: the `sanitize` call is
//      skipped only for `loose` and `sandbox`). Strict also encodes HTML in labels and
//      disables click bindings.
//   2. The diagram cannot argue its way out of strict. A first line of
//      `%%{init: {"securityLevel": "loose"}}%%` is a *directive* — mermaid lets a diagram
//      reconfigure its renderer from inside its own text — and that is the override attack:
//      without a guard, (1) is a default the attacker's text is free to change.
//      `MERMAID_CONFIG.secure` (`lib/mermaid.ts`) names the keys a directive may not set, and
//      `securityLevel` is among them. `themeVariables` is *not* securable and has been used
//      to inject CSS; mermaid's directive sanitizer holds each value to
//      `[\d "#%(),.;A-Za-z]` and brace-balances `themeCSS`, and what CSS does get through is
//      scoped under the diagram's own id.
//   3. `bindFunctions` — the second half of mermaid's render result, which wires click
//      handlers onto the inserted nodes — is never called. Strict already leaves it with
//      nothing to bind; not calling it means a regression there has nowhere to land.
//   4. Underneath all of it, the window's CSP (`src/renderer/index.html`) is
//      `script-src 'self'`: an inline handler or a `javascript:` URL that survived 1–3 would
//      still not execute. `style-src 'unsafe-inline'` is what lets the SVG's own `<style>`
//      block apply, so styling is the residual surface, not script.
//
// If you upgrade mermaid across a major version, re-read `mermaidAPI.render`'s sanitize
// branch and the default `secure` list before trusting (1) and (2) again.
//
// ── Loading ─────────────────────────────────────────────────────────────────────────────
// `import("mermaid")` and nothing else: the library is the largest dependency in the
// renderer, and a review with no diagram in it must never fetch the chunk. There is no DOM in
// the test environment to watch a network request in, so the rule is asserted against the
// source instead (`MermaidDiagram.test.ts`): this is the only `import(` of it in `src/`, and
// every other mention is an `import type`, which `verbatimModuleSyntax` erases.

/** The library, loaded and initialized — once per app, not per diagram: `initialize` resets
 * mermaid's site config, and ten diagrams in an overview would otherwise be ten resets racing
 * ten renders. A failed load clears the slot so a later diagram tries again (the chunk is a
 * local file; a failure is a transient read, not a verdict). */
let loading: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(
    ({ default: mermaid }) => {
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Mermaid wants a DOM id per render and uses it in a `#id` selector of its own — so it is a
 * counter and not React's `useId`, whose `:r1:` is a `SyntaxError` there. The same trap
 * `dom-ids.test.ts` exists for, met from the other side. */
let renders = 0;

/** Never rejects: every way this can go wrong — the chunk, the parse, the layout — comes
 * back as the `failed` arm, because the caller is a mount effect and a rejection there is
 * an unhandled one. Concurrent calls are safe; mermaid queues its renders internally. */
async function drawDiagram(source: string): Promise<DiagramOutcome> {
  try {
    const mermaid = await loadMermaid();
    renders += 1;
    const { svg } = await mermaid.render(`mermaid-diagram-${renders}`, source);
    return renderedOutcome(svg);
  } catch (error) {
    return failedOutcome(error);
  }
}

type MermaidDiagramProps = {
  /** The fence's text. Source, never markup — see the header. */
  source: string;
  /** The fence as `Markdown` would have rendered it, shown whenever there is no diagram. Taken
   * as an element rather than rebuilt here so the fallback *is* the app's code block and
   * cannot drift into a second rendering of one. */
  fence: ReactElement;
};

export function MermaidDiagram({ source, fence }: MermaidDiagramProps): ReactElement {
  // Held with the source it was drawn from, so a result that arrives for text the prose no
  // longer contains is simply not this diagram's — no reset effect, no flash of the old one.
  const [drawn, setDrawn] = useState<{ source: string; outcome: DiagramOutcome } | null>(null);
  const plan = planDiagram(source);
  const refused = plan.kind === "refuse";

  useEffect(() => {
    // A refused source never reaches the library — not even to load it.
    let live = !refused;
    if (live) {
      void drawDiagram(source).then((outcome) => {
        if (live) {
          setDrawn({ source, outcome });
        }
      });
    }
    return () => {
      live = false;
    };
  }, [source, refused]);

  const outcome: DiagramOutcome | null =
    plan.kind === "refuse"
      ? { kind: "failed", reason: plan.reason }
      : drawn?.source === source
        ? drawn.outcome
        : null;

  if (outcome === null) {
    return fence;
  }
  if (outcome.kind === "failed") {
    return (
      <div className="space-y-1">
        {fence}
        <p className="text-sm break-words text-text-muted">
          <span className="text-warning">Diagram not drawn.</span> {outcome.reason}
        </p>
      </div>
    );
  }
  return (
    // Scrolls sideways like the fence it replaces: a wide sequence diagram must not widen
    // the reading column. The SVG sizes itself (`width: 100%` up to its own `max-width`).
    <div
      className="overflow-x-auto"
      // The one sanctioned raw-markup insertion in the renderer — the header says why.
      dangerouslySetInnerHTML={{ __html: outcome.svg }}
    />
  );
}
