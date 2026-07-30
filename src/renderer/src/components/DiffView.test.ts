import { readFileSync } from "node:fs";
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

const SOURCE = readFileSync(join(__dirname, "DiffView.tsx"), "utf8");

/** A `renderSomething={…}` JSX attribute whose value closes on the same line — which a bare
 * identifier does and an inline arrow, opening a body that runs over the lines below, does
 * not. So an inline arrow does not match at all, and the count below is what catches it. */
const RENDER_PROP = /\brender[A-Z]\w*=\{(?<value>[^}\n]*)\}/gu;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** header prefix, filename suffix, header metadata, annotation, gutter utility. */
const SLOT_COUNT = 5;

describe("DiffView render props", () => {
  it("passes every CodeView slot renderer by name, never as an inline arrow", () => {
    const props = [...SOURCE.matchAll(RENDER_PROP)].map((match) => match.groups?.value ?? "");
    expect(props).toHaveLength(SLOT_COUNT);
    // And nothing built on the spot inside the braces either (`{cond ? a : b}`).
    expect(props.filter((value) => !IDENTIFIER.test(value))).toEqual([]);
  });

  it("does not mirror Pierre's line selection into React state", () => {
    expect(SOURCE).not.toContain("onSelectedLinesChange");
  });
});
