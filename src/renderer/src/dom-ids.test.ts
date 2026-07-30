import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNCOVERED_LAYER_ID } from "./lib/coverage";

// One rule about DOM id lookups, enforced here because nothing else in the toolchain can.
//
// The ids this app hangs off rows and sections are *data*: a layer id, a session uuid, a
// comment uuid. An id is not a selector — `document.querySelector("#" + id)` parses the id
// as CSS, so the `:` in `reviewer:uncovered` reads as a pseudo-class and the call throws
//
//   SyntaxError: '#layer-row-reviewer:uncovered' is not a valid selector.
//
// rather than returning null. These lookups live in mount effects (the layer rail scrolling
// its selected row into view, the overview returning to the chapter the reader came out of),
// so the throw takes the render with it: stepping onto the inferred "not covered by layers"
// layer would blank the app. `getElementById` takes the id verbatim and has no such failure
// mode, which is why every id lookup goes through it.
//
// The types cannot see this — both calls are `Element | null` — and lint pushes the wrong
// way (`unicorn/prefer-query-selector`, switched off in .oxlintrc.json for exactly this
// reason). There is no DOM test environment here to catch it at runtime either, so the
// invariant is asserted against the source.

const RENDERER_ROOT = __dirname;

/** Every `.ts`/`.tsx` under the renderer, so a lookup added in a new folder is still seen. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** `querySelector("#" + …)` / `` querySelector(`#${…}`) `` — an id spliced into a selector. */
const ID_AS_SELECTOR = /querySelector(?:All)?(?:<[^>]*>)?\(\s*(?:`#\$\{|"#"\s*\+|'#'\s*\+)/u;

describe("id lookups", () => {
  it("the uncovered layer's id is not selector-safe, so it stands for the whole class", () => {
    // Not a rule about this constant so much as proof the class is inhabited: ids reach the
    // DOM unescaped, and at least one of them carries a character CSS reads as syntax.
    expect(UNCOVERED_LAYER_ID).toMatch(/[^\w-]/u);
  });

  it("no renderer source splices an id into a querySelector", () => {
    const offenders = sourceFiles(RENDERER_ROOT).filter((path) =>
      ID_AS_SELECTOR.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
