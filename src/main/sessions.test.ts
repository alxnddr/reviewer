import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportedReview } from "../shared/review";
import { SessionStoreFile, type Session, type SessionSource } from "../shared/session";
import { createSessionStore } from "./sessions";
import { flushSessionsThenTerminateGit } from "./shutdown";

let tempDirs: string[] = [];

function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-sessions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function storeFilePath(dir: string): string {
  return join(dir, "sessions.json");
}

function readStoreFile(dir: string): SessionStoreFile {
  return SessionStoreFile.parse(JSON.parse(readFileSync(storeFilePath(dir), "utf8")));
}

function localSource(path: string): SessionSource {
  return { kind: "local", repo: { path, name: "repo" } };
}

function persistedSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    source: localSource("/repos/a"),
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
    ...overrides,
  };
}

function writeEnvelope(dir: string, envelope: unknown): void {
  writeFileSync(storeFilePath(dir), JSON.stringify(envelope));
}

describe("createSessionStore", () => {
  it("round-trips create → update → list through a real store file", () => {
    const dir = makeStoreDir();
    const first = createSessionStore({ directory: dir });

    const created = first.create(localSource("/repos/a"));
    // Both modes' inputs at once: a restart must hand back the branch pair AND
    // the SHA-anchored brush, whatever mode is driving.
    const mutated: Session = {
      ...created,
      base: "main",
      head: "feature/tabs",
      commitSelection: { kind: "commitRange", first: "a".repeat(40), last: "b".repeat(40) },
      selectedFilePath: "src/app.ts",
      scrollTop: 1234.5,
    };
    first.update(mutated);
    first.flush();

    const reopened = createSessionStore({ directory: dir });
    expect(reopened.list()).toEqual({ sessions: [mutated], activeSessionId: created.id });
  });

  it("creates an active session from an imported review, carrying its comments and layers", () => {
    const dir = makeStoreDir();
    const store = createSessionStore({ directory: dir });
    const review: ImportedReview = {
      repo: { path: "/repos/app", name: "app" },
      base: "main",
      head: "a".repeat(40),
      patch: null,
      overview: null,
      comments: [
        {
          file: "src/a.ts",
          side: "additions",
          startLine: 1,
          endLine: 1,
          body: "hi",
          id: "11111111-1111-4111-8111-111111111111",
        },
      ],
      layers: [{ id: "l1", label: "Layer", summary: "s", ranges: [] }],
    };

    const created = store.createFromReview(review);
    store.flush();

    // The review's repo becomes the session source; comments and layers ride along.
    expect(created.source).toEqual({ kind: "local", repo: { path: "/repos/app", name: "app" } });
    expect(created.comments).toEqual(review.comments);
    expect(created.layers).toEqual(review.layers);
    // No embedded patch → the authored `base..head` is pinned as a refs diff
    // so the opened session reproduces the diff the anchors were written against,
    // without touching the branch/commit pickers (they stay at their null defaults).
    expect(created.reviewDiff).toEqual({ kind: "refs", base: "main", head: "a".repeat(40) });
    expect(created.base).toBeNull();
    expect(created.commitSelection).toBeNull();
    expect(store.list()).toEqual({ sessions: [created], activeSessionId: created.id });
    expect(readStoreFile(dir).sessions).toEqual([created]);
  });

  it("pins an embedded-patch review as a frozen diff, not its base..head refs", () => {
    const dir = makeStoreDir();
    const store = createSessionStore({ directory: dir });
    const review: ImportedReview = {
      repo: { path: "/repos/app", name: "app" },
      base: "main",
      head: "a".repeat(40),
      patch: "diff --git a/src/a.ts b/src/a.ts\n",
      overview: null,
      comments: [],
      layers: [],
    };

    const created = store.createFromReview(review);
    store.flush();

    // The embedded patch freezes the diff: it is pinned verbatim so every
    // anchor places, taking precedence over the re-derivable refs.
    expect(created.reviewDiff).toEqual({
      kind: "frozenPatch",
      patch: "diff --git a/src/a.ts b/src/a.ts\n",
    });
    expect(readStoreFile(dir).sessions).toEqual([created]);
  });

  it("yields an empty session list from a corrupt store file and recovers on the next write", () => {
    const dir = makeStoreDir();
    writeFileSync(storeFilePath(dir), "{garbage");

    const store = createSessionStore({ directory: dir });
    expect(store.list()).toEqual({ sessions: [], activeSessionId: null });

    const created = store.create(localSource("/repos/a"));
    store.flush();
    expect(readStoreFile(dir)).toEqual({
      version: 2,
      sessions: [created],
      activeSessionId: created.id,
    });
  });

  it("restores exactly the valid sessions from an envelope holding one invalid one", () => {
    const dir = makeStoreDir();
    const valid = persistedSession({ source: localSource("/repos/a") });
    const alsoValid = persistedSession({ source: localSource("/repos/b") });
    // A relative repo path fails the RepoPath schema — identity damage, dropped.
    const invalid = persistedSession({ source: localSource("not/absolute") });
    writeEnvelope(dir, {
      version: 1,
      sessions: [valid, invalid, alsoValid],
      activeSessionId: valid.id,
    });

    const store = createSessionStore({ directory: dir });
    expect(store.list()).toEqual({ sessions: [valid, alsoValid], activeSessionId: valid.id });
  });

  it("nulls the active id when it points at a session that was dropped on load", () => {
    const dir = makeStoreDir();
    const valid = persistedSession();
    const invalid = persistedSession({ source: localSource("not/absolute") });
    writeEnvelope(dir, { version: 1, sessions: [valid, invalid], activeSessionId: invalid.id });

    const store = createSessionStore({ directory: dir });
    expect(store.list()).toEqual({ sessions: [valid], activeSessionId: null });
  });

  it("rejects a persisted ref that smuggles a flag, before any spawn can see it", () => {
    const dir = makeStoreDir();
    const flagRef = persistedSession({
      base: "--upload-pack=/tmp/evil",
      head: "main",
    });
    const revExpression = persistedSession({
      source: localSource("/repos/b"),
      commitSelection: { kind: "commitRange", first: "HEAD~1", last: "HEAD" },
    });
    writeEnvelope(dir, {
      version: 1,
      sessions: [flagRef, revExpression],
      activeSessionId: flagRef.id,
    });

    const store = createSessionStore({ directory: dir });
    // The sessions survive and untampered fields keep their values; the
    // tampered refs are absent, so nothing ref-shaped is left to ever hand to
    // a git spawn.
    expect(store.list()).toEqual({
      sessions: [
        { ...flagRef, base: null },
        { ...revExpression, commitSelection: null },
      ],
      activeSessionId: flagRef.id,
    });
  });

  it("flushes an update from inside the debounce window before git children terminate", () => {
    const dir = makeStoreDir();
    const store = createSessionStore({ directory: dir, writeDebounceMs: 60_000 });
    const created = store.create(localSource("/repos/a"));
    store.flush();

    const mutated: Session = { ...created, scrollTop: 777 };
    store.update(mutated);
    // Still inside the debounce window: the disk copy predates the update.
    expect(readStoreFile(dir).sessions).toEqual([created]);

    let onDiskAtTermination: SessionStoreFile | null = null;
    const gitRunner = {
      // Reading the file here proves the ordering: with the flush after (or
      // missing), the store file would still hold the pre-update state.
      terminateAll: (): void => {
        onDiskAtTermination = readStoreFile(dir);
      },
    };
    flushSessionsThenTerminateGit(store, gitRunner);

    expect(onDiskAtTermination).toEqual({
      version: 2,
      sessions: [mutated],
      activeSessionId: created.id,
    });
  });

  it("sets a newer-version envelope aside instead of clobbering it", () => {
    const dir = makeStoreDir();
    const futureEnvelope = { version: 3, sessions: [persistedSession()], activeSessionId: null };
    writeEnvelope(dir, futureEnvelope);

    const store = createSessionStore({ directory: dir });
    expect(store.list()).toEqual({ sessions: [], activeSessionId: null });

    const created = store.create(localSource("/repos/a"));
    store.flush();
    // The fresh write landed in a new file; the future build's data survives.
    expect(readStoreFile(dir).sessions).toEqual([created]);
    expect(JSON.parse(readFileSync(`${storeFilePath(dir)}.newer`, "utf8"))).toEqual(futureEnvelope);
  });

  it("migrates a v1 store file, defaulting comments and layers to empty", () => {
    const dir = makeStoreDir();
    const id = randomUUID();
    // A genuine v1 session predates the review fields — they are simply absent.
    const v1Session = {
      id,
      source: localSource("/repos/a"),
      base: null,
      head: null,
      commitSelection: null,
      selectedFilePath: null,
      scrollTop: 0,
    };
    writeEnvelope(dir, { version: 1, sessions: [v1Session], activeSessionId: id });

    const store = createSessionStore({ directory: dir });
    const migrated: Session = {
      ...v1Session,
      comments: [],
      layers: [],
      overview: null,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
    };
    expect(store.list()).toEqual({ sessions: [migrated], activeSessionId: id });

    // The v1 literal is superseded, not left beside v2: the next write rewrites
    // the whole file under the current envelope.
    store.update({ ...migrated, scrollTop: 12 });
    store.flush();
    expect(readStoreFile(dir).version).toBe(2);
  });

  it("salvages a session with garbage comments to empty, keeping identity and siblings", () => {
    const dir = makeStoreDir();
    const healthy = persistedSession({ source: localSource("/repos/a") });
    const damaged = persistedSession({ source: localSource("/repos/b"), scrollTop: 42 });
    writeEnvelope(dir, {
      version: 2,
      sessions: [healthy, { ...damaged, comments: "not-an-array" }],
      activeSessionId: damaged.id,
    });

    const store = createSessionStore({ directory: dir });
    // The neighbour is untouched, the damaged session keeps its id/source and
    // every valid view field, and only the broken comments reset to [].
    expect(store.list()).toEqual({
      sessions: [healthy, { ...damaged, comments: [] }],
      activeSessionId: damaged.id,
    });
  });

  it("salvages a session whose comments array holds a malformed comment, never blocking startup", () => {
    const dir = makeStoreDir();
    const damaged = persistedSession({ source: localSource("/repos/b"), scrollTop: 42 });
    // A comment missing its body (schema requires a non-empty one) — corrupt
    // element inside an otherwise well-formed array. The field resets to [] per
    // the view-state salvage tier rather than dropping the whole session.
    writeEnvelope(dir, {
      version: 2,
      sessions: [
        {
          ...damaged,
          comments: [
            {
              file: "a.ts",
              side: "additions",
              startLine: 1,
              endLine: 1,
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            },
          ],
        },
      ],
      activeSessionId: damaged.id,
    });

    const store = createSessionStore({ directory: dir });
    expect(store.list()).toEqual({
      sessions: [{ ...damaged, comments: [] }],
      activeSessionId: damaged.id,
    });
  });

  it("drops a duplicated session id on load", () => {
    const dir = makeStoreDir();
    const session = persistedSession();
    writeEnvelope(dir, { version: 1, sessions: [session, session], activeSessionId: null });

    const store = createSessionStore({ directory: dir });
    expect(store.list()).toEqual({ sessions: [session], activeSessionId: null });
  });

  it("ignores an update for an unknown id (stale write-back after close)", () => {
    const dir = makeStoreDir();
    const store = createSessionStore({ directory: dir });
    const created = store.create(localSource("/repos/a"));

    store.update(persistedSession({ source: localSource("/repos/ghost") }));
    store.flush();
    expect(readStoreFile(dir).sessions).toEqual([created]);
  });

  it("nulls the active id when the active session is deleted", () => {
    const dir = makeStoreDir();
    const store = createSessionStore({ directory: dir });
    const kept = store.create(localSource("/repos/a"));
    const active = store.create(localSource("/repos/b"));

    store.delete(active.id);
    expect(store.list()).toEqual({ sessions: [kept], activeSessionId: null });
    store.flush();
    expect(readStoreFile(dir)).toEqual({ version: 2, sessions: [kept], activeSessionId: null });

    store.setActive(kept.id);
    expect(store.list().activeSessionId).toBe(kept.id);
  });

  it("ignores setActive for an unknown id", () => {
    const dir = makeStoreDir();
    const store = createSessionStore({ directory: dir });
    const created = store.create(localSource("/repos/a"));

    store.setActive(randomUUID());
    expect(store.list().activeSessionId).toBe(created.id);
  });

  it("does not write a file when flushing with nothing pending", () => {
    const dir = makeStoreDir();
    const store = createSessionStore({ directory: dir });

    store.flush();
    expect(existsSync(storeFilePath(dir))).toBe(false);
  });
});
