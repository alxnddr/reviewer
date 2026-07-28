import { describe, expect, it } from "vitest";
import type { RecentReview } from "../../../shared/recent-reviews";
import {
  filterRecents,
  recentFileName,
  recentRange,
  recentSearchText,
  recentTitle,
  showsRange,
  stepIndex,
} from "./recent-reviews";

// The picker's vocabulary, proven headless: what a row is called, what a query runs against,
// and where a keystroke lands. The panel itself is the only thing left that needs a window.

function review(overrides: Partial<RecentReview> = {}): RecentReview {
  return {
    path: "/home/dev/.rvw/reviews/app-main-feature-1700000000000.reviewer.json",
    modified: "2026-07-20T10:00:00.000Z",
    summary: {
      repoPath: "/work/app",
      repoName: "app",
      base: "main",
      head: "feature",
      title: "Anchor comments against the diff",
      comments: 3,
      layers: 2,
      portable: false,
    },
    ...overrides,
  };
}

describe("recentFileName", () => {
  it("takes the last path segment and drops the extension every row would repeat", () => {
    expect(recentFileName("/home/dev/.rvw/reviews/app-main-x-17.reviewer.json")).toBe(
      "app-main-x-17",
    );
  });

  it("leaves a name that does not carry the extension alone", () => {
    expect(recentFileName("/tmp/stray.json")).toBe("stray.json");
  });
});

describe("recentTitle", () => {
  it("prefers the sentence someone wrote to name the change", () => {
    expect(recentTitle(review())).toBe("Anchor comments against the diff");
  });

  it("falls back to the range, which every artifact has", () => {
    const summary = review().summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;
    expect(recentTitle(review({ summary: { ...summary, title: null } }))).toBe("main → feature");
  });

  it("names an unreadable file by its filename — all that is known, and still recognisable", () => {
    expect(recentTitle(review({ summary: null }))).toBe("app-main-feature-1700000000000");
  });
});

describe("recentRange", () => {
  it("abbreviates a sha the way the rail does, and leaves a branch alone", () => {
    const summary = review().summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;
    expect(recentRange({ ...summary, head: "a".repeat(40) })).toBe("main → aaaaaaa");
    expect(recentRange(summary)).toBe("main → feature");
  });
});

describe("showsRange", () => {
  it("is false exactly when the title already is the range", () => {
    const summary = review().summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;
    expect(showsRange(review())).toBe(true);
    expect(showsRange(review({ summary: { ...summary, title: null } }))).toBe(false);
    expect(showsRange(review({ summary: null }))).toBe(false);
  });
});

describe("recentSearchText", () => {
  it("covers the repo, both refs, the title, and the filename", () => {
    const text = recentSearchText(review());
    for (const fragment of ["app", "main", "feature", "Anchor comments", "app-main-feature"]) {
      expect(text).toContain(fragment);
    }
  });

  it("leaves the directory out, since every row shares it and it only adds false matches", () => {
    expect(recentSearchText(review())).not.toContain("/.rvw/reviews/");
    expect(recentSearchText(review({ summary: null }))).toBe("app-main-feature-1700000000000");
  });
});

describe("filterRecents", () => {
  const summary = review().summary;
  const rows = [
    review({ path: "/a.reviewer.json" }),
    review({
      path: "/b.reviewer.json",
      summary: summary === null ? null : { ...summary, repoName: "docs", title: "Rewrite guides" },
    }),
  ];

  it("keeps everything on a blank or whitespace-only query", () => {
    expect(filterRecents(rows, "")).toHaveLength(2);
    expect(filterRecents(rows, "   ")).toHaveLength(2);
  });

  it("matches a substring of any searchable field, case-insensitively", () => {
    expect(filterRecents(rows, "docs").map((row) => row.path)).toEqual(["/b.reviewer.json"]);
    expect(filterRecents(rows, "ANCHOR").map((row) => row.path)).toEqual(["/a.reviewer.json"]);
  });

  it("requires every word, in any order, rather than the whole phrase verbatim", () => {
    expect(filterRecents(rows, "guides docs").map((row) => row.path)).toEqual(["/b.reviewer.json"]);
    // Both words must land: the second one is nowhere on either row.
    expect(filterRecents(rows, "docs anchor")).toEqual([]);
  });

  it("does not match a mere subsequence, which would keep every row for a short query", () => {
    // The bug this replaced: "api" is a subsequence of "m(a)in ... (p)icker ... rev(i)ews", so
    // a subsequence filter kept all six rows while looking like it had narrowed them.
    expect(filterRecents(rows, "api")).toEqual([]);
  });

  it("holds the newest-first order rather than re-ranking by match quality", () => {
    // Both rows match "re"; a filter that also reordered would move rows under the cursor for
    // reasons the reader cannot see.
    expect(filterRecents(rows, "re").map((row) => row.path)).toEqual([
      "/a.reviewer.json",
      "/b.reviewer.json",
    ]);
  });

  it("answers empty when nothing matches, rather than falling back to everything", () => {
    expect(filterRecents(rows, "zzzz")).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("clamps at both ends instead of wrapping", () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(2, 1, 5)).toBe(3);
  });

  it("lands on the first row from no cursor at all, in either direction", () => {
    expect(stepIndex(-1, 1, 5)).toBe(0);
    expect(stepIndex(-1, -1, 5)).toBe(0);
  });

  it("overshoots to the ends, which is what Home and End are", () => {
    expect(stepIndex(3, -99, 5)).toBe(0);
    expect(stepIndex(1, 99, 5)).toBe(4);
  });

  it("has no cursor for an empty list", () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
    expect(stepIndex(-1, -1, 0)).toBe(-1);
  });
});
