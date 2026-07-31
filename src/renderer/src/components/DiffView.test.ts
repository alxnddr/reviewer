import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Two invariants about how DiffView hands its slots to Pierre. Both are performance
// contracts with no type or lint rule behind them, and no DOM test environment here to
// catch them at runtime, so they are asserted against the source the way `dom-ids.test.ts`
// asserts its own.
//
//   1. Pierre memoizes the portal host that owns every slot on the surface (`SlotPortals`,
//      @pierre/diffs/dist/react/CodeView.js) on a shallow compare of the render props.
//      An inline arrow is a new function on every DiffView render, so the compare fails
//      every time and each visible file's header buttons, gutter `+` and comment cards are
//      rebuilt — Base UI tooltip trees included. Every render prop therefore has to be
//      passed by name: a module constant or a `useCallback`.
//
//   2. `onSelectedLinesChange` fires per line delta of a gutter drag
//      (InteractionManager's `notifySelectionChangeDelta`), so mirroring it into React
//      state is a render per line dragged over — and, through (1), a full portal rebuild
//      per line. Nothing needs the mirror: the anchor and the `+`'s label are both read
//      from `handleRef.current.getSelectedLines()` at the moment they are used.
//
// (1) is about the view, which is where the render props are written. (2) is about the
// slots themselves, which live in `components/diff/` — asserting it over `DiffView.tsx`
// alone would pass on a file that no longer contains a line of selection code. The
// directory is read rather than listed so a slot module added later is covered without
// anyone having to remember this file.

const VIEW = "DiffView.tsx";
const SLOT_DIR = "diff";

const sources = new Map<string, string>([
  [VIEW, readFileSync(join(__dirname, VIEW), "utf8")],
  ...readdirSync(join(__dirname, SLOT_DIR))
    .filter((name) => name.endsWith(".tsx"))
    .map((name): [string, string] => [
      `${SLOT_DIR}/${name}`,
      readFileSync(join(__dirname, SLOT_DIR, name), "utf8"),
    ]),
]);

/** A `renderSomething={…}` JSX attribute whose value closes on the same line — which a bare
 * identifier does and an inline arrow, opening a body that runs over the lines below, does
 * not. So an inline arrow does not match at all, and the count below is what catches it. */
const RENDER_PROP = /\brender[A-Z]\w*=\{(?<value>[^}\n]*)\}/gu;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** header prefix, filename suffix, header metadata, annotation, gutter utility. */
const SLOT_COUNT = 5;

describe("DiffView render props", () => {
  it("passes every CodeView slot renderer by name, never as an inline arrow", () => {
    const view = sources.get(VIEW) ?? "";
    const props = [...view.matchAll(RENDER_PROP)].map((match) => match.groups?.value ?? "");
    expect(props).toHaveLength(SLOT_COUNT);
    // And nothing built on the spot inside the braces either (`{cond ? a : b}`).
    expect(props.filter((value) => !IDENTIFIER.test(value))).toEqual([]);
  });

  it("does not mirror Pierre's line selection into React state", () => {
    const mirrors = [...sources]
      .filter(([, source]) => source.includes("onSelectedLinesChange"))
      .map(([name]) => name);
    expect(mirrors).toEqual([]);
  });

  it("reads the slot sources it asserts over", () => {
    // The guard above is a `not.toContain`, so it passes on an empty read. The gutter `+`
    // is the file it exists for: if that module stops being scanned, this fails first.
    expect([...sources.keys()]).toContain("diff/DiffGutterAdd.tsx");
  });
});
