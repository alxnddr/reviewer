import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportedReview } from "../../shared/review";
import type { Session } from "../../shared/session";
import type { SessionStore } from "../sessions";

// dialog/drop answer through the invoke; here we drive the two exported entry
// functions directly against a spy store. electron is mocked only so the module
// (which imports BrowserWindow/dialog for the dialog path) loads under vitest.
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: (): null => null },
  dialog: { showOpenDialog: vi.fn() },
}));

const { openReviewFromPath, importReviewSessionFromArg } = await import("./handlers");

let tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-handlers-"));
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
  comments: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1, body: "hi" }],
  layers: [],
});

const CREATED_ID = "33333333-3333-4333-8333-333333333333";

/** A store recording createFromReview: the only method these entries touch. */
function spyStore(): { store: SessionStore; createFromReview: ReturnType<typeof vi.fn> } {
  const createFromReview = vi.fn(
    (review: ImportedReview): Session => ({
      id: CREATED_ID,
      source: { kind: "local", repo: review.repo },
      base: null,
      head: null,
      commitSelection: null,
      selectedFilePath: null,
      scrollTop: 0,
      comments: review.comments,
      layers: review.layers,
      overview: review.overview,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
    }),
  );
  const store: SessionStore = {
    list: vi.fn(),
    create: vi.fn(),
    createFromReview,
    update: vi.fn(),
    delete: vi.fn(),
    setActive: vi.fn(),
    reorder: vi.fn(),
    flush: vi.fn(),
  };
  return { store, createFromReview };
}

function writeReview(name: string, content: string): string {
  const path = join(makeDir(), name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("openReviewFromPath", () => {
  it("creates a session and answers opened with its id for a valid path", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.reviewer.json", VALID_ARTIFACT);

    const response = await openReviewFromPath(store, path);

    expect(response).toEqual({ ok: true, value: { kind: "opened", sessionId: CREATED_ID } });
    expect(createFromReview).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong extension without importing (no session created)", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.txt", VALID_ARTIFACT);

    const response = await openReviewFromPath(store, path);

    expect(response).toEqual({ ok: false, failure: { code: "wrongExtension" } });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("surfaces invalidContent for a malformed artifact without creating a session", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("bad.reviewer.json", "{ nope");

    const response = await openReviewFromPath(store, path);

    expect(response).toEqual({ ok: false, failure: { code: "invalidContent" } });
    expect(createFromReview).not.toHaveBeenCalled();
  });
});

describe("importReviewSessionFromArg", () => {
  it("returns the created session for a valid launch arg", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.reviewer.json", VALID_ARTIFACT);

    const session = await importReviewSessionFromArg(store, path);

    expect(session?.id).toBe(CREATED_ID);
    expect(createFromReview).toHaveBeenCalledTimes(1);
  });

  it("returns null (no session, logged) for a bad launch arg", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.txt", VALID_ARTIFACT);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const session = await importReviewSessionFromArg(store, path);

    expect(session).toBeNull();
    expect(createFromReview).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
