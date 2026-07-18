import { describe, expect, it } from "vitest";
import type { CommitSelection, DiffSelection, LogEntry } from "../../../shared/git";
import {
  brushBounds,
  brushContains,
  brushFromSelection,
  brushReducer,
  brushSummary,
  logEntryKey,
  selectionFromBrush,
  type BrushAction,
  type BrushRange,
} from "./selection";

function sha(fill: string): string {
  return fill.repeat(40).slice(0, 40);
}

function commitEntry(fill: string): LogEntry {
  return {
    kind: "commit",
    commit: {
      sha: sha(fill),
      shortSha: sha(fill).slice(0, 7),
      author: "t",
      authoredAt: "2026-07-04T00:00:00+00:00",
      subject: `commit ${fill}`,
    },
  };
}

const CLEAN_LOG: LogEntry[] = [commitEntry("a"), commitEntry("b"), commitEntry("c")];
const DIRTY_LOG: LogEntry[] = [{ kind: "uncommitted" }, ...CLEAN_LOG];

function isContiguousAndBounded(range: BrushRange | null, entryCount: number): boolean {
  if (range === null) {
    return true;
  }
  const { top, bottom } = brushBounds(range);
  return top >= 0 && bottom < entryCount && top <= bottom;
}

describe("brushReducer", () => {
  it("click selects a single row", () => {
    expect(brushReducer(null, { type: "set", index: 2 }, 4)).toEqual({ anchor: 2, focus: 2 });
  });

  it("extend keeps the anchor and moves the focus (shift-click, drag)", () => {
    const start = brushReducer(null, { type: "set", index: 1 }, 4);
    expect(brushReducer(start, { type: "extend", index: 3 }, 4)).toEqual({ anchor: 1, focus: 3 });
  });

  it("extend upward crosses the anchor and stays contiguous", () => {
    const range = brushReducer({ anchor: 2, focus: 3 }, { type: "extend", index: 0 }, 4);
    expect(range).toEqual({ anchor: 2, focus: 0 });
    expect(brushBounds(range as BrushRange)).toEqual({ top: 0, bottom: 2 });
  });

  it("extend without a prior range behaves like a click", () => {
    expect(brushReducer(null, { type: "extend", index: 2 }, 4)).toEqual({ anchor: 2, focus: 2 });
  });

  it("step moves a collapsed selection by one", () => {
    expect(
      brushReducer({ anchor: 1, focus: 1 }, { type: "step", direction: 1, extend: false }, 4),
    ).toEqual({ anchor: 2, focus: 2 });
  });

  it("step with extend grows the range from the anchor", () => {
    expect(
      brushReducer({ anchor: 1, focus: 1 }, { type: "step", direction: 1, extend: true }, 4),
    ).toEqual({ anchor: 1, focus: 2 });
  });

  it("step without a range starts at the top", () => {
    expect(brushReducer(null, { type: "step", direction: 1, extend: false }, 4)).toEqual({
      anchor: 0,
      focus: 0,
    });
  });

  it("clamps at both list ends", () => {
    expect(
      brushReducer({ anchor: 0, focus: 0 }, { type: "step", direction: -1, extend: false }, 4),
    ).toEqual({ anchor: 0, focus: 0 });
    expect(brushReducer({ anchor: 3, focus: 3 }, { type: "extend", index: 99 }, 4)).toEqual({
      anchor: 3,
      focus: 3,
    });
    expect(brushReducer(null, { type: "set", index: -5 }, 4)).toEqual({ anchor: 0, focus: 0 });
  });

  it("collapses to null when there is nothing to select", () => {
    expect(brushReducer({ anchor: 0, focus: 1 }, { type: "set", index: 0 }, 0)).toBeNull();
  });

  it("never produces an out-of-bounds or non-contiguous range across action sequences", () => {
    const actions: BrushAction[] = [
      { type: "set", index: 7 },
      { type: "extend", index: -3 },
      { type: "step", direction: 1, extend: true },
      { type: "step", direction: -1, extend: true },
      { type: "extend", index: 99 },
      { type: "step", direction: -1, extend: false },
      { type: "set", index: 0 },
      { type: "step", direction: 1, extend: true },
    ];
    for (const entryCount of [1, 2, 5]) {
      let range: BrushRange | null = null;
      for (const action of actions) {
        range = brushReducer(range, action, entryCount);
        expect(isContiguousAndBounded(range, entryCount)).toBe(true);
        expect(range).not.toBeNull();
      }
    }
  });
});

describe("brushContains", () => {
  it("covers exactly the rows between anchor and focus, either direction", () => {
    for (const range of [
      { anchor: 1, focus: 3 },
      { anchor: 3, focus: 1 },
    ]) {
      expect([0, 1, 2, 3, 4].filter((index) => brushContains(range, index))).toEqual([1, 2, 3]);
    }
  });
});

// Exhaustive over the DiffSelection union: every kind is producible by a brush
// (branches comes from the picker, asserted for the record).
describe("selectionFromBrush", () => {
  it("maps a single commit to a first == last range", () => {
    expect(selectionFromBrush(CLEAN_LOG, { anchor: 1, focus: 1 })).toEqual({
      kind: "commitRange",
      first: sha("b"),
      last: sha("b"),
    } satisfies DiffSelection);
  });

  it("maps a commit span to first = oldest, last = newest regardless of brush direction", () => {
    const expected: DiffSelection = { kind: "commitRange", first: sha("c"), last: sha("a") };
    expect(selectionFromBrush(CLEAN_LOG, { anchor: 0, focus: 2 })).toEqual(expected);
    expect(selectionFromBrush(CLEAN_LOG, { anchor: 2, focus: 0 })).toEqual(expected);
  });

  it("maps the uncommitted row alone to the uncommitted selection", () => {
    expect(selectionFromBrush(DIRTY_LOG, { anchor: 0, focus: 0 })).toEqual({
      kind: "uncommitted",
    } satisfies DiffSelection);
  });

  it("maps a span including the uncommitted row to commitRangeWithUncommitted", () => {
    expect(selectionFromBrush(DIRTY_LOG, { anchor: 2, focus: 0 })).toEqual({
      kind: "commitRangeWithUncommitted",
      first: sha("b"),
    } satisfies DiffSelection);
  });

  it("rejects a stale brush that no longer fits the list", () => {
    expect(selectionFromBrush(CLEAN_LOG, { anchor: 0, focus: 5 })).toBeNull();
    expect(selectionFromBrush([], { anchor: 0, focus: 0 })).toBeNull();
  });
});

// The restore direction: a persisted SHA-anchored selection must find its rows in
// a fresh log or degrade to null — never a wrong-range brush.
describe("brushFromSelection", () => {
  it("re-locates a commit span and round-trips through selectionFromBrush", () => {
    const selection: CommitSelection = { kind: "commitRange", first: sha("c"), last: sha("a") };
    const range = brushFromSelection(CLEAN_LOG, selection);
    expect(range).toEqual({ anchor: 0, focus: 2 });
    expect(range === null ? null : selectionFromBrush(CLEAN_LOG, range)).toEqual(selection);
  });

  it("re-locates a single commit to a collapsed range", () => {
    expect(
      brushFromSelection(CLEAN_LOG, { kind: "commitRange", first: sha("b"), last: sha("b") }),
    ).toEqual({ anchor: 1, focus: 1 });
  });

  it("re-locates the uncommitted selection only while the tree is still dirty", () => {
    expect(brushFromSelection(DIRTY_LOG, { kind: "uncommitted" })).toEqual({
      anchor: 0,
      focus: 0,
    });
    expect(brushFromSelection(CLEAN_LOG, { kind: "uncommitted" })).toBeNull();
  });

  it("commitRangeWithUncommitted needs both the pseudo-entry and its oldest SHA", () => {
    const selection: CommitSelection = {
      kind: "commitRangeWithUncommitted",
      first: sha("b"),
    };
    expect(brushFromSelection(DIRTY_LOG, selection)).toEqual({ anchor: 0, focus: 2 });
    expect(brushFromSelection(CLEAN_LOG, selection)).toBeNull();
    expect(
      brushFromSelection(DIRTY_LOG, { kind: "commitRangeWithUncommitted", first: sha("f") }),
    ).toBeNull();
  });

  it("degrades to null when a SHA is missing from the log, never a clamped range", () => {
    expect(
      brushFromSelection(CLEAN_LOG, { kind: "commitRange", first: sha("f"), last: sha("a") }),
    ).toBeNull();
    expect(
      brushFromSelection(CLEAN_LOG, { kind: "commitRange", first: sha("c"), last: sha("f") }),
    ).toBeNull();
    expect(
      brushFromSelection([], { kind: "commitRange", first: sha("a"), last: sha("a") }),
    ).toBeNull();
  });

  it("degrades to null when rewritten history inverted the commit order", () => {
    expect(
      brushFromSelection(CLEAN_LOG, { kind: "commitRange", first: sha("a"), last: sha("c") }),
    ).toBeNull();
  });
});

describe("brushSummary", () => {
  it("names commits and the uncommitted entry", () => {
    expect(brushSummary(DIRTY_LOG, { anchor: 0, focus: 3 })).toBe("3 commits + uncommitted");
    expect(brushSummary(DIRTY_LOG, { anchor: 0, focus: 0 })).toBe("uncommitted changes");
    expect(brushSummary(CLEAN_LOG, { anchor: 2, focus: 2 })).toBe("1 commit");
    expect(brushSummary(CLEAN_LOG, { anchor: 0, focus: 1 })).toBe("2 commits");
  });
});

describe("logEntryKey", () => {
  it("keys commits by sha and the working tree by a sentinel", () => {
    expect(logEntryKey(CLEAN_LOG[0] as LogEntry)).toBe(sha("a"));
    expect(logEntryKey({ kind: "uncommitted" })).toBe("uncommitted");
  });
});
