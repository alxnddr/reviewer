import type { Session } from "../../shared/session";

// The delivery half of the three open entries: CLI/`open-file` have no pending
// invoke, so a path is imported in main and the result *revealed* —
// an existing window is re-listed via the payload-free push (no path/model crosses
// main→renderer), or one is created and its hydration lists the now-active session.
// macOS `open-file` can fire before `ready` on a cold launch, so paths queue and
// drain exactly once the window and store exist; the drain is serialized so two
// fast drops each land as their own session rather than racing the shared store.
// The window existing is not the same as its page being able to hear, so the push
// waits on that too — two gates, one for the store and one for the renderer.
// Extracted from index.ts so this ordering is unit-tested without a live app.

export type ReviewOpenQueueDeps = {
  /** Guard + create the session (or null on a bad path); side effects on the store. */
  importSession: (absolutePath: string) => Promise<Session | null>;
  hasWindow: () => boolean;
  createWindow: () => void;
  /** Bring the existing window forward (restore if minimized). */
  focusWindow: () => void;
  /** Resolves once the window's page can receive a push. Awaited before every notify: on a
   * cold start `hasWindow()` is true the instant the window object exists, and a send to a
   * page that has not loaded is dropped without a trace. */
  whenWindowReady: () => Promise<void>;
  /** Payload-free `sessionsChanged` to every window — the one main→renderer push. */
  notifySessionsChanged: () => void;
};

export type ReviewOpenQueue = {
  /** Queue a path; drains immediately once ready, else waits for `markReady`. */
  enqueue: (absolutePath: string) => void;
  /** The window + store now exist: drain whatever queued before ready. */
  markReady: () => void;
};

export function createReviewOpenQueue(deps: ReviewOpenQueueDeps): ReviewOpenQueue {
  const pending: string[] = [];
  let ready = false;
  let draining = false;

  async function reveal(absolutePath: string): Promise<void> {
    const session = await deps.importSession(absolutePath);
    if (!deps.hasWindow()) {
      // No window (macOS keeps the app alive with zero): create one; its hydrate
      // lists the session main just made active.
      deps.createWindow();
      return;
    }
    deps.focusWindow();
    // A bad path still focuses the app but has nothing to re-list.
    if (session !== null) {
      // Waited on here rather than at markReady, because the import is what races the page
      // load: a fast one has to hold its push, a slow one finds the page ready and this
      // costs a resolved promise.
      await deps.whenWindowReady();
      deps.notifySessionsChanged();
    }
  }

  async function drain(): Promise<void> {
    if (draining) {
      return;
    }
    draining = true;
    try {
      let next = pending.shift();
      while (next !== undefined) {
        await reveal(next);
        next = pending.shift();
      }
    } finally {
      draining = false;
    }
  }

  return {
    enqueue: (absolutePath) => {
      pending.push(absolutePath);
      if (ready) {
        void drain();
      }
    },
    markReady: () => {
      ready = true;
      void drain();
    },
  };
}
