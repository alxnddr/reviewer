import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The moved note is one line that must never wrap and must never overflow its lane, and in
// split view that lane is a single column — 549 px at a 1440 px window, against the 577 px
// the row wants for a path of this repository's own length. It shipped overflowing: the
// trailing `N lines` count was cut off at the column divider (measured in the browser
// preview at `?state=moved`, `scrollWidth` 577/591 against `clientWidth` 549).
//
// The repair is a chain of Tailwind classes across three elements, and every link is
// load-bearing — drop one and the row silently goes back to overflowing, in split only, for
// long paths only. There is no DOM test environment here to catch that, and no type or lint
// rule can see a className, so the chain is asserted against the source the way
// `DiffView.test.ts` and `dom-ids.test.ts` assert their own.
//
// What each link buys, reading outside in:
//
//   1. `max-w-full` on the flex line. It is an `inline-flex`, so its width is shrink-to-fit
//      — min-content is allowed to exceed the lane, and without the cap the row simply
//      draws past the divider.
//   2. `min-w-0 shrink` on the chip. `buttonVariants`' base is `shrink-0`, and a flex item's
//      automatic minimum is its content, so the cap above has nothing to take: the chip has
//      to be told twice that it is the item that gives.
//   3. `truncate` on a box holding *only* the path. `text-overflow` ellipsises the end of a
//      line, and the line spec (`:120-164`) trails the path — an ellipsis on the chip as a
//      whole would eat the coordinate, which is the half a reader standing in the diff
//      cannot reconstruct. So the chip lays its contents out as a flex row and the path is
//      the one part allowed to shorten.
//   4. `shrink-0` on everything after it — the line spec and the `N lines` count. They are
//      what the defect ate; they are also short. Nothing downstream of the path may shrink.

const source = readFileSync(join(__dirname, "MovedBlockNote.tsx"), "utf8");

/** The `className` of the element whose JSX opens the given tag, or the attribute that
 * immediately precedes the given marker. Each returns the class list, so the assertions
 * below read as the set of classes one element wears. */
function classesBefore(marker: string): string[] {
  const at = source.indexOf(marker);
  expect(at, `${marker} is in the source`).toBeGreaterThan(-1);
  const attr = source.slice(0, at).match(/className="(?<value>[^"]*)"(?![\s\S]*className=")/u);
  return (attr?.groups?.value ?? "").split(/\s+/u);
}

function classesOfSpanAround(expression: string): string[] {
  const span = source.match(
    new RegExp(`<span className="(?<value>[^"]*)">\\s*\\{${expression}\\}`, "u"),
  );
  expect(span, `a <span> wraps ${expression}`).not.toBeNull();
  return (span?.groups?.value ?? "").split(/\s+/u);
}

describe("MovedBlockNote overflow chain", () => {
  it("caps the flex line at the lane", () => {
    const line = source.match(/<span className="(?<value>inline-flex[^"]*)">/u);
    expect(line).not.toBeNull();
    expect((line?.groups?.value ?? "").split(/\s+/u)).toContain("max-w-full");
  });

  it("makes the chip the flex item that gives", () => {
    // The chip's className is the last one before its first child, the file glyph.
    const chip = classesBefore("<FileTypeIcon");
    expect(chip).toContain("min-w-0");
    expect(chip).toContain("shrink");
    // `shrink-0` is the base's; `inline-block` would take the chip out of flex layout and
    // leave `truncate` inside it with no box to act on.
    expect(chip).not.toContain("shrink-0");
    expect(chip).not.toContain("inline-block");
  });

  it("truncates the path and nothing else", () => {
    expect(classesOfSpanAround("other\\.file")).toContain("truncate");
  });

  it("holds the line spec and the count at natural width", () => {
    // The two the defect cut off. Neither may be the thing that shortens.
    expect(classesOfSpanAround("marker")).toContain("shrink-0");
    expect(classesOfSpanAround("slot\\.lines")).toContain("shrink-0");
    expect(classesOfSpanAround("marker")).not.toContain("truncate");
  });

  it("keeps the whole path in the chip's accessible name", () => {
    // The path is the one part that can be visually incomplete, so the label — which is
    // what a screen reader announces and what the ellipsis is standing in for — must not
    // be built from anything the layout shortens.
    expect(source).toContain("aria-label={`Go to ${other.file}${marker}`}");
  });
});
