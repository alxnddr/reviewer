import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewStamp } from "../../shared/review";
import { importReviewFromPath, REVIEW_MAX_BYTES, reviewPathFromArgv } from "./guard";

// The guard is the one seam every open path funnels through: a path — dropped,
// picked, or from argv — is untrusted until each check here has passed, and no byte
// is read until the size cap has. These prove the negatives: a bad input becomes a
// typed failure, never a crash, an unbounded read, or a parse of something the
// extension already disqualified.

let tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-guard-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

const VALID_ARTIFACT = JSON.stringify({
  repo: "/repos/app",
  base: "main",
  head: "a".repeat(40),
  comments: [
    { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12, body: "look here" },
  ],
  layers: [],
});

function fixedStamp(): ReviewStamp {
  return {
    newId: () => "11111111-1111-4111-8111-111111111111",
  };
}

function writeReview(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("importReviewFromPath", () => {
  it("returns the stamped review for a valid .reviewer.json", async () => {
    const path = writeReview(makeDir(), "x.reviewer.json", VALID_ARTIFACT);

    const result = await importReviewFromPath(path, fixedStamp());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review.comments).toHaveLength(1);
      expect(result.review.comments[0]?.id).toBe("11111111-1111-4111-8111-111111111111");
      expect(result.review.repo).toEqual({ path: "/repos/app", name: "app" });
    }
  });

  it("rejects a wrong extension before reading — valid review bytes in a .txt still fail", async () => {
    // The content IS a valid review; only the extension is wrong. wrongExtension
    // (not invalidContent/opened) proves the extension gate ran before any read
    // or parse.
    const path = writeReview(makeDir(), "x.txt", VALID_ARTIFACT);

    const result = await importReviewFromPath(path, fixedStamp());

    expect(result).toEqual({ ok: false, failure: { code: "wrongExtension" } });
  });

  it("rejects an over-cap file before reading its bytes", async () => {
    // A sparse file one byte past the cap: its bytes are all-zero (invalid JSON),
    // so tooLarge — not invalidContent — proves size was checked from stat before
    // the read. Sparse via truncate keeps the test instant.
    const path = join(makeDir(), "big.reviewer.json");
    writeFileSync(path, "");
    truncateSync(path, REVIEW_MAX_BYTES + 1);

    const result = await importReviewFromPath(path, fixedStamp());

    expect(result).toEqual({ ok: false, failure: { code: "tooLarge" } });
  });

  it("returns fileNotFound for a nonexistent path", async () => {
    const path = join(makeDir(), "missing.reviewer.json");

    const result = await importReviewFromPath(path, fixedStamp());

    expect(result).toEqual({ ok: false, failure: { code: "fileNotFound" } });
  });

  it("propagates invalidContent for a malformed .reviewer.json without throwing", async () => {
    const path = writeReview(makeDir(), "bad.reviewer.json", "{ not valid json");

    const result = await importReviewFromPath(path, fixedStamp());

    expect(result).toEqual({ ok: false, failure: { code: "invalidContent" } });
  });

  it("rejects a source ref smuggling a spawn flag as invalidContent, never a spawn", async () => {
    // A hand-tampered artifact whose `base` is a git flag, not a ref. The
    // guard never spawns git — but even reaching one is barred: the same ref schema
    // that guards a `git` child fails the parse, so the disk→guard→import path lands
    // invalidContent, exactly as a garbage or over-cap artifact does.
    const tampered = JSON.stringify({
      repo: "/repos/app",
      base: "--upload-pack=/tmp/evil",
      head: "main",
      comments: [],
      layers: [],
    });
    const path = writeReview(makeDir(), "tampered.reviewer.json", tampered);

    const result = await importReviewFromPath(path, fixedStamp());

    expect(result).toEqual({ ok: false, failure: { code: "invalidContent" } });
  });

  it("returns unreadable for a directory that carries the extension", async () => {
    const dir = makeDir();
    const path = join(dir, "adir.reviewer.json");
    mkdirSync(path);

    const result = await importReviewFromPath(path, fixedStamp());

    expect(result).toEqual({ ok: false, failure: { code: "unreadable" } });
  });
});

describe("reviewPathFromArgv", () => {
  it("resolves a relative arg against the working directory", () => {
    expect(reviewPathFromArgv(["reviewer", "sub/x.reviewer.json"], "/work")).toBe(
      resolve("/work", "sub/x.reviewer.json"),
    );
  });

  it("keeps an absolute arg as-is", () => {
    expect(reviewPathFromArgv(["reviewer", "/abs/x.reviewer.json"], "/work")).toBe(
      "/abs/x.reviewer.json",
    );
  });

  it("picks the trailing review arg past the launcher/cwd args", () => {
    expect(reviewPathFromArgv(["electron", ".", "/abs/x.reviewer.json"], "/work")).toBe(
      "/abs/x.reviewer.json",
    );
  });

  it("returns null when no arg names a review (focus-only fallback)", () => {
    expect(reviewPathFromArgv(["reviewer", "--flag"], "/work")).toBeNull();
  });
});
