import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewerBridge } from "../../../shared/ipc";
import type { RecentReview, RecentReviewsResponse } from "../../../shared/review-ipc";
import { stubBridge } from "./__fixtures__/bridge";
import { useRecentReviewsStore, visibleRecents } from "./recent-reviews";

// The picker's state machine, without a window. What is actually being pinned here is the
// cursor: it is the one thing two separate inputs move — the arrow keys, and the query
// changing out from under it — and every rule about where it lands is a rule about not
// leaving the reader pointed at a row they cannot see.

function row(title: string, path = `/reviews/${title}.reviewer.json`): RecentReview {
  return {
    path,
    modified: "2026-07-20T10:00:00.000Z",
    summary: {
      repoPath: "/work/app",
      repoName: "app",
      base: "main",
      head: "feature",
      title,
      comments: 1,
      layers: 1,
      portable: false,
    },
    progress: null,
  };
}

function answer(reviews: RecentReview[], overrides: Partial<RecentReviewsResponse> = {}) {
  return {
    dir: "/home/dev/.rvw/reviews",
    reviews,
    truncated: 0,
    unreadable: false,
    ...overrides,
  };
}

/** The shared bridge fixture with the one answer this store reads swapped for `response`. */
function install(response: RecentReviewsResponse): ReviewerBridge {
  return stubBridge({ listRecentReviews: vi.fn().mockResolvedValue(response) });
}

const ROWS = [row("alpha"), row("beta"), row("gamma")];

beforeEach(() => {
  useRecentReviewsStore.setState({
    open: false,
    phase: "idle",
    dir: null,
    reviews: [],
    truncated: 0,
    unreadable: false,
    query: "",
    activeIndex: -1,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opening", () => {
  it("re-reads the directory every time, because the CLI writes into it while we run", async () => {
    const bridge = install(answer(ROWS));
    const store = useRecentReviewsStore.getState();

    store.openPanel();
    await vi.waitFor(() => expect(useRecentReviewsStore.getState().phase).toBe("loaded"));
    useRecentReviewsStore.getState().close();
    useRecentReviewsStore.getState().openPanel();

    await vi.waitFor(() => expect(bridge.listRecentReviews).toHaveBeenCalledTimes(2));
  });

  it("clears a stale query on the way in, so the list is never mysteriously empty", async () => {
    install(answer(ROWS));
    useRecentReviewsStore.setState({ query: "nothing-matches-this" });

    useRecentReviewsStore.getState().openPanel();
    expect(useRecentReviewsStore.getState().query).toBe("");
    await vi.waitFor(() =>
      expect(visibleRecents(useRecentReviewsStore.getState())).toHaveLength(3),
    );
  });

  it("parks the cursor on the newest review, which is what the reader came for", async () => {
    install(answer(ROWS));
    useRecentReviewsStore.getState().openPanel();
    await vi.waitFor(() => expect(useRecentReviewsStore.getState().activeIndex).toBe(0));
  });

  it("has no cursor when there is nothing to point at", async () => {
    install(answer([]));
    useRecentReviewsStore.getState().openPanel();
    await vi.waitFor(() => expect(useRecentReviewsStore.getState().phase).toBe("loaded"));
    expect(useRecentReviewsStore.getState().activeIndex).toBe(-1);
  });

  it("carries the directory and the dropped count through, rather than swallowing them", async () => {
    install(answer(ROWS, { truncated: 12, unreadable: false }));
    useRecentReviewsStore.getState().openPanel();
    await vi.waitFor(() => expect(useRecentReviewsStore.getState().phase).toBe("loaded"));
    expect(useRecentReviewsStore.getState().dir).toBe("/home/dev/.rvw/reviews");
    expect(useRecentReviewsStore.getState().truncated).toBe(12);
  });

  it("does nothing at all outside Electron, where there is no bridge to ask", async () => {
    vi.stubGlobal("window", {});
    await useRecentReviewsStore.getState().refresh();
    expect(useRecentReviewsStore.getState().phase).toBe("idle");
  });
});

describe("the cursor", () => {
  beforeEach(async () => {
    install(answer(ROWS));
    useRecentReviewsStore.getState().openPanel();
    await vi.waitFor(() => expect(useRecentReviewsStore.getState().phase).toBe("loaded"));
  });

  it("steps and clamps rather than wrapping", () => {
    const store = () => useRecentReviewsStore.getState();
    store().moveCursor(1);
    expect(store().activeIndex).toBe(1);
    store().moveCursor(5);
    expect(store().activeIndex).toBe(2);
    store().moveCursor(-99);
    expect(store().activeIndex).toBe(0);
    store().moveCursor(-1);
    expect(store().activeIndex).toBe(0);
  });

  it("steps the filtered list, not the whole one", () => {
    const store = () => useRecentReviewsStore.getState();
    store().setQuery("beta");
    expect(visibleRecents(store())).toHaveLength(1);
    // One row visible, so there is nowhere to step to — even though two more rows exist
    // behind the filter.
    store().moveCursor(1);
    expect(store().activeIndex).toBe(0);
  });

  it("goes back to the first surviving row when the query changes under it", () => {
    const store = () => useRecentReviewsStore.getState();
    store().moveCursor(2);
    expect(store().activeIndex).toBe(2);
    store().setQuery("a");
    // Re-derived, not adjusted: the row that was under the cursor is usually gone, and
    // following it would leave the cursor somewhere arbitrary.
    expect(store().activeIndex).toBe(0);
  });

  it("drops the cursor entirely when a query matches nothing", () => {
    const store = () => useRecentReviewsStore.getState();
    store().setQuery("zzzz");
    expect(visibleRecents(store())).toHaveLength(0);
    expect(store().activeIndex).toBe(-1);
    // And a step over an empty list leaves it there rather than resurrecting row 0.
    store().moveCursor(1);
    expect(store().activeIndex).toBe(-1);
  });

  it("lands on a real row when a refresh arrives after the reader has typed", async () => {
    const store = () => useRecentReviewsStore.getState();
    store().setQuery("gamma");
    await store().refresh();
    // Row 0 of the *filtered* list. Measured against the unfiltered one, this would have
    // pointed the cursor at a row that is not on screen.
    expect(store().activeIndex).toBe(0);
    expect(visibleRecents(store())[0]?.summary?.title).toBe("gamma");
  });
});
