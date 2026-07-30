import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImportedReview } from "../../shared/review";
import { NO_PROGRESS, type ReadProgress } from "../../shared/review-progress";
import type { Session } from "../../shared/session";
import { createGitRunner } from "../git/runner";
import type { SessionStore } from "../sessions";
import type { ProgressStore } from "./progress";

// dialog/drop answer through the invoke; here we drive the two exported entry
// functions directly against a spy store. electron is mocked only so the module
// (which imports BrowserWindow/dialog for the dialog path) loads under vitest.
// git is real: the repo an artifact names is checked by an actual
// `rev-parse --show-toplevel` against fixture directories, so a test that passes
// is a repo git itself accepted, not one a stub agreed to.
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: (): null => null },
  dialog: { showOpenDialog: vi.fn() },
}));

const { openReviewFromPath, importReviewSessionFromArg } = await import("./handlers");

const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const runner = createGitRunner();

let root: string;
/** A real work tree — the only repo an artifact is allowed to name. */
let repo: string;
/** A plain directory standing in for the hostile target (`~/.ssh` and friends). */
let secrets: string;

beforeAll(() => {
  // realpath because macOS tmpdir is symlinked (/var → /private/var) and
  // `rev-parse --show-toplevel` reports the physical path.
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-handlers-")));

  repo = join(root, "app");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, env: FIXTURE_ENV, stdio: "ignore" });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");

  secrets = join(root, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "id_rsa"), "PRIVATE KEY\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let reviewFiles: string[] = [];

afterEach(() => {
  for (const path of reviewFiles) {
    rmSync(path, { force: true });
  }
  reviewFiles = [];
});

const CREATED_ID = "33333333-3333-4333-8333-333333333333";
/** The session a dedupe check finds, distinct from CREATED_ID so a test cannot pass by
 * accidentally creating one. */
const OPEN_ID = "44444444-4444-4444-8444-444444444444";

/** A well-formed artifact whose only variable is the repo it claims — the field
 * its author chose, and the one under test. */
function artifactFor(repoPath: string): string {
  return JSON.stringify({
    repo: repoPath,
    base: "main",
    head: "a".repeat(40),
    comments: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1, body: "hi" }],
    layers: [],
  });
}

/** A store recording createFromReview, and answering `findByReviewPath` from whatever these
 * entries have already opened — the dedupe check runs on every open, so a store that always
 * says "not open" could not exercise the second one. */
function spyStore(open: readonly Session[] = []): {
  store: SessionStore;
  createFromReview: ReturnType<typeof vi.fn>;
} {
  const createFromReview = vi.fn(
    (review: ImportedReview, opened: { path: string; progress: ReadProgress }): Session => ({
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
      reviewPath: opened.path,
      ...opened.progress,
    }),
  );
  const store: SessionStore = {
    list: vi.fn(),
    create: vi.fn(),
    createFromReview,
    findByReviewPath: (path) => open.find((session) => session.reviewPath === path) ?? null,
    update: vi.fn(),
    delete: vi.fn(),
    setActive: vi.fn(),
    reorder: vi.fn(),
    flush: vi.fn(),
  };
  return { store, createFromReview };
}

/** A progress store with nothing recorded — the state every one of these opens starts from.
 * `progress.ts` owns the reading and writing; these tests only need it to be present. */
function emptyProgress(): ProgressStore {
  return {
    read: () => Promise.resolve(NO_PROGRESS),
    write: () => Promise.resolve(),
    summaries: () => Promise.resolve(new Map()),
    prune: () => Promise.resolve(),
  };
}

function writeReview(name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content, "utf8");
  reviewFiles.push(path);
  return path;
}

describe("openReviewFromPath", () => {
  it("creates a session and answers opened with its id for a valid path", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.reviewer.json", artifactFor(repo));

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: CREATED_ID, created: true },
    });
    expect(createFromReview).toHaveBeenCalledTimes(1);
  });

  it("seats the session on the work-tree toplevel, not the path the artifact named", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("sub.reviewer.json", artifactFor(join(repo, "src")));

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: CREATED_ID, created: true },
    });
    expect(createFromReview.mock.calls[0]?.[0].repo).toEqual({ path: repo, name: basename(repo) });
  });

  it("refuses an artifact naming a directory that is not a git work tree", async () => {
    // The C1 case: the artifact's author picks the repo, so a review pointing at
    // ~/.ssh would otherwise make those files readable through git:file-contents.
    const { store, createFromReview } = spyStore();
    const path = writeReview("hostile.reviewer.json", artifactFor(secrets));

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({
      ok: false,
      failure: { code: "repoUnavailable", reason: { code: "notARepo", path: secrets } },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("refuses an artifact naming a git directory, which has no work tree to read", async () => {
    const { store, createFromReview } = spyStore();
    const gitDir = join(repo, ".git");
    const path = writeReview("gitdir.reviewer.json", artifactFor(gitDir));

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({
      ok: false,
      failure: { code: "repoUnavailable", reason: { code: "notARepo", path: gitDir } },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("refuses an artifact naming a path that does not exist", async () => {
    const { store, createFromReview } = spyStore();
    const missing = join(root, "gone");
    const path = writeReview("missing.reviewer.json", artifactFor(missing));

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({
      ok: false,
      failure: { code: "repoUnavailable", reason: { code: "notARepo", path: missing } },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("refuses an artifact naming a file rather than a directory", async () => {
    // A file cannot be a spawn cwd at all (the runner refuses it before spawn,
    // where node would throw synchronously) — so this must be a typed failure.
    const { store, createFromReview } = spyStore();
    const file = join(secrets, "id_rsa");
    const path = writeReview("file.reviewer.json", artifactFor(file));

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({
      ok: false,
      failure: { code: "repoUnavailable", reason: { code: "notARepo", path: file } },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("rejects a wrong extension without importing (no session created)", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.txt", artifactFor(repo));

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({ ok: false, failure: { code: "wrongExtension" } });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("surfaces invalidContent for a malformed artifact without creating a session", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("bad.reviewer.json", "{ nope");

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({ ok: false, failure: { code: "invalidContent" } });
    expect(createFromReview).not.toHaveBeenCalled();
  });
});

describe("one tab per artifact", () => {
  /** A session that is already open on `path` — what `findByReviewPath` will match. */
  function openOn(path: string): Session {
    return {
      id: OPEN_ID,
      source: { kind: "local", repo: { path: repo, name: basename(repo) } },
      base: null,
      head: null,
      commitSelection: null,
      selectedFilePath: null,
      scrollTop: 0,
      comments: [],
      layers: [],
      overview: null,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
      reviewPath: path,
      ...NO_PROGRESS,
    };
  }

  it("answers with the open session, and creates nothing, for a review already open", async () => {
    const path = writeReview("dupe.reviewer.json", artifactFor(repo));
    const { store, createFromReview } = spyStore([openOn(path)]);

    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    // Two tabs over one review would each hold their own marks and each write the same
    // progress record, so whichever was closed last would silently win.
    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: OPEN_ID, created: false },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("matches through a symlink, so a link and its target are one tab", async () => {
    const path = writeReview("real.reviewer.json", artifactFor(repo));
    const link = join(root, "link.reviewer.json");
    symlinkSync(path, link);
    reviewFiles.push(link);
    const { store, createFromReview } = spyStore([openOn(realpathSync(path))]);

    const response = await openReviewFromPath(runner, store, emptyProgress(), link);

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: OPEN_ID, created: false },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("still refuses a path that is not a review, rather than deduping it", async () => {
    const path = writeReview("x.txt", artifactFor(repo));
    const { store } = spyStore([openOn(path)]);

    // The dedupe check sits *after* the guard: a bad path fails exactly the way it always did.
    const response = await openReviewFromPath(runner, store, emptyProgress(), path);

    expect(response).toEqual({ ok: false, failure: { code: "wrongExtension" } });
  });

  it("seeds a newly opened review with the progress already recorded against it", async () => {
    const path = writeReview("resume.reviewer.json", artifactFor(repo));
    const { store, createFromReview } = spyStore();
    const recorded = {
      readFiles: { "src/a.ts": "modified::aaa..bbb" },
      collapsedFiles: ["src/a.ts"],
      readTotal: 5,
    };
    const progress: ProgressStore = { ...emptyProgress(), read: () => Promise.resolve(recorded) };

    await openReviewFromPath(runner, store, progress, path);

    // Closing a tab and reopening the review resumes rather than restarts: the session
    // arrives already carrying where its reader stopped, keyed on the path it was read from.
    expect(createFromReview).toHaveBeenCalledWith(expect.anything(), {
      path: realpathSync(path),
      progress: recorded,
    });
  });
});

describe("importReviewSessionFromArg", () => {
  it("returns the created session for a valid launch arg", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.reviewer.json", artifactFor(repo));

    const session = await importReviewSessionFromArg(runner, store, emptyProgress(), path);

    expect(session?.id).toBe(CREATED_ID);
    expect(createFromReview).toHaveBeenCalledTimes(1);
  });

  it("returns null (no session, logged) for a bad launch arg", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.txt", artifactFor(repo));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const session = await importReviewSessionFromArg(runner, store, emptyProgress(), path);

    expect(session).toBeNull();
    expect(createFromReview).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns null for a launch arg whose artifact names a non-repo", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("hostile.reviewer.json", artifactFor(secrets));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const session = await importReviewSessionFromArg(runner, store, emptyProgress(), path);

    expect(session).toBeNull();
    expect(createFromReview).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
