import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { CommentSlot } from "../../../../shared/diff/comment-annotations";
import type { Comment } from "../../../../shared/review";
import type { CommentNavEntry } from "./comment-navigation";
import { useDiffScroll, type DiffScroll, type DiffScrollOptions } from "./use-diff-scroll";

// What is worth testing about this hook is the one thing a pure function cannot hold: which
// of five effects wins a commit that two of them want. That ranking is made of React itself
// — declaration order, mount-seeded refs, and one request the hook consumes — so the test
// drives the real hook rather than a re-derivation of its rules. The consumed request is
// here because a ref-compare cannot see the commit that mounts it, which is the commit a
// click in the tour doc makes; `commit()` below models the store clearing it by passing
// `pendingCommentScroll: null` on the next commit, exactly as `commentScrolled` does.
//
// The renderer's suites run in a plain node environment (no DOM, so no `react-dom/client`
// and no render harness to borrow), but a hook is only a sequence of dispatcher calls: give
// it a dispatcher and a commit loop and it runs anywhere. That is all `react` is replaced
// with below — hook state indexed by call position, deps compared with `Object.is`, and a
// commit that flushes layout effects before passive ones, in the order they were declared,
// the way React's own commit phase does. Nothing here models rendering, because the hook
// renders nothing.

// oxlint-disable react-hooks/rules-of-hooks -- the hook is driven through the dispatcher below, not from a component

const react = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  type Cell = { deps: Deps; value: unknown; cleanup: (() => void) | null };
  type Pending = { cell: Cell; create: () => (() => void) | void };

  const cells: Cell[] = [];
  const layout: Pending[] = [];
  const passive: Pending[] = [];
  let cursor = 0;

  /** The state for the hook call at this position, and whether its deps moved. */
  function slot(deps: Deps): { cell: Cell; stale: boolean } {
    const index = cursor;
    cursor += 1;
    const previous = cells[index];
    if (previous === undefined) {
      const cell: Cell = { deps, value: undefined, cleanup: null };
      cells[index] = cell;
      return { cell, stale: true };
    }
    const before = previous.deps;
    const stale =
      deps === undefined ||
      before === undefined ||
      deps.length !== before.length ||
      deps.some((dep, at) => !Object.is(dep, before[at]));
    previous.deps = deps;
    return { cell: previous, stale };
  }

  function flush(queue: Pending[]): void {
    for (const { cell, create } of queue.splice(0)) {
      cell.cleanup?.();
      const cleanup = create();
      cell.cleanup = typeof cleanup === "function" ? cleanup : null;
    }
  }

  return {
    useRef<T>(initial: T): { current: T } {
      const { cell, stale } = slot([]);
      if (stale) {
        cell.value = { current: initial };
      }
      return cell.value as { current: T };
    },
    useMemo<T>(factory: () => T, deps: Deps): T {
      const { cell, stale } = slot(deps);
      if (stale) {
        cell.value = factory();
      }
      return cell.value as T;
    },
    useCallback<T>(callback: T, deps: Deps): T {
      const { cell, stale } = slot(deps);
      if (stale) {
        cell.value = callback;
      }
      return cell.value as T;
    },
    useEffect(create: () => (() => void) | void, deps: Deps): void {
      const { cell, stale } = slot(deps);
      if (stale) {
        passive.push({ cell, create });
      }
    },
    useLayoutEffect(create: () => (() => void) | void, deps: Deps): void {
      const { cell, stale } = slot(deps);
      if (stale) {
        layout.push({ cell, create });
      }
    },
    /** One commit: the render, then the layout effects, then the passive ones. */
    commit(render: () => void): void {
      cursor = 0;
      render();
      flush(layout);
      flush(passive);
    },
    /** Runs every live cleanup — the tab switch this hook flushes its capture on. */
    unmount(): void {
      for (const cell of cells) {
        cell.cleanup?.();
      }
      cells.length = 0;
      layout.length = 0;
      passive.length = 0;
      cursor = 0;
    },
  };
});
vi.mock("react", () => react);

const INSTANT = { behavior: "instant" } as const;

let targets: CodeViewScrollTarget[] = [];
let onScrollTop = vi.fn<(scrollTop: number) => void>();
let onCommentScrolled = vi.fn<(commentId: string) => void>();
let handleRef: { current: CodeViewHandle<CommentSlot> | null };

beforeEach(() => {
  react.unmount();
  targets = [];
  onScrollTop = vi.fn<(scrollTop: number) => void>();
  onCommentScrolled = vi.fn<(commentId: string) => void>();
  handleRef = {
    // Only the scroll half of the handle is reachable from this hook; the rest of
    // CodeView's imperative API belongs to the search and gutter paths.
    current: {
      scrollTo: (target: CodeViewScrollTarget): void => {
        targets.push(target);
      },
    } as CodeViewHandle<CommentSlot>,
  };
});

function comment(id: string, file: string, line: number): Comment {
  return { id, file, side: "additions", startLine: line, endLine: line, body: "look here" };
}

function placed(id: string, path: string, line: number): CommentNavEntry {
  return { comment: comment(id, path, line), path, status: "placed", line };
}

function outdated(id: string, path: string): CommentNavEntry {
  return { comment: comment(id, path, 1), path, status: "outdated", line: null };
}

const FIRST = placed("c1", "a.ts", 12);
const SECOND = placed("c2", "b.ts", 40);
const ENTRIES: CommentNavEntry[] = [FIRST, SECOND];

function commit(overrides: Partial<DiffScrollOptions> = {}): DiffScroll {
  let value: DiffScroll | undefined;
  react.commit(() => {
    value = useDiffScroll(handleRef, {
      restoreScrollTop: 0,
      selectedFilePath: null,
      pendingCommentScroll: null,
      activeLayerId: null,
      entries: ENTRIES,
      onScrollTop,
      onCommentScrolled,
      ...overrides,
    });
  });
  if (value === undefined) {
    throw new Error("the hook did not run");
  }
  return value;
}

describe("useDiffScroll", () => {
  it("restores the persisted position on mount, and nothing else scrolls", () => {
    // A focused file is live on this activation too; the recorded position outranks it,
    // and its guard is seeded with it.
    commit({ restoreScrollTop: 320, selectedFilePath: "b.ts" });

    expect(targets).toEqual([{ type: "position", position: 320, ...INSTANT }]);
  });

  it("serves a comment focused before this surface existed — the tour doc's click", () => {
    // The regression this hook's request half exists for: the tour doc replaces the diff
    // pane, so opening a finding from it focuses the comment in the very commit that
    // mounts the surface. Nothing changed *while* mounted, so the compare-based guards
    // see nothing — and the reader used to land on the recorded position with the card
    // nowhere on screen. The outstanding request outranks that restore and is consumed.
    commit({ restoreScrollTop: 320, selectedFilePath: "b.ts", pendingCommentScroll: "c2" });

    expect(targets).toEqual([
      { type: "line", id: "b.ts", lineNumber: 40, side: "additions", align: "center", ...INSTANT },
    ]);
    expect(onCommentScrolled.mock.calls).toEqual([["c2"]]);
  });

  it("keeps the reader's place on a remount with nothing outstanding — the tab bounce", () => {
    commit({ selectedFilePath: "b.ts", pendingCommentScroll: "c2" });
    react.unmount();
    targets = [];
    // Back from another tab: the focus is still on c2 (the ring and the counter still
    // read it), but its scroll was served before the switch, so the surface restores
    // where the reader actually left off rather than yanking them back to the card.
    commit({ restoreScrollTop: 900, selectedFilePath: "b.ts", pendingCommentScroll: null });

    expect(targets).toEqual([{ type: "position", position: 900, ...INSTANT }]);
  });

  it("jumps to the focused file when no position was recorded", () => {
    commit({ selectedFilePath: "b.ts" });

    expect(targets).toEqual([{ type: "item", id: "b.ts", align: "start", ...INSTANT }]);
  });

  it("re-committing the mount's own values scrolls nothing", () => {
    commit({ restoreScrollTop: 320, selectedFilePath: "b.ts" });
    targets = [];
    // The value-compare, not a fire-once flag: a StrictMode replay looks exactly like this.
    commit({ restoreScrollTop: 320, selectedFilePath: "b.ts" });

    expect(targets).toEqual([]);
  });

  it("focuses a comment's line rather than jumping to its file", () => {
    commit();
    targets = [];
    // `focusComment` writes the request and the file in one store write, so both props
    // change in the same commit. Exactly one scroll fires, and it is the precise one.
    commit({ pendingCommentScroll: "c2", selectedFilePath: "b.ts" });

    expect(targets).toEqual([
      { type: "line", id: "b.ts", lineNumber: 40, side: "additions", align: "center", ...INSTANT },
    ]);
    expect(onCommentScrolled.mock.calls).toEqual([["c2"]]);
  });

  it("brings an outdated comment's file to the top — it has no line to centre", () => {
    commit();
    targets = [];
    commit({
      pendingCommentScroll: "c3",
      selectedFilePath: "c.ts",
      entries: [...ENTRIES, outdated("c3", "c.ts")],
    });

    expect(targets).toEqual([{ type: "item", id: "c.ts", align: "start", ...INSTANT }]);
  });

  it("still jumps when the file changes on its own", () => {
    commit();
    targets = [];
    commit({ selectedFilePath: "b.ts" });
    expect(targets).toEqual([{ type: "item", id: "b.ts", align: "start", ...INSTANT }]);

    targets = [];
    commit({ selectedFilePath: "b.ts" });
    expect(targets).toEqual([]);
  });

  it("ignores a focused id no entry hosts, and leaves the file jump to run", () => {
    commit();
    targets = [];
    // Soloed out, unplaceable, or discarded between the write and this commit: the
    // focus effect finds nothing, so it claims nothing and the file jump still fires.
    // The request is consumed anyway — nothing will ever host it, and left standing it
    // would fire at whatever mounts next.
    commit({ pendingCommentScroll: "gone", selectedFilePath: "b.ts" });

    expect(targets).toEqual([{ type: "item", id: "b.ts", align: "start", ...INSTANT }]);
    expect(onCommentScrolled.mock.calls).toEqual([["gone"]]);
  });

  it("resets to the top when the soloed layer changes", () => {
    commit();
    targets = [];
    commit({ activeLayerId: "layer-1" });
    expect(targets).toEqual([{ type: "position", position: 0, ...INSTANT }]);

    targets = [];
    commit({ activeLayerId: "layer-1" });
    expect(targets).toEqual([]);

    // Clearing back to the full diff is a change too, and starts it at its top.
    commit({ activeLayerId: null });
    expect(targets).toEqual([{ type: "position", position: 0, ...INSTANT }]);
  });

  it("captures the reader's scroll, and flushes the last one on unmount", () => {
    const scroll = commit();
    scroll.onScroll(180);
    scroll.onScroll(240);
    // Debounced, so nothing is written until the window closes or the view goes away.
    expect(onScrollTop).not.toHaveBeenCalled();

    react.unmount();
    expect(onScrollTop.mock.calls).toEqual([[240]]);
  });

  it("never captures a soloed layer's scroll — it is derived view state", () => {
    const scroll = commit({ activeLayerId: "layer-1" });
    scroll.onScroll(180);

    react.unmount();
    expect(onScrollTop).not.toHaveBeenCalled();
  });

  it("re-centres on demand without a new request", () => {
    const scroll = commit({ pendingCommentScroll: "c1" });
    targets = [];
    // The floating counter's re-centre: pure viewport, so re-running it after the
    // reader has scrolled off must not need a fresh focus first.
    scroll.scrollToComment(FIRST);
    scroll.scrollToComment(FIRST);

    expect(targets).toEqual([
      { type: "line", id: "a.ts", lineNumber: 12, side: "additions", align: "center", ...INSTANT },
      { type: "line", id: "a.ts", lineNumber: 12, side: "additions", align: "center", ...INSTANT },
    ]);
  });
});
