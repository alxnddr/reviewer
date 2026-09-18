import { describe, expect, it } from "vitest";
import type { Comment } from "./review";
import { commentFingerprint } from "./fingerprint";
import {
  isResolved,
  NO_RESOLUTIONS,
  pruneResolutions,
  resolutionOf,
  tallyResolutions,
  withResolution,
  type CommentResolutions,
} from "./comment-resolution";

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "3f1c2e2e-2b7a-4a2f-9d1e-6f4a1b2c3d4e",
    file: "src/main/git/runner.ts",
    side: "additions",
    startLine: 42,
    endLine: 42,
    body: "The timeout is never cleared on the success path.",
    ...overrides,
  };
}

function marked(target: Comment, resolution: "addressed" | "skipped" | "disagree") {
  return withResolution(NO_RESOLUTIONS, target, resolution);
}

describe("withResolution", () => {
  it("records a mark and reads it back", () => {
    const one = comment();
    expect(resolutionOf(marked(one, "addressed"), one)).toBe("addressed");
    expect(isResolved(marked(one, "addressed"), one)).toBe(true);
  });

  it("answers the same map when the word is already the one on the comment", () => {
    const one = comment();
    const before = marked(one, "skipped");
    expect(withResolution(before, one, "skipped")).toBe(before);
  });

  it("answers the same map when clearing a comment that was never marked", () => {
    expect(withResolution(NO_RESOLUTIONS, comment(), null)).toBe(NO_RESOLUTIONS);
  });

  it("clears a mark with null", () => {
    const one = comment();
    expect(resolutionOf(withResolution(marked(one, "disagree"), one, null), one)).toBeNull();
  });

  it("never mutates the map it was handed", () => {
    const one = comment();
    const before = marked(one, "addressed");
    withResolution(before, one, "disagree");
    expect(resolutionOf(before, one)).toBe("addressed");
  });

  it("marks the same finding under a fresh id — the whole reason it is not keyed by id", () => {
    // Two imports of one artifact stamp two uuids on what is the same comment. A mark made
    // in the first sitting has to be the mark the second sitting reads.
    const first = comment();
    const second = comment({ id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" });
    expect(resolutionOf(marked(first, "addressed"), second)).toBe("addressed");
  });

  it("does not carry a mark onto a comment whose body was edited", () => {
    const one = comment();
    const edited = comment({ body: "The timeout is never cleared. Also the cap is off by one." });
    expect(resolutionOf(marked(one, "addressed"), edited)).toBeNull();
  });
});

describe("tallyResolutions", () => {
  it("counts what is still open against the whole set", () => {
    const a = comment();
    const b = comment({ id: "1", startLine: 90, endLine: 90, body: "b" });
    const c = comment({ id: "2", startLine: 91, endLine: 91, body: "c" });
    expect(
      tallyResolutions([a, b, c], withResolution(marked(a, "addressed"), b, "skipped")),
    ).toEqual({ open: 1, total: 3 });
  });

  it("reads an unmarked review as wholly open, and an empty one as neither", () => {
    expect(tallyResolutions([comment()], NO_RESOLUTIONS)).toEqual({ open: 1, total: 1 });
    expect(tallyResolutions([], NO_RESOLUTIONS)).toEqual({ open: 0, total: 0 });
  });

  it("ignores a mark for a comment the review no longer carries", () => {
    const gone = comment({ body: "discarded" });
    expect(tallyResolutions([comment()], marked(gone, "addressed"))).toEqual({ open: 1, total: 1 });
  });
});

describe("pruneResolutions", () => {
  it("drops a mark no comment answers to", () => {
    const kept = comment();
    const gone = comment({ body: "discarded" });
    const both = withResolution(marked(kept, "addressed"), gone, "skipped");
    const pruned = pruneResolutions(both, [kept]);
    expect([...pruned.keys()]).toEqual([commentFingerprint(kept)]);
  });

  it("answers the same map when every mark is still live, so a write-back allocates nothing", () => {
    const one = comment();
    const before = marked(one, "addressed");
    expect(pruneResolutions(before, [one])).toBe(before);
  });

  it("answers the same map when there is nothing to prune", () => {
    const empty: CommentResolutions = NO_RESOLUTIONS;
    expect(pruneResolutions(empty, [comment()])).toBe(empty);
  });
});
