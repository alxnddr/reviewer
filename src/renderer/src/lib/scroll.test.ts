import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScrollCapture,
  planScrollRestore,
  SCROLL_CAPTURE_DEBOUNCE_MS,
  type ScrollRestore,
} from "./scroll";

describe("planScrollRestore", () => {
  it("restores a recorded position, and it wins over a focused file (one owner)", () => {
    const plan = planScrollRestore(1200, "src/app.ts");
    // Exactly one owner: position, never also the file jump.
    expect(plan).toEqual<ScrollRestore>({ kind: "position", position: 1200 });
  });

  it("jumps to the focused file when no position is recorded", () => {
    const plan = planScrollRestore(0, "src/app.ts");
    expect(plan).toEqual<ScrollRestore>({ kind: "item", filePath: "src/app.ts" });
  });

  it("issues nothing — starts at the top — with neither a position nor a file", () => {
    expect(planScrollRestore(0, null)).toEqual<ScrollRestore>({ kind: "none" });
  });

  it("never emits a position restore for a zero scrollTop (absence, not pixel 0)", () => {
    expect(planScrollRestore(0, null).kind).not.toBe("position");
    expect(planScrollRestore(0, "src/app.ts").kind).not.toBe("position");
  });
});

describe("createScrollCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into a single commit of the latest position", () => {
    const commit = vi.fn<(scrollTop: number) => void>();
    const capture = createScrollCapture(commit);

    capture.notify(10);
    capture.notify(40);
    capture.notify(90);
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SCROLL_CAPTURE_DEBOUNCE_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(90);
  });

  it("starts a fresh window after a commit rather than firing per event", () => {
    const commit = vi.fn<(scrollTop: number) => void>();
    const capture = createScrollCapture(commit);

    capture.notify(10);
    vi.advanceTimersByTime(SCROLL_CAPTURE_DEBOUNCE_MS);
    capture.notify(20);
    vi.advanceTimersByTime(SCROLL_CAPTURE_DEBOUNCE_MS);

    expect(commit.mock.calls).toEqual([[10], [20]]);
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

  it("flush with nothing pending is a no-op", () => {
    const commit = vi.fn<(scrollTop: number) => void>();
    const capture = createScrollCapture(commit);

    capture.flush();
    vi.advanceTimersByTime(SCROLL_CAPTURE_DEBOUNCE_MS);
    expect(commit).not.toHaveBeenCalled();
  });
});
