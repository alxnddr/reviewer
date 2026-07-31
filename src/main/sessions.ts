import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import Store from "electron-store";
import * as z from "zod";
import { createDebouncer } from "../shared/debounce";
import { BranchName, CommitSelection } from "../shared/git";
import {
  Comment,
  ReviewDiff,
  ReviewLayer,
  ReviewOrigin,
  ReviewOverview,
  reviewDiffFor,
  reviewOriginFor,
  type ImportedReview,
} from "../shared/review";
import { NO_PROGRESS, ReadProgress } from "../shared/review-progress";
import {
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
   * embedded patch when present, else the `base..head` refs.
   *
   * `opened` carries what the artifact could not: the path it was read from, which is this
   * session's identity for both tab dedupe and progress, and whatever progress was already
   * recorded against that path — so a review whose tab was closed reopens where it stopped. */
  createFromReview: (
    review: ImportedReview,
    opened: { path: string; progress: ReadProgress },
  ) => Session;
  /** The live session opened from `path`, if there is one. The dedupe lookup: one tab per
   * artifact, so two tabs can never fight over one review's progress record. */
  findByReviewPath: (path: string) => Session | null;
  update: (session: Session) => void;
  delete: (id: SessionId) => void;
  setActive: (id: SessionId) => void;
  /** Re-seats the persisted array to the tab strip's order after a drag. */
  reorder: (ids: SessionId[]) => void;
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
  base: BranchName.nullable().catch(null),
  head: BranchName.nullable().catch(null),
  commitSelection: CommitSelection.nullable().catch(null),
  selectedFilePath: z.string().min(1).nullable().catch(null),
  scrollTop: z.number().finite().nonnegative().catch(0),
  comments: z.array(Comment).catch([]),
  layers: z.array(ReviewLayer).catch([]),
  overview: ReviewOverview.nullable().catch(null),
  reviewDiff: ReviewDiff.nullable().catch(null),
  reviewSubrange: CommitSelection.nullable().catch(null),
  reviewOrigin: ReviewOrigin.nullable().catch(null),
  reviewPath: z.string().min(1).nullable().catch(null),
  // Progress degrades to "unread" rather than taking the session down with it: a reader who
  // loses their place has lost a convenience, and dropping the whole tab to protect it would
  // cost them the review.
  readFiles: ReadProgress.shape.readFiles.catch({}),
  collapsedFiles: ReadProgress.shape.collapsedFiles.catch([]),
  readTotal: ReadProgress.shape.readTotal.catch(0),
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

/** The review content an open path seeds a fresh session with — everything a session
 * cannot derive from git. Passed as one value rather than a positional run of arrays
 * and nulls, so adding a field (the tour `overview`) can't silently shift a caller's
 * arguments. A repo open seeds `EMPTY_REVIEW_SEED`; a review open seeds its imported
 * content, pinned diff, and authored origin. */
type ReviewSeed = {
  comments: Comment[];
  layers: ReviewLayer[];
  overview: ReviewOverview | null;
  reviewDiff: ReviewDiff | null;
  reviewOrigin: ReviewOrigin | null;
  /** The artifact's path, and the progress already recorded against it — read from the
   * artifact-scoped store by the open path, so a review reopened after its tab was closed
   * arrives already carrying where its reader stopped. */
  reviewPath: string | null;
  progress: ReadProgress;
};

const EMPTY_REVIEW_SEED: ReviewSeed = {
  comments: [],
  layers: [],
  overview: null,
  reviewDiff: null,
  reviewOrigin: null,
  reviewPath: null,
  progress: NO_PROGRESS,
};

/** A fresh session: git-derived state starts at the creation defaults, and the seed
 * carries whatever review content the open path brought with it. */
function buildSession(source: SessionSource, seed: ReviewSeed): Session {
  return {
    id: randomUUID(),
    source,
    base: null,
    head: null,
    commitSelection: null,
    selectedFilePath: null,
    scrollTop: 0,
    comments: seed.comments,
    layers: seed.layers,
    overview: seed.overview,
    reviewDiff: seed.reviewDiff,
    reviewSubrange: null,
    reviewOrigin: seed.reviewOrigin,
    reviewPath: seed.reviewPath,
    ...seed.progress,
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

  function persistNow(): void {
    try {
      disk.store = state;
    } catch (error) {
      console.error("Session store could not be persisted:", error);
    }
  }

  // unref: the timer must never hold the process open — quit durability comes
  // from the will-quit flush, not from this best-effort background write.
  const writeDebouncer = createDebouncer({
    delayMs: writeDebounceMs,
    onFire: persistNow,
    unref: true,
  });

  function schedulePersist(): void {
    writeDebouncer.notify();
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

    create: (source) => addSession(buildSession(source, EMPTY_REVIEW_SEED)),

    createFromReview: (review, opened) =>
      addSession(
        buildSession(
          { kind: "local", repo: review.repo },
          {
            comments: review.comments,
            layers: review.layers,
            overview: review.overview,
            reviewDiff: reviewDiffFor(review),
            reviewOrigin: reviewOriginFor(review),
            reviewPath: opened.path,
            progress: opened.progress,
          },
        ),
      ),

    findByReviewPath: (path) =>
      state.sessions.find((session) => session.reviewPath === path) ?? null,

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

    reorder: (ids) => {
      // The renderer names an order; main still owns the membership. Sessions are
      // taken in the order given, then anything the request didn't mention is
      // appended in its existing order — a tab opened between the drag starting
      // and this arriving is kept rather than silently dropped.
      const byId = new Map(state.sessions.map((session) => [session.id, session]));
      const reordered: Session[] = [];
      for (const id of ids) {
        const session = byId.get(id);
        if (session !== undefined) {
          reordered.push(session);
          byId.delete(id);
        }
      }
      for (const session of state.sessions) {
        if (byId.has(session.id)) {
          reordered.push(session);
        }
      }
      state = { ...state, sessions: reordered };
      schedulePersist();
    },

    flush: () => writeDebouncer.flush(),
  };
}
