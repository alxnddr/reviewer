import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  DiffSelection,
  FileAtRef,
  FileContentsRequest,
  FileContentsResponse,
  FileContentsSource,
} from "../../../../shared/git";
import {
  createExpandLoader,
  expansionOptions,
  expansionSources,
  resolveExpandLoader,
  toLoadedFiles,
  type ExpansionSources,
  type FileContentsFetch,
} from "./expand-context";

const REPO = "/repo";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const BRANCH_SOURCES: ExpansionSources = {
  oldSource: { kind: "ref", ref: "main" },
  newSource: { kind: "ref", ref: "feature" },
};

/** A stable string for a source so the fetch mock can echo which side it read. */
function sourceLabel(source: FileContentsSource): string {
  switch (source.kind) {
    case "ref":
      return source.ref;
    case "parentOf":
      return `${source.commit}^`;
    case "head":
      return "HEAD";
    case "worktree":
      return "worktree";
  }
}

function fileDiff(overrides: Partial<FileDiffMetadata>): FileDiffMetadata {
  return {
    name: "src/app.ts",
    type: "change",
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    ...overrides,
  };
}

function present(text: string): FileAtRef {
  return { kind: "present", text };
}

const ABSENT: FileAtRef = { kind: "absent" };

describe("expansionSources", () => {
  it("reads both sides at their refs for a branches selection", () => {
    const selection: DiffSelection = { kind: "branches", base: "main", head: "feature" };
    expect(expansionSources(selection)).toEqual({
      oldSource: { kind: "ref", ref: "main" },
      newSource: { kind: "ref", ref: "feature" },
    });
  });

  it("reads both sides at their refs for a reviewRefs selection", () => {
    const selection: DiffSelection = { kind: "reviewRefs", base: "main", head: "topic" };
    expect(expansionSources(selection)).toEqual({
      oldSource: { kind: "ref", ref: "main" },
      newSource: { kind: "ref", ref: "topic" },
    });
  });

  it("reads a commit range old side at the parent and new side at last", () => {
    const selection: DiffSelection = { kind: "commitRange", first: SHA_A, last: SHA_B };
    expect(expansionSources(selection)).toEqual({
      oldSource: { kind: "parentOf", commit: SHA_A },
      newSource: { kind: "ref", ref: SHA_B },
    });
  });

  it("reads a commit-range-with-uncommitted old side at the parent, new side off disk", () => {
    const selection: DiffSelection = { kind: "commitRangeWithUncommitted", first: SHA_A };
    expect(expansionSources(selection)).toEqual({
      oldSource: { kind: "parentOf", commit: SHA_A },
      newSource: { kind: "worktree" },
    });
  });

  it("reads an uncommitted old side at HEAD, new side off disk", () => {
    const selection: DiffSelection = { kind: "uncommitted" };
    expect(expansionSources(selection)).toEqual({
      oldSource: { kind: "head" },
      newSource: { kind: "worktree" },
    });
  });
});

describe("toLoadedFiles", () => {
  it("returns both sides for a change, keyed to their paths for language inference", () => {
    const loaded = toLoadedFiles(
      { oldPath: "src/app.ts", newPath: "src/app.ts" },
      present("old text"),
      present("new text"),
    );
    expect(loaded).toEqual({
      oldFile: { name: "src/app.ts", contents: "old text" },
      newFile: { name: "src/app.ts", contents: "new text" },
    });
  });

  it("maps an absent old side to Pierre's oldFile: null", () => {
    const loaded = toLoadedFiles(
      { oldPath: "src/app.ts", newPath: "src/app.ts" },
      ABSENT,
      present("new text"),
    );
    expect(loaded).toEqual({
      oldFile: null,
      newFile: { name: "src/app.ts", contents: "new text" },
    });
  });

  it("rejects an absent new side rather than fabricate empty content", () => {
    // The head-absent side (a deleted file) is unrepresentable in Pierre's loader
    // union; it must fail the load, never render as "".
    expect(() =>
      toLoadedFiles({ oldPath: "src/app.ts", newPath: "src/app.ts" }, present("old text"), ABSENT),
    ).toThrow();
  });
});

describe("createExpandLoader", () => {
  it("reads each side from its own source and returns both file contents", async () => {
    const requests: FileContentsRequest[] = [];
    const fetch: FileContentsFetch = vi.fn((request): Promise<FileContentsResponse> => {
      requests.push(request);
      return Promise.resolve({
        ok: true,
        value: present(`${sourceLabel(request.source)}:${request.path}`),
      });
    });
    const loader = createExpandLoader(REPO, BRANCH_SOURCES, fetch);

    const loaded = await loader(fileDiff({ name: "src/app.ts", type: "change" }));

    expect(requests).toEqual([
      { repoPath: REPO, source: { kind: "ref", ref: "main" }, path: "src/app.ts" },
      { repoPath: REPO, source: { kind: "ref", ref: "feature" }, path: "src/app.ts" },
    ]);
    expect(loaded).toEqual({
      oldFile: { name: "src/app.ts", contents: "main:src/app.ts" },
      newFile: { name: "src/app.ts", contents: "feature:src/app.ts" },
    });
  });

  it("reads a commit range's old side at the parent, new side off disk", async () => {
    const requests: FileContentsRequest[] = [];
    const fetch: FileContentsFetch = vi.fn((request): Promise<FileContentsResponse> => {
      requests.push(request);
      return Promise.resolve({ ok: true, value: present("body") });
    });
    const sources = expansionSources({ kind: "commitRangeWithUncommitted", first: SHA_A });
    const loader = createExpandLoader(REPO, sources, fetch);

    await loader(fileDiff({ name: "src/app.ts", type: "change" }));

    expect(requests).toEqual([
      { repoPath: REPO, source: { kind: "parentOf", commit: SHA_A }, path: "src/app.ts" },
      { repoPath: REPO, source: { kind: "worktree" }, path: "src/app.ts" },
    ]);
  });

  it("reads a rename-changed old side at the pre-rename path", async () => {
    const requests: FileContentsRequest[] = [];
    const fetch: FileContentsFetch = vi.fn((request): Promise<FileContentsResponse> => {
      requests.push(request);
      return Promise.resolve({ ok: true, value: present("body") });
    });
    const loader = createExpandLoader(REPO, BRANCH_SOURCES, fetch);

    await loader(fileDiff({ name: "src/new.ts", prevName: "src/old.ts", type: "rename-changed" }));

    expect(requests).toEqual([
      { repoPath: REPO, source: { kind: "ref", ref: "main" }, path: "src/old.ts" },
      { repoPath: REPO, source: { kind: "ref", ref: "feature" }, path: "src/new.ts" },
    ]);
  });

  it("rejects the load when a side read fails, so Pierre keeps the hunk-only view", async () => {
    const fetch: FileContentsFetch = vi.fn(
      (): Promise<FileContentsResponse> =>
        Promise.resolve({ ok: false, failure: { code: "unknownRevision" } }),
    );
    const loader = createExpandLoader(REPO, BRANCH_SOURCES, fetch);

    await expect(loader(fileDiff({}))).rejects.toThrow();
  });
});

describe("resolveExpandLoader (the frozen gate)", () => {
  const selection: DiffSelection = { kind: "branches", base: "main", head: "feature" };
  const fetch: FileContentsFetch = vi.fn(
    (): Promise<FileContentsResponse> => Promise.resolve({ ok: true, value: present("x") }),
  );

  it("builds a loader for a live-repo two-ref selection", () => {
    expect(resolveExpandLoader({ frozen: false, repoPath: REPO, selection, fetch })).toBeTypeOf(
      "function",
    );
  });

  it("builds a loader for every live commit-brush selection too", () => {
    const brushed: DiffSelection[] = [
      { kind: "commitRange", first: SHA_A, last: SHA_B },
      { kind: "commitRangeWithUncommitted", first: SHA_A },
      { kind: "uncommitted" },
    ];
    for (const brushedSelection of brushed) {
      expect(
        resolveExpandLoader({
          frozen: false,
          repoPath: REPO,
          selection: brushedSelection,
          fetch,
        }),
      ).toBeTypeOf("function");
    }
  });

  it("never builds a loader for a frozen artifact", () => {
    // Even with a repo and a valid selection present, frozen yields no loader — so
    // DiffView shows no expander and no git read can fire.
    expect(resolveExpandLoader({ frozen: true, repoPath: REPO, selection, fetch })).toBeNull();
  });

  it("has no loader without a repo, a selection, or a bridge", () => {
    expect(resolveExpandLoader({ frozen: false, repoPath: null, selection, fetch })).toBeNull();
    expect(
      resolveExpandLoader({ frozen: false, repoPath: REPO, selection: null, fetch }),
    ).toBeNull();
    expect(
      resolveExpandLoader({ frozen: false, repoPath: REPO, selection, fetch: null }),
    ).toBeNull();
  });
});

describe("expansionOptions", () => {
  it("passes no loader when null, so a partial diff has no expander to hydrate from", () => {
    const options = expansionOptions(null);
    expect(options.loadDiffFiles).toBeUndefined();
    // Never eager whole-file expansion: incremental only, driven by the loader below.
    expect(options.expandUnchanged).toBe(false);
  });

  it("passes the loader and a per-click line count, staying in the incremental mode", () => {
    const loader = createExpandLoader(REPO, BRANCH_SOURCES, vi.fn());
    const options = expansionOptions(loader);
    expect(options.loadDiffFiles).toBe(loader);
    // expandUnchanged: true would eagerly render the whole file (the deferred
    // "expand all") and ignore expansionLineCount; the click expander needs false.
    expect(options.expandUnchanged).toBe(false);
    expect(options.expansionLineCount).toBeGreaterThan(0);
  });
});
