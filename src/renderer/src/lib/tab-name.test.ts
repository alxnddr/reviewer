import { describe, expect, it } from "vitest";
import { tabName, tabNames, type TabSubject } from "./tab-name";

// The strip's names, proven headless — including the part that only exists because of the
// neighbours, which is the half a single-tab test cannot see.

function subject(overrides: Partial<TabSubject> = {}): TabSubject {
  return {
    repoName: "reviewer",
    repoPath: "/Users/dev/work/reviewer",
    title: "Anchor comments against the diff",
    head: "feature/anchors",
    ...overrides,
  };
}

describe("tabName", () => {
  it("uses the sentence someone wrote to name the change", () => {
    expect(tabName(subject())).toBe("Anchor comments against the diff");
  });

  it("falls back to the branch the review is about", () => {
    expect(tabName(subject({ title: null }))).toBe("feature/anchors");
  });

  it("abbreviates a sha head the way the rest of the chrome does", () => {
    expect(tabName(subject({ title: null, head: "a".repeat(40) }))).toBe("aaaaaaa");
  });

  it("names a plain repository session after its repository", () => {
    expect(tabName(subject({ title: null, head: null }))).toBe("reviewer");
  });

  it("treats a blank title or head as absent rather than as a name", () => {
    expect(tabName(subject({ title: "   " }))).toBe("feature/anchors");
    expect(tabName(subject({ title: null, head: " " }))).toBe("reviewer");
  });
});

describe("tabNames", () => {
  it("leaves names that are already unique alone", () => {
    expect(tabNames([subject(), subject({ title: "Drop the env fallback" })])).toEqual([
      "Anchor comments against the diff",
      "Drop the env fallback",
    ]);
  });

  it("qualifies one title held by two projects with the project", () => {
    expect(
      tabNames([
        subject({ title: "Bump the parser" }),
        subject({ title: "Bump the parser", repoName: "api", repoPath: "/Users/dev/work/api" }),
      ]),
    ).toEqual(["Bump the parser · reviewer", "Bump the parser · api"]);
  });

  it("falls through to the branch when the project cannot separate them", () => {
    // The same change reviewed twice off one repo: the project is identical, so qualifying
    // with it would leave both tabs reading the same thing.
    expect(
      tabNames([
        subject({ title: "Bump the parser", head: "fix/parser" }),
        subject({ title: "Bump the parser", head: "fix/parser-2" }),
      ]),
    ).toEqual(["Bump the parser · fix/parser", "Bump the parser · fix/parser-2"]);
  });

  it("separates two checkouts of one project by the folder above them", () => {
    // Nothing else can: both are called `reviewer`, and neither is a review.
    expect(
      tabNames([
        subject({ title: null, head: null }),
        subject({ title: null, head: null, repoPath: "/Users/dev/oss/reviewer" }),
      ]),
    ).toEqual(["reviewer · work", "reviewer · oss"]);
  });

  it("leaves two tabs that agree on every naming fact identical rather than inventing a difference", () => {
    const twin = subject({ title: "Bump the parser" });
    expect(tabNames([twin, twin])).toEqual(["Bump the parser", "Bump the parser"]);
  });

  it("qualifies only the colliding names, never their neighbours", () => {
    expect(
      tabNames([
        subject({ title: "Bump the parser" }),
        subject({ title: "Bump the parser", repoName: "api", repoPath: "/Users/dev/work/api" }),
        subject({ title: "Something else" }),
      ]),
    ).toEqual(["Bump the parser · reviewer", "Bump the parser · api", "Something else"]);
  });

  it("holds tab order, since the strip renders it positionally", () => {
    const names = tabNames([
      subject({ title: "A" }),
      subject({ title: "B" }),
      subject({ title: "C" }),
    ]);
    expect(names).toEqual(["A", "B", "C"]);
  });
});
