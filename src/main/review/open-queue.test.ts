import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/session";
import { createReviewOpenQueue, type ReviewOpenQueueDeps } from "./open-queue";

// The delivery-side ordering: a path arriving before ready is drained exactly once
// (not lost, not double-imported); a successful
// import re-lists an existing window via the payload-free push; a windowless
// import creates one instead; a bad path focuses without re-listing.

function fakeSession(id: string): Session {
  return {
    id,
    source: { kind: "local", repo: { path: "/repos/app", name: "app" } },
    mode: "commits",
    base: null,
    head: null,
    commitSelection: null,
    selectedFilePath: null,
    scrollTop: 0,
    comments: [],
    layers: [],
    overview: null,
    reviewDiff: null,
    reviewSubrange: null,
    reviewOrigin: null,
  };
}

function makeDeps() {
  return {
    importSession: vi
      .fn<ReviewOpenQueueDeps["importSession"]>()
      .mockResolvedValue(fakeSession("s1")),
    hasWindow: vi.fn<ReviewOpenQueueDeps["hasWindow"]>().mockReturnValue(true),
    createWindow: vi.fn(),
    focusWindow: vi.fn(),
    notifySessionsChanged: vi.fn(),
  };
}

/** Let the queue's internal async drain settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createReviewOpenQueue", () => {
  it("holds a path enqueued before ready, then drains it exactly once at markReady", async () => {
    const deps = makeDeps();
    const queue = createReviewOpenQueue(deps);

    queue.enqueue("/abs/x.reviewer.json");
    await flush();
    // Nothing imported while not ready.
    expect(deps.importSession).not.toHaveBeenCalled();

    queue.markReady();
    await flush();

    expect(deps.importSession).toHaveBeenCalledTimes(1);
    expect(deps.importSession).toHaveBeenCalledWith("/abs/x.reviewer.json");
    expect(deps.notifySessionsChanged).toHaveBeenCalledTimes(1);
  });

  it("imports two fast-queued paths once each, in order", async () => {
    const deps = makeDeps();
    const queue = createReviewOpenQueue(deps);
    queue.markReady();

    queue.enqueue("/abs/a.reviewer.json");
    queue.enqueue("/abs/b.reviewer.json");
    await flush();

    expect(deps.importSession.mock.calls.map((call) => call[0])).toEqual([
      "/abs/a.reviewer.json",
      "/abs/b.reviewer.json",
    ]);
  });

  it("creates a window instead of pushing when none exists (its hydrate lists it)", async () => {
    const deps = makeDeps();
    deps.hasWindow.mockReturnValue(false);
    const queue = createReviewOpenQueue(deps);
    queue.markReady();

    queue.enqueue("/abs/x.reviewer.json");
    await flush();

    expect(deps.createWindow).toHaveBeenCalledTimes(1);
    expect(deps.notifySessionsChanged).not.toHaveBeenCalled();
    expect(deps.focusWindow).not.toHaveBeenCalled();
  });

  it("focuses without re-listing when the import fails (bad launch arg)", async () => {
    const deps = makeDeps();
    deps.importSession.mockResolvedValue(null);
    const queue = createReviewOpenQueue(deps);
    queue.markReady();

    queue.enqueue("/abs/x.txt");
    await flush();

    expect(deps.focusWindow).toHaveBeenCalledTimes(1);
    expect(deps.notifySessionsChanged).not.toHaveBeenCalled();
  });
});
