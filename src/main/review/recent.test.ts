import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_PROGRESS } from "../../shared/review-progress";
import { reviewsDir } from "../../shared/reviews-dir";
import { createProgressStore, type ProgressStore } from "./progress";
import { listRecentReviews, RECENT_MAX, summarizeArtifact } from "./recent";

// The picker's data source, against real directories. The interesting cases here are all the
// ones a reviews folder acquires by being a folder on someone's disk rather than a database:
// files that are not artifacts, files that vanish, files that are too big to read, a folder
// that is not there at all — none of which may take the list down or, worse, quietly report
// the same "no reviews yet" a fresh install shows.

let tempDirs: string[] = [];

/** A throwaway RVW_HOME. The list is asked for through `reviewsDir`, so pointing the env at a
 * temp root proves the app looks exactly where the CLI writes rather than proving a path this
 * test made up. */
function makeHome(): { home: string; env: NodeJS.ProcessEnv; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "reviewer-recent-"));
  tempDirs.push(home);
  const env = { RVW_HOME: join(home, "rvw") } as NodeJS.ProcessEnv;
  const dir = reviewsDir(env, home);
  mkdirSync(dir, { recursive: true });
  return { home, env, dir };
}

/** A real progress store, in its own corner of the same temp home — the app keeps this
 * directory well away from the artifacts (it is userData, not `~/.rvw/reviews`), and these
 * tests keep the same separation so nothing here can accidentally list its own bookkeeping as
 * a review. Real rather than a stub: the listing is the only caller that reads records in
 * bulk, so it should be reading them the way the app does. */
function progressIn(home: string): ProgressStore {
  return createProgressStore(join(home, "progress"));
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function artifact(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    repo: "/work/my-repo",
    base: "main",
    head: "feature",
    overview: { title: "The change", body: "why it is shaped this way" },
    comments: [{ file: "a.ts", side: "additions", startLine: 1, endLine: 1, body: "here" }],
    layers: [
      { label: "One", ranges: [{ file: "a.ts", side: "additions", startLine: 1, endLine: 1 }] },
    ],
    ...overrides,
  });
}

/** Write an artifact with a stated mtime, so ordering is asserted against a fact rather than
 * against how fast the test happened to run. */
function write(dir: string, name: string, content: string, secondsAgo = 0): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
  return path;
}

describe("summarizeArtifact", () => {
  it("reads the handful of facts a row shows, counting nested layers as layers", () => {
    const summary = summarizeArtifact(
      artifact({
        layers: [
          {
            label: "Rollup",
            children: [
              {
                label: "Leaf",
                ranges: [{ file: "a.ts", side: "additions", startLine: 1, endLine: 1 }],
              },
            ],
          },
        ],
      }),
    );
    expect(summary).toEqual({
      repoPath: "/work/my-repo",
      repoName: "my-repo",
      base: "main",
      head: "feature",
      title: "The change",
      comments: 1,
      // The parent and its child: a reader comparing rows means sections, not top-level ones.
      layers: 2,
      portable: false,
    });
  });

  it("has no title for an artifact that carries no tour doc, rather than inventing one", () => {
    expect(summarizeArtifact(artifact({ overview: undefined }))?.title).toBeNull();
  });

  it("calls an artifact portable exactly when it carries a diff of its own", () => {
    expect(summarizeArtifact(artifact({ patch: "diff --git a/a b/a\n" }))?.portable).toBe(true);
    expect(summarizeArtifact(artifact())?.portable).toBe(false);
  });

  it("refuses anything that is not an artifact, rather than throwing on it", () => {
    expect(summarizeArtifact("}{ not json")).toBeNull();
    expect(summarizeArtifact("{}")).toBeNull();
    // A relative repo path fails `RepoPath` — the same parse the open path runs, so a file
    // this rejects is one that would not have opened either.
    expect(summarizeArtifact(artifact({ repo: "relative/path" }))).toBeNull();
  });
});

describe("listRecentReviews", () => {
  it("lists the directory newest first, with each artifact's own facts", async () => {
    const { env, home, dir } = makeHome();
    write(dir, "old.reviewer.json", artifact({ overview: { title: "Older", body: "b" } }), 600);
    write(dir, "new.reviewer.json", artifact({ overview: { title: "Newer", body: "b" } }), 10);

    const result = await listRecentReviews(progressIn(home), env, home);
    expect(result.dir).toBe(dir);
    expect(result.unreadable).toBe(false);
    expect(result.truncated).toBe(0);
    expect(result.reviews.map((review) => review.summary?.title)).toEqual(["Newer", "Older"]);
    expect(result.reviews[0]?.path).toBe(join(dir, "new.reviewer.json"));
    expect(Date.parse(result.reviews[0]?.modified ?? "")).not.toBeNaN();
  });

  it("ignores everything in the folder that is not a .reviewer.json", async () => {
    const { env, home, dir } = makeHome();
    write(dir, "real.reviewer.json", artifact());
    write(dir, "notes.json", artifact());
    write(dir, "README.md", "# hello");
    mkdirSync(join(dir, "nested.reviewer.json"));

    const result = await listRecentReviews(progressIn(home), env, home);
    expect(result.reviews.map((review) => review.path)).toEqual([join(dir, "real.reviewer.json")]);
  });

  it("lists a file that is named like an artifact and is not one, marked unreadable", async () => {
    // Hiding it would be the worse failure: a reader who knows they emitted a review and
    // cannot find it here has no way to learn that the file is broken.
    const { env, home, dir } = makeHome();
    write(dir, "broken.reviewer.json", "}{ truncated mid-write");

    const result = await listRecentReviews(progressIn(home), env, home);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]?.summary).toBeNull();
    expect(result.reviews[0]?.path).toBe(join(dir, "broken.reviewer.json"));
  });

  it("follows a symlinked artifact, which is a real way to keep a review around", async () => {
    const { env, home, dir } = makeHome();
    const target = write(dir, "target.reviewer.json", artifact(), 5);
    symlinkSync(target, join(dir, "link.reviewer.json"));

    const result = await listRecentReviews(progressIn(home), env, home);
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews.every((review) => review.summary !== null)).toBe(true);
  });

  it("answers with an empty list — not a fault — when the directory has never been created", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-recent-none-"));
    tempDirs.push(home);
    const env = { RVW_HOME: join(home, "rvw") } as NodeJS.ProcessEnv;

    const result = await listRecentReviews(progressIn(home), env, home);
    expect(result.reviews).toEqual([]);
    // The distinction the empty state reads: nothing here yet, versus something is wrong.
    expect(result.unreadable).toBe(false);
    expect(result.dir).toBe(reviewsDir(env, home));
  });

  it("says so when the directory is there and will not open", async () => {
    const { env, home, dir } = makeHome();
    // A file where the directory should be: `readdir` fails with ENOTDIR, which is not the
    // ENOENT that means "never emitted" and must not be reported as it.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory");

    const result = await listRecentReviews(progressIn(home), env, home);
    expect(result.reviews).toEqual([]);
    expect(result.unreadable).toBe(true);
  });

  it("carries each artifact's progress, and nothing for a review nobody has started", async () => {
    const { env, home, dir } = makeHome();
    write(
      dir,
      "started.reviewer.json",
      artifact({ overview: { title: "Started", body: "b" } }),
      10,
    );
    write(dir, "fresh.reviewer.json", artifact({ overview: { title: "Fresh", body: "b" } }), 20);
    const progress = progressIn(home);
    await progress.write(join(dir, "started.reviewer.json"), {
      readFiles: { "src/a.ts": "modified::aaa..bbb", "src/b.ts": "added::..ccc" },
      collapsedFiles: [],
      readTotal: 9,
    });

    const result = await listRecentReviews(progress, env, home);
    const byTitle = new Map(result.reviews.map((review) => [review.summary?.title, review]));
    expect(byTitle.get("Started")?.progress).toEqual({ read: 2, total: 9 });
    // Null rather than a zeroed ratio: a row for a review nobody has opened draws no glyph,
    // and saying so once here keeps both surfaces that render a row from deciding separately.
    expect(byTitle.get("Fresh")?.progress).toBeNull();
  });

  it("sweeps progress for a review that is no longer in the directory", async () => {
    const { env, home, dir } = makeHome();
    write(dir, "kept.reviewer.json", artifact(), 10);
    const progress = progressIn(home);
    const gone = join(dir, "deleted.reviewer.json");
    await progress.write(gone, { readFiles: { "a.ts": "s" }, collapsedFiles: [], readTotal: 1 });
    await progress.write(join(dir, "kept.reviewer.json"), {
      readFiles: { "a.ts": "s" },
      collapsedFiles: [],
      readTotal: 1,
    });

    await listRecentReviews(progress, env, home);

    // The listing is the one pass that knows the whole artifact directory, so it is the one
    // place an orphan can be recognized. Fire-and-forget, hence the poll rather than an await.
    await vi.waitFor(async () => {
      expect(await progress.read(gone)).toEqual(NO_PROGRESS);
    });
    expect((await progress.read(join(dir, "kept.reviewer.json"))).readTotal).toBe(1);
  });

  it("keeps progress for a review pushed past the cap — it is still on disk", async () => {
    const { env, home, dir } = makeHome();
    for (let index = 0; index < RECENT_MAX + 1; index++) {
      write(dir, `r${index}.reviewer.json`, artifact(), index * 60);
    }
    const progress = progressIn(home);
    const dropped = join(dir, `r${RECENT_MAX}.reviewer.json`);
    await progress.write(dropped, { readFiles: { "a.ts": "s" }, collapsedFiles: [], readTotal: 3 });

    const result = await listRecentReviews(progress, env, home);
    expect(result.truncated).toBe(1);

    // The sweep runs over every artifact found, not the capped page: sweeping a review's
    // progress because the list happened to be long would be silent data loss.
    await vi.waitFor(async () => {
      expect((await progress.read(dropped)).readTotal).toBe(3);
    });
  });

  it("caps the list at the newest RECENT_MAX and reports what it dropped", async () => {
    const { env, home, dir } = makeHome();
    const count = RECENT_MAX + 3;
    for (let index = 0; index < count; index++) {
      // Oldest last: index 0 is the newest, so the three dropped must be the final three.
      write(dir, `r${index}.reviewer.json`, artifact(), index * 60);
    }

    const result = await listRecentReviews(progressIn(home), env, home);
    expect(result.reviews).toHaveLength(RECENT_MAX);
    expect(result.truncated).toBe(3);
    // Sorted over the whole directory and *then* capped: the newest is still first, which
    // would not hold if the cap were applied to whatever `readdir` returned first.
    expect(result.reviews[0]?.path).toBe(join(dir, "r0.reviewer.json"));
    expect(result.reviews.map((review) => review.path)).not.toContain(
      join(dir, `r${count - 1}.reviewer.json`),
    );
  });
});
