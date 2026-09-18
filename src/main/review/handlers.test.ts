import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewOriginFor, type ImportedReview } from "../../shared/review";
import { NO_PROGRESS } from "../../shared/review-progress";
import type { Session } from "../../shared/session";
import { getDiff } from "../git/ops";
import { createGitRunner } from "../git/runner";
import { createSessionStore, type SessionStore } from "../sessions";
import type { ReviewOpenRequest } from "./guard";
import type { ReviewOpenDeps } from "./handlers";
import type { ProgressStore } from "./progress";
import type { RepoRelocations } from "./relocations";
import { repinReviewSessions } from "./source";

// dialog/drop answer through the invoke; here we drive the exported entry functions directly
// against a spy store. electron is mocked only so the module (which imports BrowserWindow/dialog
// for the dialog paths) loads under vitest — and so Locate Repository…'s picker can be answered.
// git is real: the repo an artifact names is checked by an actual `rev-parse --show-toplevel`,
// its refs by `rev-parse --verify`, and an embedded patch against the diff the app itself derives,
// all against fixture directories — so a test that passes is a repo git itself accepted, not one
// a stub agreed to.
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: (): null => null },
  dialog: { showOpenDialog: vi.fn() },
}));

const { dialog } = await import("electron");
const { openReviewFromPath, importReviewSessionFromArg, locateReviewRepo } =
  await import("./handlers");

const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

const runner = createGitRunner();

let root: string;
/** A real work tree — the only repo an artifact is allowed to name. */
let repo: string;
/** A second work tree with a history of its own: a repository, but not this review's. */
let stranger: string;
/** A plain directory standing in for the hostile target (`~/.ssh` and friends). */
let secrets: string;
/** The two commits every artifact below reviews: `base` adds `src/a.ts`, `head` changes it. */
let base: string;
let head: string;
/** The diff the app itself derives for `base...head` — what an `--embed-patch` artifact carries,
 * captured through the same runner the open path checks with, so the two cannot disagree over a
 * git config this machine happens to have. */
let patch: string;

/** Where the review was written — a box path that does not exist on this machine. */
const BOX_REPO = "/home/box/src/app";
const MISSING_SHA = "c".repeat(40);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" }).trim();
}

function initRepo(path: string, contents: string): void {
  mkdirSync(join(path, "src"), { recursive: true });
  git(path, "init", "-b", "main");
  writeFileSync(join(path, "src", "a.ts"), contents);
  git(path, "add", ".");
  git(path, "commit", "-m", "add a");
}

beforeAll(async () => {
  // realpath because macOS tmpdir is symlinked (/var → /private/var) and
  // `rev-parse --show-toplevel` reports the physical path.
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-handlers-")));

  repo = join(root, "app");
  initRepo(repo, "export const a = 1;\n");
  base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  git(repo, "commit", "-am", "change a");
  head = git(repo, "rev-parse", "HEAD");
  const derived = await getDiff(runner, repo, { kind: "reviewRefs", base, head });
  if (!derived.ok || derived.value.patch.length === 0) {
    throw new Error("the fixture's own diff could not be taken");
  }
  patch = derived.value.patch;

  stranger = join(root, "stranger");
  initRepo(stranger, "export const b = 1;\n");

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
  vi.mocked(dialog.showOpenDialog).mockReset();
});

const CREATED_ID = "33333333-3333-4333-8333-333333333333";
/** The session a dedupe check finds, distinct from CREATED_ID so a test cannot pass by
 * accidentally creating one. */
const OPEN_ID = "44444444-4444-4444-8444-444444444444";

/** A well-formed artifact reviewing `base...head` of the repo it claims — the field its author
 * chose, and the one most of these are about. `extra` overrides the rest: a patch, a ref. */
function artifactFor(repoPath: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    repo: repoPath,
    base,
    head,
    comments: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1, body: "hi" }],
    layers: [],
    ...extra,
  });
}

type Opened = Parameters<SessionStore["createFromReview"]>[1];

/** A store that keeps what it is given: `createFromReview` adds, `update` replaces, and the
 * dedupe lookup and `list` answer from both — the open path reads back what it wrote (a re-seat
 * finds the session a dedupe matched), so a store that always said "not open" could not
 * exercise it. */
function spyStore(initial: readonly Session[] = []): {
  store: SessionStore;
  createFromReview: ReturnType<typeof vi.fn<SessionStore["createFromReview"]>>;
  update: ReturnType<typeof vi.fn<SessionStore["update"]>>;
} {
  let sessions = [...initial];
  const createFromReview = vi.fn((review: ImportedReview, opened: Opened): Session => {
    const session: Session = {
      id: CREATED_ID,
      source: { kind: "local", repo: opened.repo },
      base: null,
      head: null,
      commitSelection: null,
      selectedFilePath: null,
      scrollTop: 0,
      comments: review.comments,
      layers: review.layers,
      overview: review.overview,
      reviewDiff: opened.reviewDiff,
      reviewSubrange: null,
      reviewOrigin: reviewOriginFor(review),
      reviewPath: opened.path,
      ...opened.progress,
    };
    sessions = [...sessions, session];
    return session;
  });
  const update = vi.fn((session: Session): void => {
    sessions = sessions.map((existing) => (existing.id === session.id ? session : existing));
  });
  const store: SessionStore = {
    list: () => ({ sessions, activeSessionId: null }),
    create: vi.fn(),
    createFromReview,
    findByReviewPath: (path) => sessions.find((session) => session.reviewPath === path) ?? null,
    update,
    delete: vi.fn(),
    setActive: vi.fn(),
    reorder: vi.fn(),
    flush: vi.fn(),
  };
  return { store, createFromReview, update };
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

/** Relocations as a plain map: what the store-backed ones keep, without the disk. */
function memoryRelocations(
  initial: Record<string, string> = {},
): RepoRelocations & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    get: (authored) => entries.get(authored) ?? null,
    remember: (authored, local) => {
      entries.set(authored, local);
    },
    forget: (authored) => {
      entries.delete(authored);
    },
  };
}

function depsFor(store: SessionStore, overrides: Partial<ReviewOpenDeps> = {}): ReviewOpenDeps {
  return {
    runner,
    store,
    progress: emptyProgress(),
    relocations: memoryRelocations(),
    ...overrides,
  };
}

function open(path: string, repoPath: string | null = null): ReviewOpenRequest {
  return { path, repo: repoPath };
}

function writeReview(name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content, "utf8");
  reviewFiles.push(path);
  return path;
}

/** The directory the next Locate Repository… picker answers with. */
function pickNext(directory: string | null): void {
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce(
    directory === null
      ? { canceled: true, filePaths: [] }
      : { canceled: false, filePaths: [directory] },
  );
}

describe("openReviewFromPath", () => {
  it("creates a session and answers opened with its id for a valid path", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.reviewer.json", artifactFor(repo));

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: CREATED_ID, created: true },
    });
    expect(createFromReview).toHaveBeenCalledTimes(1);
    expect(createFromReview.mock.calls[0]?.[1].reviewDiff).toEqual({ kind: "refs", base, head });
  });

  it("seats the session on the work-tree toplevel, and keeps the path the artifact named as its origin", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("sub.reviewer.json", artifactFor(join(repo, "src")));

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: CREATED_ID, created: true },
    });
    expect(createFromReview.mock.calls[0]?.[1].repo).toEqual({ path: repo, name: basename(repo) });
    // The origin is what an export re-emits, so it stays exactly what was authored.
    expect(createFromReview.mock.calls[0]?.[0].repo.path).toBe(join(repo, "src"));
  });

  it("refuses an artifact naming a directory that is not a git work tree", async () => {
    // The C1 case: the artifact's author picks the repo, so a review pointing at
    // ~/.ssh would otherwise make those files readable through git:file-contents.
    const { store, createFromReview } = spyStore();
    const path = writeReview("hostile.reviewer.json", artifactFor(secrets));

    const response = await openReviewFromPath(depsFor(store), open(path));

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

    const response = await openReviewFromPath(depsFor(store), open(path));

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

    const response = await openReviewFromPath(depsFor(store), open(path));

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

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({
      ok: false,
      failure: { code: "repoUnavailable", reason: { code: "notARepo", path: file } },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("refuses a refs-only artifact whose head this checkout does not have, naming it", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("unfetched.reviewer.json", artifactFor(repo, { head: MISSING_SHA }));

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({
      ok: false,
      failure: { code: "refsUnavailable", missing: [MISSING_SHA] },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("rejects a wrong extension without importing (no session created)", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.txt", artifactFor(repo));

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({ ok: false, failure: { code: "wrongExtension" } });
    expect(createFromReview).not.toHaveBeenCalled();
  });

  it("surfaces invalidContent for a malformed artifact without creating a session", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("bad.reviewer.json", "{ nope");

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({
      ok: false,
      failure: { code: "invalidContent", reason: expect.stringContaining("JSON") },
    });
    expect(createFromReview).not.toHaveBeenCalled();
  });
});

describe("a review that carries its own diff", () => {
  it("opens off its patch alone when the repo it names is not on this machine", async () => {
    // The `--embed-patch` handoff: written on a box, read where the box's path means nothing.
    // Nothing about rendering a frozen patch touches the repo, so the repo must not be asked for.
    const { store, createFromReview } = spyStore();
    const path = writeReview("frozen.reviewer.json", artifactFor(BOX_REPO, { patch }));

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: CREATED_ID, created: true },
    });
    const opened = createFromReview.mock.calls[0]?.[1];
    expect(opened?.reviewDiff).toEqual({ kind: "frozenPatch", patch });
    // Carried as authored, unvalidated — and unread: nothing git-backed runs on a frozen pin.
    expect(opened?.repo.path).toBe(BOX_REPO);
  });

  it("goes live beside a checkout whose refs reproduce the patch it carries", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("pulled.reviewer.json", artifactFor(repo, { patch }));

    await openReviewFromPath(depsFor(store), open(path));

    const opened = createFromReview.mock.calls[0]?.[1];
    expect(opened?.reviewDiff).toEqual({ kind: "refs", base, head });
    expect(opened?.repo.path).toBe(repo);
  });

  it("opens frozen, not failed, when this checkout lacks its head", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview(
      "behind.reviewer.json",
      artifactFor(repo, { patch, head: MISSING_SHA }),
    );

    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response.ok).toBe(true);
    const opened = createFromReview.mock.calls[0]?.[1];
    expect(opened?.reviewDiff).toEqual({ kind: "frozenPatch", patch });
    // The repo *is* here and validated, so it is the one the session sits on.
    expect(opened?.repo.path).toBe(repo);
  });

  it("stays frozen when its refs resolve but spell a different diff than its patch", async () => {
    // The app's own working-tree export: `base === head`, with the uncommitted diff embedded.
    // Both refs resolve, and rendering them live would show an empty diff under every anchor.
    const { store, createFromReview } = spyStore();
    const path = writeReview("worktree.reviewer.json", artifactFor(repo, { patch, base: head }));

    await openReviewFromPath(depsFor(store), open(path));

    expect(createFromReview.mock.calls[0]?.[1].reviewDiff).toEqual({ kind: "frozenPatch", patch });
  });
});

describe("relocating a review's repository", () => {
  it("reads an artifact against the checkout `rvw open --repo` handed over, and remembers it", async () => {
    const { store } = spyStore();
    const relocations = memoryRelocations();
    const path = writeReview("box.reviewer.json", artifactFor(BOX_REPO));

    const session = await importReviewSessionFromArg(
      depsFor(store, { relocations }),
      open(path, join(repo, "src")),
    );

    expect(session?.reviewDiff).toEqual({ kind: "refs", base, head });
    expect(session?.source.repo.path).toBe(repo);
    // Remembered as the toplevel, for the authored path — so every review of this checkout
    // opens live from here on, not only this one.
    expect(relocations.entries.get(BOX_REPO)).toBe(repo);
  });

  it("opens live from a remembered checkout with nothing handed over", async () => {
    const { store, createFromReview } = spyStore();
    const relocations = memoryRelocations({ [BOX_REPO]: repo });
    const path = writeReview("again.reviewer.json", artifactFor(BOX_REPO, { patch }));

    await openReviewFromPath(depsFor(store, { relocations }), open(path));

    const opened = createFromReview.mock.calls[0]?.[1];
    expect(opened?.reviewDiff).toEqual({ kind: "refs", base, head });
    expect(opened?.repo.path).toBe(repo);
  });

  it("forgets a remembered checkout that is no longer a repository", async () => {
    const { store, createFromReview } = spyStore();
    const relocations = memoryRelocations({ [BOX_REPO]: secrets });
    const path = writeReview("stale.reviewer.json", artifactFor(BOX_REPO, { patch }));

    await openReviewFromPath(depsFor(store, { relocations }), open(path));

    expect(createFromReview.mock.calls[0]?.[1].reviewDiff).toEqual({ kind: "frozenPatch", patch });
    expect(relocations.entries.has(BOX_REPO)).toBe(false);
  });

  it("keeps a remembered checkout that only lacks the commits so far", async () => {
    // A worktree waiting on a fetch is still where the repo lives.
    const { store } = spyStore();
    const relocations = memoryRelocations({ [BOX_REPO]: repo });
    const path = writeReview(
      "unfetched.reviewer.json",
      artifactFor(BOX_REPO, { patch, head: MISSING_SHA }),
    );

    await openReviewFromPath(depsFor(store, { relocations }), open(path));

    expect(relocations.entries.get(BOX_REPO)).toBe(repo);
  });

  it("does not remember a handed-over path that did not make the review live", async () => {
    const { store } = spyStore();
    const relocations = memoryRelocations();
    const path = writeReview("wrong.reviewer.json", artifactFor(BOX_REPO, { patch }));

    const session = await importReviewSessionFromArg(
      depsFor(store, { relocations }),
      open(path, stranger),
    );

    expect(session?.reviewDiff).toEqual({ kind: "frozenPatch", patch });
    expect(relocations.entries.size).toBe(0);
  });

  it("re-seats a review already open when `rvw open --repo` names its checkout", async () => {
    const { store, createFromReview, update } = spyStore();
    const deps = depsFor(store);
    const path = writeReview("reopen.reviewer.json", artifactFor(BOX_REPO, { patch }));
    await openReviewFromPath(deps, open(path));

    const session = await importReviewSessionFromArg(deps, open(path, repo));

    expect(createFromReview).toHaveBeenCalledTimes(1);
    expect(session?.id).toBe(CREATED_ID);
    expect(session?.reviewDiff).toEqual({ kind: "refs", base, head });
    expect(update).toHaveBeenCalledWith(session);
  });
});

describe("locateReviewRepo", () => {
  async function openFrozen(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<{
    deps: ReviewOpenDeps;
    store: SessionStore;
    relocations: RepoRelocations & { entries: Map<string, string> };
  }> {
    const { store } = spyStore();
    const relocations = memoryRelocations();
    const deps = depsFor(store, { relocations });
    const path = writeReview(name, artifactFor(BOX_REPO, { patch, ...extra }));
    await openReviewFromPath(deps, open(path));
    return { deps, store, relocations };
  }

  function stored(store: SessionStore): Session | undefined {
    return store.list().sessions.find((session) => session.id === CREATED_ID);
  }

  it("re-seats an open frozen review on the picked checkout, and remembers it", async () => {
    const { deps, store, relocations } = await openFrozen("locate.reviewer.json");
    pickNext(repo);

    const response = await locateReviewRepo(deps, { kind: "session", sessionId: CREATED_ID });

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: CREATED_ID, created: false },
    });
    expect(stored(store)?.reviewDiff).toEqual({ kind: "refs", base, head });
    expect(stored(store)?.source.repo.path).toBe(repo);
    expect(relocations.entries.get(BOX_REPO)).toBe(repo);
  });

  it("reports a picked directory that is not a repository, and the review stays frozen", async () => {
    const { deps, store, relocations } = await openFrozen("not-a-repo.reviewer.json");
    pickNext(secrets);

    const response = await locateReviewRepo(deps, { kind: "session", sessionId: CREATED_ID });

    expect(response).toEqual({
      ok: false,
      failure: { code: "repoUnavailable", reason: { code: "notARepo", path: secrets } },
    });
    expect(stored(store)?.reviewDiff).toEqual({ kind: "frozenPatch", patch });
    expect(relocations.entries.size).toBe(0);
  });

  it("reports a repository that does not have the review's commits", async () => {
    const { deps, store } = await openFrozen("stranger.reviewer.json");
    pickNext(stranger);

    const response = await locateReviewRepo(deps, { kind: "session", sessionId: CREATED_ID });

    expect(response).toEqual({
      ok: false,
      failure: { code: "refsUnavailable", missing: [base, head] },
    });
    expect(stored(store)?.reviewDiff?.kind).toBe("frozenPatch");
  });

  it("reports a checkout whose refs spell a different diff than the review carries", async () => {
    const { deps, store } = await openFrozen("moved.reviewer.json", { base: head });
    pickNext(repo);

    const response = await locateReviewRepo(deps, { kind: "session", sessionId: CREATED_ID });

    expect(response).toEqual({ ok: false, failure: { code: "patchMismatch" } });
    expect(stored(store)?.reviewDiff?.kind).toBe("frozenPatch");
  });

  it("changes nothing on a dismissed picker, or for a review that is not open", async () => {
    const { deps, store } = await openFrozen("dismissed.reviewer.json");
    pickNext(null);

    expect(await locateReviewRepo(deps, { kind: "session", sessionId: CREATED_ID })).toEqual({
      ok: true,
      value: { kind: "canceled" },
    });
    expect(stored(store)?.reviewDiff?.kind).toBe("frozenPatch");
    // A closed tab asks nothing: the picker is never shown for it.
    expect(await locateReviewRepo(deps, { kind: "session", sessionId: OPEN_ID })).toEqual({
      ok: true,
      value: { kind: "canceled" },
    });
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it("opens an artifact that could not open, against the picked checkout", async () => {
    const { store, createFromReview } = spyStore();
    const deps = depsFor(store);
    const path = writeReview("refs-only.reviewer.json", artifactFor(BOX_REPO));
    expect((await openReviewFromPath(deps, open(path))).ok).toBe(false);
    pickNext(repo);

    const response = await locateReviewRepo(deps, { kind: "artifact", path });

    expect(response).toEqual({
      ok: true,
      value: { kind: "opened", sessionId: CREATED_ID, created: true },
    });
    expect(createFromReview.mock.calls[0]?.[1].reviewDiff).toEqual({ kind: "refs", base, head });
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

    const response = await openReviewFromPath(depsFor(store), open(path));

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

    const response = await openReviewFromPath(depsFor(store), open(link));

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
    const response = await openReviewFromPath(depsFor(store), open(path));

    expect(response).toEqual({ ok: false, failure: { code: "wrongExtension" } });
  });

  it("seeds a newly opened review with the progress already recorded against it", async () => {
    const path = writeReview("resume.reviewer.json", artifactFor(repo));
    const { store, createFromReview } = spyStore();
    const recorded = {
      readFiles: { "src/a.ts": "modified::aaa..bbb" },
      collapsedFiles: ["src/a.ts"],
      foldsSeeded: true,
      readTotal: 5,
      resolvedComments: {},
    };
    const progress: ProgressStore = { ...emptyProgress(), read: () => Promise.resolve(recorded) };

    await openReviewFromPath(depsFor(store, { progress }), open(path));

    // Closing a tab and reopening the review resumes rather than restarts: the session
    // arrives already carrying where its reader stopped, keyed on the path it was read from.
    expect(createFromReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: realpathSync(path), progress: recorded }),
    );
  });
});

describe("importReviewSessionFromArg", () => {
  it("returns the created session for a valid launch arg", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.reviewer.json", artifactFor(repo));

    const session = await importReviewSessionFromArg(depsFor(store), open(path));

    expect(session?.id).toBe(CREATED_ID);
    expect(createFromReview).toHaveBeenCalledTimes(1);
  });

  it("returns null (no session, logged) for a bad launch arg", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("x.txt", artifactFor(repo));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const session = await importReviewSessionFromArg(depsFor(store), open(path));

    expect(session).toBeNull();
    expect(createFromReview).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns null for a launch arg whose artifact names a non-repo", async () => {
    const { store, createFromReview } = spyStore();
    const path = writeReview("hostile.reviewer.json", artifactFor(secrets));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const session = await importReviewSessionFromArg(depsFor(store), open(path));

    expect(session).toBeNull();
    expect(createFromReview).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("repinReviewSessions", () => {
  // Against the real session store: the re-pin reads the list, spawns git, then writes back
  // through `update`, and the claim is about what a relaunch finds on disk-backed state.
  let storeDirs: string[] = [];

  afterEach(() => {
    for (const dir of storeDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    storeDirs = [];
  });

  function realStore(): SessionStore {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-repin-"));
    storeDirs.push(dir);
    return createSessionStore({ directory: dir, writeDebounceMs: 0 });
  }

  function reviewOf(repoPath: string, extra: Partial<ImportedReview> = {}): ImportedReview {
    return {
      repo: { path: repoPath, name: basename(repoPath) },
      base,
      head,
      patch,
      reviewedHead: null,
      overview: null,
      comments: [],
      layers: [],
      ...extra,
    };
  }

  it("thaws a review opened frozen once its repo and refs are on this machine", async () => {
    const store = realStore();
    const created = store.createFromReview(reviewOf(repo), {
      path: "/reviews/thaw.reviewer.json",
      progress: NO_PROGRESS,
      repo: { path: repo, name: basename(repo) },
      reviewDiff: { kind: "frozenPatch", patch },
    });

    await repinReviewSessions({ runner, store, relocations: memoryRelocations() });

    const [session] = store.list().sessions;
    expect(session?.id).toBe(created.id);
    expect(session?.reviewDiff).toEqual({ kind: "refs", base, head });
  });

  it("thaws through a remembered relocation when the authored path is not here", async () => {
    const store = realStore();
    store.createFromReview(reviewOf(BOX_REPO), {
      path: "/reviews/box.reviewer.json",
      progress: NO_PROGRESS,
      repo: { path: BOX_REPO, name: "app" },
      reviewDiff: { kind: "frozenPatch", patch },
    });

    await repinReviewSessions({
      runner,
      store,
      relocations: memoryRelocations({ [BOX_REPO]: repo }),
    });

    const [session] = store.list().sessions;
    expect(session?.reviewDiff).toEqual({ kind: "refs", base, head });
    expect(session?.source.repo.path).toBe(repo);
    expect(session?.reviewOrigin?.repo.path).toBe(BOX_REPO);
  });

  it("freezes a live review whose head is gone, dropping a subrange it can no longer narrow", async () => {
    const store = realStore();
    const created = store.createFromReview(reviewOf(repo, { head: MISSING_SHA }), {
      path: "/reviews/gone.reviewer.json",
      progress: NO_PROGRESS,
      repo: { path: repo, name: basename(repo) },
      reviewDiff: { kind: "refs", base, head: MISSING_SHA },
    });
    store.update({
      ...created,
      reviewSubrange: { kind: "commitRange", first: base, last: base },
    });

    await repinReviewSessions({ runner, store, relocations: memoryRelocations() });

    const [session] = store.list().sessions;
    expect(session?.reviewDiff).toEqual({ kind: "frozenPatch", patch });
    expect(session?.reviewSubrange).toBeNull();
  });

  it("leaves a refs-only review alone, even with its repo gone", async () => {
    const store = realStore();
    const created = store.createFromReview(reviewOf(BOX_REPO, { patch: null }), {
      path: "/reviews/refs.reviewer.json",
      progress: NO_PROGRESS,
      repo: { path: BOX_REPO, name: "app" },
      reviewDiff: { kind: "refs", base, head },
    });

    await repinReviewSessions({ runner, store, relocations: memoryRelocations() });

    expect(store.list().sessions).toEqual([created]);
  });
});
