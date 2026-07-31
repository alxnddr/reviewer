import type { StateCreator } from "zustand";
import type { SessionId, SessionSnapshot } from "../../../../shared/session";
import { deriveSession } from "./effects";
import { restoredSlice } from "./slice-factory";
import type { Getter, SessionSlice, Setter } from "./slice";
import type { ReviewState } from "./state";
import { claimStartTabSlot, reconcileTabs } from "./tab-strip";

// Sessions arriving from main: once at boot, and again whenever main says its list changed
// (a CLI publish, an `open-file`, or the tail of any open in `open.ts`). Both paths are the
// same two steps — list, then build slices for whatever is new — and the ordering between
// them is the delicate part, which `hydration` below states.

/** `hydrate` runs once ("pending" gates a StrictMode double effect); "hydrating"
 * spans the `sessions:list` round-trip, during which the start screen must not
 * flash; "ready" resolves to empty or sessions by whether slices exist. */
export type BootPhase = "pending" | "hydrating" | "ready";

export type BootSlice = {
  boot: BootPhase;
  /** Boot hydration: pull main's persisted sessions, derive the active one only. */
  hydrate: () => Promise<void>;
  /** Re-list main's sessions after a CLI/`open-file` import pushed `sessionsChanged`,
   * or after a dialog/drop opened one: adds the new slice(s), adopts main's active,
   * and derives it — without disturbing any already-live slice. */
  syncSessions: () => Promise<void>;
};

/** Boot's `sessions:list` round-trip and the `set` that lands it, up to but not including the
 * derive. Returns the session to derive, or null when there is nothing to restore.
 *
 * Split out of `hydrate` so the promise `syncSessions` waits on can settle at the write rather
 * than at the end of derivation (see `hydration`). */
async function restoreSessions(set: Setter, get: Getter): Promise<SessionId | null> {
  const bridge = window.reviewer;
  if (!bridge) {
    // Browser gate run: no main process, so no sessions to restore.
    set({ boot: "ready" });
    return null;
  }
  let snapshot: SessionSnapshot;
  try {
    snapshot = await bridge.listSessions();
  } catch (error) {
    // Session reads are designed never to fail, but an
    // IPC-level rejection must still degrade to the start screen with a visible
    // failure — never a forever-blank "hydrating" boot.
    console.error("Session hydration failed:", error);
    set({ boot: "ready", openFailure: { code: "unexpected" } });
    return null;
  }
  const sessions: Record<SessionId, SessionSlice> = {};
  for (const session of snapshot.sessions) {
    sessions[session.id] = restoredSlice(session);
  }
  // Salvage can null the active pointer while keeping sessions — the dropped
  // session was the active one. Land on the first surviving tab so a restore
  // never renders the start screen behind a populated strip; the
  // recovered pointer heals main's null on the next write-back.
  const restoredActive = snapshot.activeSessionId ?? snapshot.sessions[0]?.id ?? null;
  // The strip is main's order on a fresh launch — there are no start tabs yet, since they
  // are never persisted.
  set({
    boot: "ready",
    sessions,
    tabs: snapshot.sessions.map((session) => ({ kind: "session", id: session.id })),
    activeSessionId: restoredActive,
    activeStartTabId: null,
  });
  if (restoredActive !== null && snapshot.activeSessionId === null) {
    get().scheduleActiveWriteBack();
  }
  return restoredActive;
}

export const createBootSlice: StateCreator<ReviewState, [], [], BootSlice> = (set, get) => {
  /** This store's in-flight session restore, or null outside one.
   *
   * `syncSessions` awaits it before re-listing, because `restoreSessions` ends by *replacing*
   * `sessions` wholesale from the snapshot it read at boot. A CLI push landing mid-hydration
   * would otherwise re-list, build the pushed session into `sessions`, and then have the older
   * snapshot overwrite it away — the review vanishing until the next push, on exactly the
   * cold-start path an agent hits when it emits while the app is launching.
   *
   * It deliberately spans only the restore, not the derive that follows it: the clobber ends at
   * that `set`, and making an arriving review wait on the boot session's git calls too would
   * stall it for no reason.
   *
   * Per store rather than per module: two instances have two boots, and one's restore is
   * nothing for the other's push to wait on. */
  let hydration: Promise<SessionId | null> | null = null;

  return {
    boot: "pending",

    hydrate: async () => {
      if (get().boot !== "pending") {
        return;
      }
      set({ boot: "hydrating" });
      // Published before the first await so a `sessions:changed` push arriving mid-restore can
      // find it and wait its turn instead of being overwritten (see `hydration`).
      const restore = restoreSessions(set, get);
      hydration = restore;
      let restoredActive: SessionId | null;
      try {
        restoredActive = await restore;
      } finally {
        hydration = null;
      }
      if (restoredActive !== null) {
        // Only the visible session derives now; the rest stay restored until first
        // activation, so a many-tab relaunch cannot stampede git spawns.
        await deriveSession(set, get, restoredActive);
      }
    },

    syncSessions: async () => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      // A push that lands mid-hydration waits the restore out, then re-lists on top of it:
      // re-listing first would only have the boot snapshot overwrite the pushed session away
      // (see `hydration`). After boot there is nothing in flight and this costs a check.
      //
      // Waited for *settlement*, not for success: a restore that threw is hydrate's to report,
      // and adopting its rejection here would only strand the push — no re-list, and an
      // unhandled rejection out of the `void syncSessions()` the event handler is. Re-listing
      // over a failed boot is how the pushed review still lands.
      if (hydration !== null) {
        await hydration.catch(() => {});
      }
      let snapshot: SessionSnapshot;
      try {
        snapshot = await bridge.listSessions();
      } catch (error) {
        // The push is a hint; a failed re-list leaves current state intact rather
        // than blanking the strip (hydrate owns the boot-time failure surface).
        console.error("Session re-list failed:", error);
        return;
      }
      // Rebuild from main's order (new opens append), keeping every already-live
      // slice by identity so a re-list never re-derives or wipes an open session.
      const existing = get().sessions;
      const sessions: Record<SessionId, SessionSlice> = {};
      for (const session of snapshot.sessions) {
        sessions[session.id] = existing[session.id] ?? restoredSlice(session);
      }
      const current = get().activeSessionId;
      const nextActive =
        snapshot.activeSessionId !== null && sessions[snapshot.activeSessionId] !== undefined
          ? snapshot.activeSessionId
          : current !== null && sessions[current] !== undefined
            ? current
            : null;
      // A session the strip has never seen, becoming the active one, is a review *arriving* —
      // from the reader's own click on the start screen's list, from a drop, or from a CLI
      // publish while they waited on it. That is the one event the start screen exists for, so
      // the tab it was waited on takes the review: same slot, same position, no spent front door
      // left in the strip and nothing for the reader to close.
      //
      // Only the *focused* start tab, though. One parked in the strip while the reader is
      // elsewhere is a tab they put there, and a review landing somewhere else is not permission
      // to close it. A re-list that changes nothing (a session closed elsewhere, a write-back
      // echo) touches none of this.
      const from = get().activeStartTabId;
      const arrived = nextActive !== null && existing[nextActive] === undefined;
      const reconciled = reconcileTabs(get().tabs, Object.keys(sessions));
      set({
        boot: "ready",
        sessions,
        tabs:
          from !== null && arrived && nextActive !== null
            ? claimStartTabSlot(reconciled, from, nextActive)
            : reconciled,
        activeSessionId: nextActive,
        ...(from !== null && arrived ? { activeStartTabId: null } : {}),
      });
      if (nextActive !== null && sessions[nextActive]?.needsDerive === true) {
        await deriveSession(set, get, nextActive);
      }
    },
  };
};
