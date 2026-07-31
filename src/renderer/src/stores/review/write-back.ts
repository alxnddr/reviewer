import type { StateCreator } from "zustand";
import { createDebouncer, createKeyedDebouncer } from "../../../../shared/debounce";
import type { SessionId } from "../../../../shared/session";
import { persistedSession } from "../../lib/session-projection";
import type { Getter } from "./slice";
import type { ReviewState } from "./state";

// Everything that travels back to main *debounced*, and the only state it needs is not in the
// store at all — the two debouncers live in the creator's closure, one pair per store. Every
// action in the sibling modules that changes something persisted ends by scheduling one of
// these two writes, through `get()` like any other cross-slice call — the walkthrough's
// ephemeral setters deliberately schedule nothing — and nothing here reads a slice except at
// the moment it fires.

/** Built on the shared debounce (`shared/debounce.ts`), which is also main's shape
 * (sessions.ts): the first mutation in a window schedules, later ones coalesce into the
 * same write; `flushWriteBacks` owns the trailing edge on quit. */
export const WRITE_BACK_DEBOUNCE_MS = 500;

function sendSessionWriteBack(get: Getter, sessionId: SessionId): void {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined) {
    return;
  }
  void bridge.updateSession(persistedSession(slice));
}

function sendActiveWriteBack(get: Getter): void {
  const bridge = window.reviewer;
  const id = get().activeSessionId;
  if (!bridge || id === null) {
    return;
  }
  void bridge.setActiveSession({ id });
}

export type WriteBackSlice = {
  /** Persist one session's inputs, debounced. The three schedule/flush members are the
   * store's own plumbing rather than anything a component calls, but they are slice members
   * like any other so that the sibling slices reach them through `get()` — the same way they
   * reach every other cross-slice action — instead of importing this module's internals. */
  scheduleSessionWriteBack: (sessionId: SessionId) => void;
  /** One session's pending write, sent now — the closing tab's path (see `closeSession`),
   * which is the only caller that has to beat a delete to main. */
  flushSessionWriteBack: (sessionId: SessionId) => void;
  /** The active id persists through the same debounce, not per switch — switching
   * back to a session must cost zero immediate bridge calls. */
  scheduleActiveWriteBack: () => void;
  /** Fires every pending debounced write-back now — the quit/unload path, so main
   * holds the last mutation before its own disk flush. */
  flushWriteBacks: () => void;
  /** Drops every pending write-back instead of sending it, so no timer of this store's
   * outlives it. The mirror of `flushWriteBacks`, and the reason `createReviewStore` can be
   * called more than once: a discarded instance has to be able to go quiet, or its half-second
   * of pending writes lands on whichever bridge the *next* instance is talking to. Nothing in
   * the app calls it — a real window either flushes on unload or dies with the process. */
  cancelWriteBacks: () => void;
};

// The debouncers live in this creator's closure rather than at module scope: they are I/O
// plumbing of *one* store instance, not renderable state and not something two instances may
// share. Sessions are keyed so activity in one tab can never coalesce away another tab's
// write; the active id has only one pointer, so it needs no key.
//
// `get` is closed over rather than carried as the debounced value, which is what module-scoped
// debouncers had to do — they were built before any store existed. Here they are built with
// one, so there is nothing to thread.
export const createWriteBackSlice: StateCreator<ReviewState, [], [], WriteBackSlice> = (
  _set,
  get,
) => {
  const sessionWriteBacks = createKeyedDebouncer<SessionId>({
    delayMs: WRITE_BACK_DEBOUNCE_MS,
    onFire: (sessionId) => {
      sendSessionWriteBack(get, sessionId);
    },
  });
  const activeWriteBack = createDebouncer({
    delayMs: WRITE_BACK_DEBOUNCE_MS,
    onFire: () => {
      sendActiveWriteBack(get);
    },
  });

  return {
    scheduleSessionWriteBack: (sessionId) => {
      sessionWriteBacks.notify(sessionId);
    },

    flushSessionWriteBack: (sessionId) => {
      sessionWriteBacks.flush(sessionId);
    },

    scheduleActiveWriteBack: () => {
      activeWriteBack.notify();
    },

    flushWriteBacks: () => {
      sessionWriteBacks.flushAll();
      activeWriteBack.flush();
    },

    cancelWriteBacks: () => {
      sessionWriteBacks.cancelAll();
      activeWriteBack.cancel();
    },
  };
};
