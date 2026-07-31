import { describe, expect, it } from "vitest";
import { parsePatch } from "../../../shared/diff/patch";
import { MULTI_STATUS_PATCH } from "../../../shared/diff/fixtures";
import type { Comment } from "../../../shared/review";
import type { LogEntry, RepoInfo } from "../../../shared/git";
import {
  headShaOf,
  persistedSession,
  reviewFileBase,
  type PersistedSlice,
} from "./session-projection";

const REPO: RepoInfo = { path: "/repo", name: "repo" };

function sha(fill: string): string {
  return fill.repeat(40).slice(0, 40);
}

function commitEntry(fill: string): LogEntry {
  return {
    kind: "commit",
    commit: {
      sha: sha(fill),
      shortSha: sha(fill).slice(0, 7),
      author: "t",
      authoredAt: "2026-07-04T00:00:00+00:00",
      subject: `commit ${fill}`,
    },
  };
}

describe("reviewFileBase", () => {
  it("is the repo name with the export suffix", () => {
    expect(reviewFileBase("reviewer")).toBe("reviewer-review");
  });

  it("flattens separators the save request would reject", () => {
    // Never a real toplevel basename, but it arrives from outside all the same — and a
    // rejected request is a save sheet that never opens.
    expect(reviewFileBase("a/b")).toBe("a-b-review");
    expect(reviewFileBase(String.raw`a\b`)).toBe("a-b-review");
    expect(reviewFileBase("a\0b")).toBe("a-b-review");
  });

  it("falls back to a name rather than offering a bare suffix", () => {
    expect(reviewFileBase("")).toBe("review-review");
    expect(reviewFileBase("   ")).toBe("review-review");
  });
});

describe("headShaOf", () => {
  it("is the newest committed entry, skipping the working-tree row that carries no sha", () => {
    expect(
      headShaOf({
        phase: "loaded",
        entries: [{ kind: "uncommitted" }, commitEntry("a"), commitEntry("b")],
      }),
    ).toBe(sha("a"));
  });

  it("is null on an unborn repo, whose log holds no commit at all", () => {
    expect(headShaOf({ phase: "loaded", entries: [{ kind: "uncommitted" }] })).toBeNull();
    expect(headShaOf({ phase: "loaded", entries: [] })).toBeNull();
  });

  it("is null before the log has landed, and for one that failed", () => {
    expect(headShaOf(null)).toBeNull();
    expect(headShaOf({ phase: "loading" })).toBeNull();
    expect(headShaOf({ phase: "failed", failure: { code: "gitMissing" } })).toBeNull();
  });
});

describe("persistedSession", () => {
  const COMMENT: Comment = {
    id: "3f1c2e2e-2b7a-4a2f-9d1e-6f4a1b2c3d4e",
    file: "src/keep.ts",
    side: "additions",
    startLine: 5,
    endLine: 6,
    body: "authored",
  };

  function slice(overrides: Partial<PersistedSlice> = {}): PersistedSlice {
    return {
      id: "6a2b0f34-1b6e-4c3f-8a2d-9e0f1a2b3c4d",
      repo: REPO,
      head: "feature",
      base: "main",
      commitSelection: { kind: "commitRange", first: sha("b"), last: sha("a") },
      selectedFilePath: "src/keep.ts",
      scrollTop: 120,
      comments: [COMMENT],
      layers: [],
      overview: { title: "Tour", body: "start here" },
      reviewDiff: { kind: "refs", base: "main", head: sha("a") },
      reviewSubrange: null,
      reviewOrigin: { repo: REPO, base: "main", head: sha("a"), patch: null },
      reviewPath: "/reviews/x.reviewer.json",
      readFiles: new Map([["src/keep.ts", "sig-1"]]),
      collapsedFiles: new Set(["src/keep.ts"]),
      readTotal: 7,
      diff: { phase: "idle" },
      ...overrides,
    };
  }

  it("carries the session's inputs verbatim, under main's own source shape", () => {
    expect(persistedSession(slice())).toEqual({
      id: "6a2b0f34-1b6e-4c3f-8a2d-9e0f1a2b3c4d",
      source: { kind: "local", repo: REPO },
      head: "feature",
      base: "main",
      commitSelection: { kind: "commitRange", first: sha("b"), last: sha("a") },
      selectedFilePath: "src/keep.ts",
      scrollTop: 120,
      comments: [COMMENT],
      layers: [],
      overview: { title: "Tour", body: "start here" },
      reviewDiff: { kind: "refs", base: "main", head: sha("a") },
      reviewSubrange: null,
      reviewOrigin: { repo: REPO, base: "main", head: sha("a"), patch: null },
      reviewPath: "/reviews/x.reviewer.json",
      readFiles: { "src/keep.ts": "sig-1" },
      collapsedFiles: ["src/keep.ts"],
      readTotal: 7,
    });
  });

  it("sends no derived state — the log, the branches and the diff are re-derived on load", () => {
    const persisted = persistedSession(slice());
    for (const key of ["log", "branches", "diff", "brush", "activeLayerId", "activeCommentId"]) {
      expect(persisted).not.toHaveProperty(key);
    }
  });

  it("turns the Map and Set the app works in into the record and array JSON can carry", () => {
    const persisted = persistedSession(
      slice({ readFiles: new Map(), collapsedFiles: new Set<string>() }),
    );
    expect(persisted.readFiles).toEqual({});
    expect(persisted.collapsedFiles).toEqual([]);
  });

  it("refreshes the read denominator from the diff on screen", () => {
    const files = parsePatch(MULTI_STATUS_PATCH, "x");
    expect(files.length).toBeGreaterThan(1);
    expect(persistedSession(slice({ diff: { phase: "loaded", loadId: 1, files } })).readTotal).toBe(
      files.length,
    );
  });

  it("keeps the restored denominator while no diff is loaded, rather than publishing a zero", () => {
    // The start screen renders this as "N files"; a session persisting mid-load would
    // otherwise wipe the last honest answer with one nothing measured.
    for (const diff of [
      { phase: "idle" } as const,
      { phase: "loading" } as const,
      { phase: "empty" } as const,
      { phase: "unreadable" } as const,
      { phase: "failed", failure: { code: "gitMissing" } } as const,
    ]) {
      expect(persistedSession(slice({ diff })).readTotal).toBe(7);
    }
  });
});
