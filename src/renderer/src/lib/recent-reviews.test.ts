import { describe, expect, it } from "vitest";
import type { RecentReview } from "../../../shared/recent-reviews";
import {
  filterRecents,
  groupRecents,
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

describe("groupRecents", () => {
  // Local times, because the bands are calendar-relative and so is the reader.
  const now = new Date(2026, 6, 29, 9, 30);
  const at = (date: Date): RecentReview =>
    review({ path: `/${date.getTime()}.reviewer.json`, modified: date.toISOString() });

  it("bands by calendar day, so 'yesterday' is a day and not 24 hours", () => {
    // Eleven last night and eight this morning are nine hours apart and in different bands.
    const groups = groupRecents([at(new Date(2026, 6, 29, 8)), at(new Date(2026, 6, 28, 23))], now);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday"]);
  });

  it("drops the bands that hold nothing", () => {
    const groups = groupRecents([at(new Date(2026, 6, 29, 1)), at(new Date(2026, 5, 1))], now);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Older"]);
  });

  it("keeps the newest-first order inside a band", () => {
    const groups = groupRecents(
      [at(new Date(2026, 6, 29, 9)), at(new Date(2026, 6, 29, 4)), at(new Date(2026, 6, 29, 1))],
      now,
    );
    expect(groups[0]?.reviews.map((row) => row.modified)).toEqual([
      new Date(2026, 6, 29, 9).toISOString(),
      new Date(2026, 6, 29, 4).toISOString(),
      new Date(2026, 6, 29, 1).toISOString(),
    ]);
  });

  it("puts every band in its own place, coarsest last", () => {
    const groups = groupRecents(
      [
        at(new Date(2026, 6, 29, 9)),
        at(new Date(2026, 6, 28, 9)),
        at(new Date(2026, 6, 25, 9)),
        at(new Date(2026, 6, 10, 9)),
        at(new Date(2025, 1, 1, 9)),
      ],
      now,
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 days",
      "Previous 30 days",
      "Older",
    ]);
  });

  it("bands a clock-skewed future mtime as today rather than dropping the row", () => {
    const groups = groupRecents([at(new Date(2026, 6, 30, 9))], now);
    expect(groups).toEqual([{ label: "Today", reviews: [at(new Date(2026, 6, 30, 9))] }]);
  });

  it("survives an unreadable timestamp by banding it as the oldest thing there is", () => {
    const groups = groupRecents([review({ modified: "not a date" })], now);
    expect(groups.map((group) => group.label)).toEqual(["Older"]);
  });

  it("has no bands at all for an empty list", () => {
    expect(groupRecents([], now)).toEqual([]);
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
