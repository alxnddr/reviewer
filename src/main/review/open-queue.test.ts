import { describe, expect, it, vi } from "vitest";
import { NO_PROGRESS } from "../../shared/review-progress";
import type { Session } from "../../shared/session";
import { createReviewOpenQueue, type ReviewOpenQueueDeps } from "./open-queue";

// The delivery-side ordering: a path arriving before ready is drained exactly once
// (not lost, not double-imported); a successful
// import re-lists an existing window via the payload-free push; a windowless
// import creates one instead; a bad path focuses without re-listing. And the push
// never outruns the page it is for — the cold-start case where the import finishes
// before the renderer has loaded, and a `send` would be dropped in silence.

function fakeSession(id: string): Session {
  return {
    id,
    source: { kind: "local", repo: { path: "/repos/app", name: "app" } },
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
    reviewPath: null,
    ...NO_PROGRESS,
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
    whenWindowReady: vi.fn<ReviewOpenQueueDeps["whenWindowReady"]>().mockResolvedValue(undefined),
    notifySessionsChanged: vi.fn(),
  };
}

/** A promise the test resolves by hand, to hold one of the queue's awaits open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Let the queue's internal async drain settle. A macrotask rather than counted microticks:
 * `reveal` awaits an import *and* the page gate, and the count is not the test's business. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

  it("holds the push until the window's page has loaded (fast import, cold start)", async () => {
    const deps = makeDeps();
    const page = deferred<void>();
    deps.whenWindowReady.mockReturnValue(page.promise);
    const queue = createReviewOpenQueue(deps);

    // The launch order in index.ts: the window object exists, so `hasWindow()` is true, but
    // its page has not loaded yet.
    queue.markReady();
    queue.enqueue("/abs/x.reviewer.json");
    await flush();

    expect(deps.importSession).toHaveBeenCalledTimes(1);
    // Focus is not gated on the page — only the send is, because only the send is dropped.
    expect(deps.focusWindow).toHaveBeenCalledTimes(1);
    expect(deps.notifySessionsChanged).not.toHaveBeenCalled();

    page.resolve();
    await flush();

    expect(deps.notifySessionsChanged).toHaveBeenCalledTimes(1);
  });

  it("pushes straight away for an import slower than page load", async () => {
    const deps = makeDeps();
    const slowImport = deferred<Session | null>();
    deps.importSession.mockReturnValue(slowImport.promise);
    const queue = createReviewOpenQueue(deps);

    queue.markReady();
    queue.enqueue("/abs/x.reviewer.json");
    await flush();

    expect(deps.notifySessionsChanged).not.toHaveBeenCalled();

    // The page won that race, so the gate is already open when the session lands.
    slowImport.resolve(fakeSession("s1"));
    await flush();

    expect(deps.notifySessionsChanged).toHaveBeenCalledTimes(1);
  });

  it("does not wait on the page when there is nothing to push", async () => {
    const deps = makeDeps();
    deps.importSession.mockResolvedValue(null);
    const queue = createReviewOpenQueue(deps);
    queue.markReady();

    queue.enqueue("/abs/x.txt");
    await flush();

    expect(deps.whenWindowReady).not.toHaveBeenCalled();
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
