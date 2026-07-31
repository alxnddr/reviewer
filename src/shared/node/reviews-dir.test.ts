import { describe, expect, it } from "vitest";
import { reviewFileName, reviewsDir } from "./reviews-dir";

// The default-output location and name are pure of the process and the clock (env, home, and
// the timestamp are arguments), so both are proven here without writing a file or touching the
// real home directory. `emit.test.ts` proves they are actually written to, and
// `main/review/recent.test.ts` proves the app reads the same place.

describe("reviewsDir", () => {
  it("defaults to ~/.rvw/reviews under the given home", () => {
    expect(reviewsDir({}, "/home/dev")).toBe("/home/dev/.rvw/reviews");
  });

  it("does not double a separator when home or the override carries a trailing slash", () => {
    expect(reviewsDir({}, "/home/dev/")).toBe("/home/dev/.rvw/reviews");
    expect(reviewsDir({ RVW_HOME: "/tmp/rvw/" }, "/home/dev")).toBe("/tmp/rvw/reviews");
  });

  it("honors a non-empty RVW_HOME override so a test never writes to the real home", () => {
    expect(reviewsDir({ RVW_HOME: "/tmp/rvw-store" }, "/home/dev")).toBe("/tmp/rvw-store/reviews");
  });

  it("treats an empty RVW_HOME as unset rather than resolving to `/reviews`", () => {
    expect(reviewsDir({ RVW_HOME: "" }, "/home/dev")).toBe("/home/dev/.rvw/reviews");
  });

  it("stays absolute when home is empty, rather than landing beside the caller's cwd", () => {
    expect(reviewsDir({}, "")).toBe("/.rvw/reviews");
  });
});

describe("reviewFileName", () => {
  it("names a review from repo, refs, and stamp, ending .reviewer.json", () => {
    const name = reviewFileName("/work/my-repo", "main", "feature", 1_700_000_000_000);
    expect(name).toBe("my-repo-main-feature-1700000000000.reviewer.json");
  });

  it("slugs a branch ref's slashes so a path separator cannot escape into the name", () => {
    const name = reviewFileName("/work/repo", "main", "feat/thing", 7);
    expect(name).toBe("repo-main-feat-thing-7.reviewer.json");
    expect(name).not.toContain("/feat");
  });

  it("caps a long sha so it does not swamp the name, keeping the leading identity", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const name = reviewFileName("/work/repo", sha, "main", 1);
    expect(name).toContain("0123456789abcdef-main-1.reviewer.json");
    expect(name).not.toContain(sha);
  });

  it("makes each emit unique by the stamp, so re-reviewing a range never clobbers silently", () => {
    const a = reviewFileName("/work/repo", "main", "feature", 1);
    const b = reviewFileName("/work/repo", "main", "feature", 2);
    expect(a).not.toBe(b);
  });

  it("falls back to `review` when the repo basename slugs to nothing", () => {
    expect(reviewFileName("/", "main", "feature", 1)).toBe("review-main-feature-1.reviewer.json");
  });
});
