import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_PROGRESS, type ReadProgress } from "../../shared/review-progress";
import { createProgressStore, progressFileName } from "./progress";

// The artifact-scoped progress store, against real directories — which is where all of its
// interesting behaviour lives. The store's whole promise is that a record it cannot
// understand costs one review's ring and nothing else, and the only way to prove that is to
// put a broken record on a disk next to a good one and read both.

let tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-progress-"));
  tempDirs.push(dir);
  return join(dir, "progress");
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

const REVIEW = "/Users/dev/.rvw/reviews/app-main-feature-1700000000000.reviewer.json";
const OTHER = "/Users/dev/.rvw/reviews/api-main-fix-1700000000001.reviewer.json";

function progress(overrides: Partial<ReadProgress> = {}): ReadProgress {
  return {
    readFiles: { "src/a.ts": "modified::aaa..bbb", "src/b.ts": "added::..ccc" },
    collapsedFiles: ["src/a.ts"],
    readTotal: 7,
    ...overrides,
  };
}

/** Put arbitrary bytes where a given review's record belongs — the only way to stage the
 * damaged, hand-edited, and from-the-future records the store has to survive. */
function writeRaw(dir: string, artifactPath: string, bytes: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, progressFileName(artifactPath));
  writeFileSync(file, bytes, "utf8");
  return file;
}

describe("createProgressStore", () => {
  it("round-trips a review's marks, folds, and denominator", async () => {
    const store = createProgressStore(makeDir());
    await store.write(REVIEW, progress());
    expect(await store.read(REVIEW)).toEqual(progress());
  });

  it("creates its directory on first write rather than requiring one to exist", async () => {
    const dir = makeDir();
    expect(existsSync(dir)).toBe(false);
    const store = createProgressStore(dir);
    await store.write(REVIEW, progress());
    expect(existsSync(join(dir, progressFileName(REVIEW)))).toBe(true);
  });

  it("answers no progress for a review nobody has read", async () => {
    const store = createProgressStore(makeDir());
    expect(await store.read(REVIEW)).toEqual(NO_PROGRESS);
  });

  it("keys by path, so one review's progress is never another's", async () => {
    const store = createProgressStore(makeDir());
    await store.write(REVIEW, progress({ readTotal: 7 }));
    await store.write(OTHER, progress({ readFiles: {}, collapsedFiles: [], readTotal: 2 }));

    expect((await store.read(REVIEW)).readTotal).toBe(7);
    expect((await store.read(OTHER)).readTotal).toBe(2);
  });

  it("reads a damaged record as no progress, and leaves it exactly where it is", async () => {
    const dir = makeDir();
    const file = writeRaw(dir, REVIEW, "{ this is not json");
    const store = createProgressStore(dir);

    expect(await store.read(REVIEW)).toEqual(NO_PROGRESS);
    // Never deleted on a failed read: it is the only copy, and the build that can read it may
    // be the next one. Only a reader generating real progress may overwrite it.
    expect(readFileSync(file, "utf8")).toBe("{ this is not json");
  });

  it("reads a record from a format this build predates as no progress, and leaves it alone", async () => {
    const dir = makeDir();
    const file = writeRaw(
      dir,
      REVIEW,
      JSON.stringify({ version: 99, path: REVIEW, somethingNew: true }),
    );
    const store = createProgressStore(dir);

    expect(await store.read(REVIEW)).toEqual(NO_PROGRESS);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 99 });
  });

  it("a broken record costs that review's progress and no other's", async () => {
    const dir = makeDir();
    const store = createProgressStore(dir);
    await store.write(OTHER, progress({ readTotal: 4 }));
    writeRaw(dir, REVIEW, "corrupt");

    // The whole reason for one file per review: separate records fail separately.
    expect(await store.read(REVIEW)).toEqual(NO_PROGRESS);
    expect((await store.read(OTHER)).readTotal).toBe(4);
  });

  it("skips a write that would not move the marks", async () => {
    const dir = makeDir();
    const store = createProgressStore(dir);
    await store.write(REVIEW, progress());
    const first = readFileSync(join(dir, progressFileName(REVIEW)), "utf8");

    // Every session mutation — a scroll, a file selection — comes through the same write-back
    // that carries progress. Rewriting the record for each of those would have a reader
    // scrolling a long diff rewrite this file continuously.
    await store.write(REVIEW, progress());
    expect(readFileSync(join(dir, progressFileName(REVIEW)), "utf8")).toBe(first);

    // A real change still lands.
    await store.write(REVIEW, progress({ readTotal: 9 }));
    expect((await store.read(REVIEW)).readTotal).toBe(9);
  });

  it("summarizes a list, counting read files and carrying the cached denominator", async () => {
    const store = createProgressStore(makeDir());
    await store.write(REVIEW, progress());

    const summaries = await store.summaries([REVIEW, OTHER]);
    // `read` is counted from the marks rather than stored beside them, so the ratio and the
    // marks can never disagree; only the denominator is remembered.
    expect(summaries.get(REVIEW)).toEqual({ read: 2, total: 7 });
    // A review with no record still gets an entry — an empty one, which the caller reads as
    // "not started" and renders as nothing.
    expect(summaries.get(OTHER)).toEqual({ read: 0, total: 0 });
  });

  it("prunes records whose review is gone, and keeps the ones whose review is not", async () => {
    const dir = makeDir();
    const store = createProgressStore(dir);
    await store.write(REVIEW, progress());
    await store.write(OTHER, progress());

    await store.prune(new Set([progressFileName(REVIEW)]));

    expect(await store.read(REVIEW)).toEqual(progress());
    expect(await store.read(OTHER)).toEqual(NO_PROGRESS);
    expect(existsSync(join(dir, progressFileName(OTHER)))).toBe(false);
  });

  it("a pruned review that comes back is written afresh, not skipped as unchanged", async () => {
    const dir = makeDir();
    const store = createProgressStore(dir);
    await store.write(REVIEW, progress());
    await store.prune(new Set());

    // The skip-unchanged cache has to forget what it pruned, or a review whose record was
    // swept would silently never be written again in this session.
    await store.write(REVIEW, progress());
    expect(await store.read(REVIEW)).toEqual(progress());
  });

  it("pruning a directory that is not there is a no-op, not a failure", async () => {
    const store = createProgressStore(makeDir());
    await expect(store.prune(new Set())).resolves.toBeUndefined();
  });
});
