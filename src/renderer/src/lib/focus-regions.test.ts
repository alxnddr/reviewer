import { describe, expect, it } from "vitest";
import { activeRegionIndex, nextRegion } from "./focus-regions";

// The suite runs in node, and these two functions are the DOM-free half of the walk on
// purpose: everything that actually queries the document lives in `visibleRegions`, and
// what is worth testing — where focus counts as being, and what comes next — needs only
// identity and containment. So a region here is a stub with exactly those two.

type Stub = { children: Stub[] };

function region(...children: Stub[]): HTMLElement {
  const stub: Stub = { children };
  return {
    ...stub,
    contains: (node: Element | null) => children.some((member) => (member as unknown) === node),
  } as unknown as HTMLElement;
}

/** Something focusable inside a region — a tree row, a comment button. */
function child(): HTMLElement {
  return { children: [] } as unknown as HTMLElement;
}

describe("activeRegionIndex", () => {
  it("finds the region focus is resting on", () => {
    const regions = [region(), region(), region()];
    expect(activeRegionIndex(regions, regions[1] ?? null)).toBe(1);
  });

  it("finds the region focus is resting inside", () => {
    // The common case: focus is on a tree row or a comment button, not the region itself.
    const row = child();
    const regions = [region(), region(row as unknown as Stub)];
    expect(activeRegionIndex(regions, row)).toBe(1);
  });

  it("reports no region for focus outside all of them", () => {
    expect(activeRegionIndex([region(), region()], child())).toBe(-1);
    expect(activeRegionIndex([region()], null)).toBe(-1);
  });
});

describe("nextRegion", () => {
  it("steps forward and wraps past the last", () => {
    const regions = [region(), region(), region()];
    expect(nextRegion(regions, regions[0] ?? null, 1)).toBe(regions[1]);
    expect(nextRegion(regions, regions[2] ?? null, 1)).toBe(regions[0]);
  });

  it("steps backward and wraps past the first", () => {
    const regions = [region(), region(), region()];
    expect(nextRegion(regions, regions[2] ?? null, -1)).toBe(regions[1]);
    expect(nextRegion(regions, regions[0] ?? null, -1)).toBe(regions[2]);
  });

  it("starts at the near end when focus is outside every region", () => {
    // Pressed from the title bar or a dialog: forward means "the first pane", back means
    // "the last one", rather than nothing happening.
    const regions = [region(), region(), region()];
    expect(nextRegion(regions, null, 1)).toBe(regions[0]);
    expect(nextRegion(regions, null, -1)).toBe(regions[2]);
  });

  it("stays put with a single region, and is inert with none", () => {
    const only = region();
    expect(nextRegion([only], only, 1)).toBe(only);
    expect(nextRegion([], null, 1)).toBeNull();
  });
});
