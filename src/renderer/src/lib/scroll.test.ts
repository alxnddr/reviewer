import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScrollCapture,
  docMountReturn,
  planDocReturn,
  planScrollRestore,
  type DocReturn,
  samePendingScroll,
  SCROLL_CAPTURE_DEBOUNCE_MS,
  type PendingScroll,
  type ScrollRestore,
} from "./scroll";

describe("planScrollRestore", () => {
  it("serves an outstanding comment jump over everything below it", () => {
    // The mount that IS the click: opening a finding from the tour doc mounts the diff
    // pane, and the reader asked for that comment, not for wherever they last were.
    const plan = planScrollRestore(1200, "src/app.ts", { kind: "comment", commentId: "c7" });
    expect(plan).toEqual<ScrollRestore>({ kind: "comment", commentId: "c7" });
  });

  it("serves an outstanding line jump the same way — a reference's chip is that click too", () => {
    const line: PendingScroll = { kind: "line", path: "src/app.ts", line: 40, side: "additions" };
    expect(planScrollRestore(1200, "src/other.ts", line)).toEqual<ScrollRestore>(line);
  });

  it("serves an outstanding file jump over the recorded position — the row the reader clicked", () => {
    // The ranking this file exists to get right. A chapter's file row and a bare-path
    // reference both leave the doc, which mounts the diff pane, so the recorded position is
    // live on the very commit the reader asked to be taken somewhere else. It is the file
    // focus the *session* carried in that the position outranks, not the one just picked.
    const file: PendingScroll = { kind: "file", path: "src/app.ts" };
    expect(planScrollRestore(1200, "src/app.ts", file)).toEqual<ScrollRestore>(file);
  });

  it("restores a recorded position, and it wins over a focused file (one owner)", () => {
    const plan = planScrollRestore(1200, "src/app.ts", null);
    // Exactly one owner: position, never also the file jump.
    expect(plan).toEqual<ScrollRestore>({ kind: "position", position: 1200 });
  });

  it("jumps to the focused file when no position is recorded", () => {
    const plan = planScrollRestore(0, "src/app.ts", null);
    expect(plan).toEqual<ScrollRestore>({ kind: "item", filePath: "src/app.ts" });
  });

  it("issues nothing — starts at the top — with neither a position nor a file", () => {
    expect(planScrollRestore(0, null, null)).toEqual<ScrollRestore>({ kind: "none" });
  });

  it("never emits a position restore for a zero scrollTop (absence, not pixel 0)", () => {
    expect(planScrollRestore(0, null, null).kind).not.toBe("position");
    expect(planScrollRestore(0, "src/app.ts", null).kind).not.toBe("position");
  });
});

// What the store's clear guard is made of: it clears only the request the surface reports
// serving, so a jump the reader made in between survives.
describe("planDocReturn", () => {
  it("a live trip returns to the exact position, even over a soloed chapter", () => {
    // The heading clicked by accident: the exit soloed chapter 6, and the reader still comes
    // back to the line they clicked from rather than to the top of that section.
    expect(planDocReturn(true, 2770, "layer-6")).toEqual<DocReturn>({
      kind: "position",
      top: 2770,
    });
  });

  it("an ended trip opens on the chapter the reader is in", () => {
    expect(planDocReturn(false, 2770, "layer-9")).toEqual<DocReturn>({
      kind: "chapter",
      layerId: "layer-9",
    });
  });

  it("an ended trip with nothing soloed falls back to the position, never the top", () => {
    expect(planDocReturn(false, 3000, null)).toEqual<DocReturn>({ kind: "position", top: 3000 });
  });

  it("a position of 0 is the top, which is its own arm", () => {
    expect(planDocReturn(true, 0, null)).toEqual<DocReturn>({ kind: "top" });
    expect(planDocReturn(true, 0, "layer-1")).toEqual<DocReturn>({ kind: "top" });
    expect(planDocReturn(false, 0, null)).toEqual<DocReturn>({ kind: "top" });
  });
});

describe("docMountReturn", () => {
  it("serves the request the document was opened with", () => {
    const chapter: DocReturn = { kind: "chapter", layerId: "layer-9" };
    expect(docMountReturn(chapter, 3000)).toBe(chapter);
  });

  it("a bare remount restores the last reported position", () => {
    expect(docMountReturn(null, 3000)).toEqual<DocReturn>({ kind: "position", top: 3000 });
    expect(docMountReturn(null, 0)).toEqual<DocReturn>({ kind: "top" });
  });
});

describe("samePendingScroll", () => {
  const line: PendingScroll = { kind: "line", path: "src/app.ts", line: 40, side: "additions" };

  it("compares by value, not identity", () => {
    expect(samePendingScroll(line, { ...line })).toBe(true);
    expect(
      samePendingScroll({ kind: "comment", commentId: "c7" }, { kind: "comment", commentId: "c7" }),
    ).toBe(true);
  });

  it("tells a newer request apart, down to the side of the line", () => {
    expect(samePendingScroll(line, { ...line, line: 41 })).toBe(false);
    expect(samePendingScroll(line, { ...line, side: "deletions" })).toBe(false);
    expect(samePendingScroll(line, { ...line, path: "src/other.ts" })).toBe(false);
    expect(samePendingScroll(line, { kind: "comment", commentId: "c7" })).toBe(false);
  });

  it("never reads a file request as the line request on the same path", () => {
    const file: PendingScroll = { kind: "file", path: "src/app.ts" };
    expect(samePendingScroll(file, { kind: "file", path: "src/app.ts" })).toBe(true);
    expect(samePendingScroll(file, { kind: "file", path: "src/other.ts" })).toBe(false);
    // Same path, different jump: clearing the coarse one on the precise one's report would
    // drop a reader's jump, which is the whole reason the clear compares by value.
    expect(samePendingScroll(file, line)).toBe(false);
    expect(samePendingScroll(line, file)).toBe(false);
  });
});

// The generic arm/coalesce/flush/cancel behaviour is covered once, on the shared primitive
// this wraps (`shared/debounce.test.ts`). What is left here is site-specific: that a capture
// commits at its own 150ms window (not main's 500ms write-back window) and that `notify`/
// `flush` reach `commit` at all.
describe("createScrollCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits the latest of a burst after its own 150ms window, distinct from the 500ms write-back", () => {
    const commit = vi.fn<(scrollTop: number) => void>();
    const capture = createScrollCapture(commit);

    capture.notify(10);
    capture.notify(90);
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SCROLL_CAPTURE_DEBOUNCE_MS);
    expect(commit).toHaveBeenCalledExactlyOnceWith(90);
  });

  it("flush commits a pending position immediately — the unmount/switch path", () => {
    const commit = vi.fn<(scrollTop: number) => void>();
    const capture = createScrollCapture(commit);

    capture.notify(555);
    capture.flush();
    expect(commit).toHaveBeenCalledExactlyOnceWith(555);

    // The timer was cleared, so no second commit fires on the trailing edge.
    vi.advanceTimersByTime(SCROLL_CAPTURE_DEBOUNCE_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
