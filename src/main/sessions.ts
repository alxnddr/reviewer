import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import Store from "electron-store";
import * as z from "zod";
import { BranchName, CommitSelection } from "../shared/git";
import {
  Comment,
  ReviewDiff,
  ReviewLayer,
  ReviewOrigin,
  reviewDiffFor,
  reviewOriginFor,
  type ImportedReview,
} from "../shared/review";
import {
  SelectionMode,
  Session,
  SessionStoreFile,
  type SessionId,
  type SessionSnapshot,
  type SessionSource,
} from "../shared/session";

// Session store: memory is authoritative, disk is a debounced copy. Reads (list)
// always answer from memory and never fail; writes apply to memory first and
// persist best-effort (a failed disk write is logged, never surfaced as an IPC
// rejection). The on-disk file is untrusted input — load salvages what re-passes
// the shared schemas and drops the rest.

export type SessionStoreOptions = {
  /** Overrides electron-store's userData default; tests point it at a temp dir. */
  directory?: string;
  writeDebounceMs?: number;
};

export type SessionStore = {
  list: () => SessionSnapshot;
  create: (source: SessionSource) => Session;
  /** An opened `.reviewer.json` as a new active session: the review's repo becomes
   * the source; its comments/layers ride along; and its authored diff is pinned so
   * the opened session reproduces the diff the anchors were written against — the
   * embedded patch when present, else the `base..head` refs. */
  createFromReview: (review: ImportedReview) => Session;
  update: (session: Session) => void;
  delete: (id: SessionId) => void;
  setActive: (id: SessionId) => void;
  /** Persists a pending debounced write now; used by the will-quit path. */
  flush: () => void;
};

/** Batches bursts of write-backs into one atomic disk write; the trailing edge
 * is guaranteed by flush() on quit. */
const DEFAULT_WRITE_DEBOUNCE_MS = 500;

const CURRENT_VERSION = 2;

const EMPTY_STORE: SessionStoreFile = {
  version: CURRENT_VERSION,
  sessions: [],
  activeSessionId: null,
};

/** The envelope pre-parse: a readable version (v1 or the current v2) and the
 * array shape only, so one bad session can't take down its neighbours. A future
 * version this build can't read safely is handled separately (NewerEnvelope). */
const RawEnvelope = z.object({
  version: z.union([z.literal(1), z.literal(CURRENT_VERSION)]),
  sessions: z.array(z.unknown()),
  activeSessionId: z.unknown(),
});
type StoreVersion = z.infer<typeof RawEnvelope>["version"];

/** A well-formed envelope from a schema this build predates. */
const NewerEnvelope = z.object({ version: z.number().int().gt(CURRENT_VERSION) });

/** Load-time salvage tier: identity (id, source) stays strict — without it the
 * session is meaningless — while tampered view state degrades per field to the
 * same defaults create() uses. A ref that fails the git schemas becomes null
 * here, so it can never travel back out toward a spawn. */
const SessionWithViewStateSalvage = z.object({
  id: Session.shape.id,
  source: Session.shape.source,
  mode: SelectionMode.catch("commits"),
  base: BranchName.nullable().catch(null),
  head: BranchName.nullable().catch(null),
  commitSelection: CommitSelection.nullable().catch(null),
  selectedFilePath: z.string().min(1).nullable().catch(null),
  scrollTop: z.number().finite().nonnegative().catch(0),
  comments: z.array(Comment).catch([]),
  layers: z.array(ReviewLayer).catch([]),
  reviewDiff: ReviewDiff.nullable().catch(null),
  reviewSubrange: CommitSelection.nullable().catch(null),
  reviewOrigin: ReviewOrigin.nullable().catch(null),
});

/** v1 sessions predate `comments`/`layers`; supplying empties lets a clean v1
 * session parse strictly (a schema bump, not view-state corruption) rather than
 * be logged as reset. Real fields win — an existing key is never overwritten. */
function migrateRawSession(raw: unknown, version: StoreVersion): unknown {
  if (version === CURRENT_VERSION || typeof raw !== "object" || raw === null) {
    return raw;
  }
  return { comments: [], layers: [], ...raw };
}

/** A fresh session's inputs at creation defaults; `comments`/`layers`/`reviewDiff`/
 * `reviewOrigin` are the only fields an open path seeds (a repo open passes empties
 * + nulls, a review open its imported content, pinned diff, and authored origin). */
function buildSession(
  source: SessionSource,
  comments: Comment[],
  layers: ReviewLayer[],
  reviewDiff: ReviewDiff | null,
  reviewOrigin: ReviewOrigin | null,
): Session {
  return {
    id: randomUUID(),
    source,
    mode: "commits",
    base: null,
    head: null,
    commitSelection: null,
    selectedFilePath: null,
    scrollTop: 0,
    comments,
    layers,
    reviewDiff,
    reviewSubrange: null,
    reviewOrigin,
  };
}

function salvageSessions(rawSessions: unknown[], version: StoreVersion): Session[] {
  const sessions: Session[] = [];
  const seenIds = new Set<SessionId>();
  for (const rawSession of rawSessions) {
    const raw = migrateRawSession(rawSession, version);
    const strict = Session.safeParse(raw);
    const salvaged = strict.success ? strict : SessionWithViewStateSalvage.safeParse(raw);
    if (!salvaged.success) {
      console.error("Persisted session dropped: failed validation on load");
      continue;
    }
    if (seenIds.has(salvaged.data.id)) {
      console.error(`Persisted session dropped: duplicate id ${salvaged.data.id}`);
      continue;
    }
    if (!strict.success) {
      console.error(`Persisted session ${salvaged.data.id}: invalid view state reset on load`);
    }
    seenIds.add(salvaged.data.id);
    sessions.push(salvaged.data);
  }
  return sessions;
}

function salvageEnvelope(raw: unknown): SessionStoreFile {
  const envelope = RawEnvelope.safeParse(raw);
  if (!envelope.success) {
    // A fresh (or corruption-cleared) store reads as {} — that is the normal
    // first-run path, not damage worth logging.
    if (typeof raw !== "object" || raw === null || Object.keys(raw).length > 0) {
      console.error("Session store file unusable, starting empty");
    }
    return EMPTY_STORE;
  }
  const sessions = salvageSessions(envelope.data.sessions, envelope.data.version);
  const active = Session.shape.id.safeParse(envelope.data.activeSessionId);
  const activeSessionId =
    active.success && sessions.some((session) => session.id === active.data) ? active.data : null;
  return { version: CURRENT_VERSION, sessions, activeSessionId };
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  // clearInvalidConfig makes electron-store answer {} for corrupt JSON instead
  // of throwing; the try/catch covers everything else (permissions, …) because
  // a broken store file must never block startup.
  const disk = new Store<SessionStoreFile>({
    name: "sessions",
    clearInvalidConfig: true,
    ...(options.directory === undefined ? {} : { cwd: options.directory }),
  });
  const writeDebounceMs = options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;

  let state: SessionStoreFile;
  try {
    const raw: unknown = disk.store;
    const newer = NewerEnvelope.safeParse(raw);
    if (newer.success) {
      // A future schema owns this data; this build can't read it and must not
      // clobber it on the next write — set it aside for the newer build.
      console.error(`Session store is schema version ${newer.data.version}; setting it aside`);
      renameSync(disk.path, `${disk.path}.newer`);
      state = EMPTY_STORE;
    } else {
      state = salvageEnvelope(raw);
    }
  } catch (error) {
    console.error("Session store unreadable, starting empty:", error);
    state = EMPTY_STORE;
  }

  let pendingWrite: ReturnType<typeof setTimeout> | null = null;

  function persistNow(): void {
    pendingWrite = null;
    try {
      disk.store = state;
    } catch (error) {
      console.error("Session store could not be persisted:", error);
    }
  }

  function schedulePersist(): void {
    if (pendingWrite !== null) {
      return;
    }
    // unref: the timer must never hold the process open — quit durability comes
    // from the will-quit flush, not from this best-effort background write.
    pendingWrite = setTimeout(persistNow, writeDebounceMs);
    pendingWrite.unref();
  }

  // A newly opened project/review is what the user is looking at — insertion
  // activates it and schedules the debounced persist.
  function addSession(session: Session): Session {
    state = {
      ...state,
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    };
    schedulePersist();
    return session;
  }

  return {
    list: () => ({ sessions: state.sessions, activeSessionId: state.activeSessionId }),

    create: (source) => addSession(buildSession(source, [], [], null, null)),

    createFromReview: (review) =>
      addSession(
        buildSession(
          { kind: "local", repo: review.source.repo },
          review.comments,
          review.layers,
          reviewDiffFor(review),
          reviewOriginFor(review),
        ),
      ),

    update: (session) => {
      const index = state.sessions.findIndex((existing) => existing.id === session.id);
      if (index === -1) {
        // A debounced write-back racing a tab close lands here by design — stale,
        // not exceptional, so it is dropped without noise.
        return;
      }
      const sessions = [...state.sessions];
      sessions[index] = session;
      state = { ...state, sessions };
      schedulePersist();
    },

    delete: (id) => {
      const sessions = state.sessions.filter((existing) => existing.id !== id);
      if (sessions.length === state.sessions.length) {
        return;
      }
      // Which tab focuses next is renderer policy; main only keeps the
      // invariant that activeSessionId points at a live session or nothing.
      state = {
        ...state,
        sessions,
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
      };
      schedulePersist();
    },

    setActive: (id) => {
      if (state.activeSessionId === id || !state.sessions.some((existing) => existing.id === id)) {
        return;
      }
      state = { ...state, activeSessionId: id };
      schedulePersist();
    },

    flush: () => {
      if (pendingWrite === null) {
        return;
      }
      clearTimeout(pendingWrite);
      persistNow();
    },
  };
}
