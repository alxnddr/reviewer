import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Three invariants about how mermaid is reached and where its output goes. None has a type
// or a lint rule behind it, and there is no DOM here to watch a chunk request or a rendered
// card in — so they are asserted against the source, the way `DiffView.test.ts` and
// `dom-ids.test.ts` assert theirs.
//
//   1. Mermaid's code is reached through `import("mermaid")` and nothing else. It is the
//      largest dependency in the renderer; one static `import mermaid from "mermaid"`
//      anywhere under `src/` moves it into the entry chunk and every review pays for it,
//      diagram or not. `import type` is fine — `verbatimModuleSyntax` erases it — and is the
//      only other spelling allowed.
//   2. `dangerouslySetInnerHTML` appears in `MermaidDiagram.tsx` and no other file. That
//      file's header is the argument for why its one insertion is safe; a second site would
//      be markup nobody argued for.
//   3. The comment surfaces do not ask for diagrams. `Markdown`'s `diagrams` is opt-in, so
//      this holds by default — the assertion is for the day someone adds the prop to a card.
//
// All of `src/` is walked rather than the renderer alone: `src/shared/` and `src/tools/` are
// bundled into the window too, and a directory added later is covered without anyone having
// to remember this file.

const SRC = join(__dirname, "..", "..", "..");
const LOADER = "renderer/src/components/MermaidDiagram.tsx";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** Every module under `src/`, tests excluded — this file has to spell the forbidden forms
 * out in order to look for them. Keyed by its `/`-separated path from `src/`. */
const sources = new Map<string, string>(
  walk(SRC)
    .filter((path) => !/\.test\.tsx?$/u.test(path))
    .map((path): [string, string] => [
      relative(SRC, path).split(sep).join("/"),
      readFileSync(path, "utf8"),
    ]),
);

function filesMatching(pattern: RegExp): string[] {
  return [...sources].filter(([, source]) => pattern.test(source)).map(([name]) => name);
}

/** `from "mermaid"` / `from "mermaid/…"`, with the `import …` that owns it — across lines,
 * since a named import list wraps. */
const STATIC_IMPORT = /\bimport\s+(?<clause>[^;]*?)\s+from\s+["']mermaid(?:\/[^"']*)?["']/gu;
const SIDE_EFFECT_IMPORT = /\bimport\s+["']mermaid(?:\/[^"']*)?["']/u;
const REQUIRE = /\brequire\(\s*["']mermaid(?:\/[^"']*)?["']\s*\)/u;
const DYNAMIC_IMPORT = /\bimport\(\s*["']mermaid["']\s*\)/u;

describe("mermaid is only ever loaded lazily", () => {
  it("has exactly one dynamic import, in the diagram component", () => {
    expect(filesMatching(DYNAMIC_IMPORT)).toEqual([LOADER]);
  });

  it("has no static import of mermaid's code anywhere in src/", () => {
    const offenders = [...sources].flatMap(([name, source]) =>
      [...source.matchAll(STATIC_IMPORT)]
        .filter((match) => !(match.groups?.["clause"] ?? "").startsWith("type "))
        .map(() => name),
    );
    expect(offenders).toEqual([]);
    expect(filesMatching(SIDE_EFFECT_IMPORT)).toEqual([]);
    expect(filesMatching(REQUIRE)).toEqual([]);
  });

  it("would catch one — the pattern is not vacuous", () => {
    const planted = 'import mermaid from "mermaid";\nimport {\n  render,\n} from "mermaid";';
    expect([...planted.matchAll(STATIC_IMPORT)]).toHaveLength(2);
    const erased = 'import type { MermaidConfig } from "mermaid";';
    expect(
      [...erased.matchAll(STATIC_IMPORT)].filter(
        (match) => !(match.groups?.["clause"] ?? "").startsWith("type "),
      ),
    ).toEqual([]);
  });
});

describe("raw markup", () => {
  it("is inserted by the diagram component and by nothing else", () => {
    expect(filesMatching(/dangerouslySetInnerHTML=/u)).toEqual([LOADER]);
  });

  it("never takes or calls mermaid's `bindFunctions`", () => {
    // `bindFunctions` is how mermaid wires click handlers onto inserted nodes; the header
    // says why it is never called. Mentioned in prose there, never destructured or invoked.
    expect(sources.get(LOADER) ?? "").not.toMatch(/bindFunctions\s*[?(,}]/u);
  });
});

describe("comment surfaces keep a mermaid fence a fence", () => {
  const COMMENT_SURFACES = [
    "renderer/src/components/CommentBody.tsx",
    "renderer/src/components/CommentEvidence.tsx",
  ];

  it("reads the files it asserts over, and they do mount Markdown", () => {
    // The guard below is a `not.toMatch`, so it passes on a file that was renamed away.
    for (const name of COMMENT_SURFACES) {
      expect(sources.get(name) ?? "").toContain("<Markdown");
    }
  });

  it("does not pass `diagrams` from either", () => {
    for (const name of COMMENT_SURFACES) {
      expect(sources.get(name) ?? "").not.toMatch(/\bdiagrams\b/u);
    }
  });

  it("is opt-in at the source: Markdown defaults `diagrams` to false", () => {
    expect(sources.get("renderer/src/components/Markdown.tsx") ?? "").toContain(
      "diagrams = false,",
    );
  });
});
