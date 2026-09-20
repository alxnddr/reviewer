import type { StateCreator } from "zustand";
import type { GitFailure } from "../../../../shared/git";
import type {
  ReviewLocateRepoRequest,
  ReviewOpenFailure,
  ReviewOpenResponse,
} from "../../../../shared/review-ipc";
import type { SessionId } from "../../../../shared/session";
import { failureInvitesLocate } from "../../lib/review-open-failure-message";
import { runDiffLoad } from "./effects";
import { createSessionSlice } from "./slice-factory";
import { setSlice, type Getter, type Setter } from "./slice";
import type { ReviewState } from "./state";
import { claimStartTabSlot, reconcileTabs } from "./tab-strip";

// The four ways a reader asks for something to be opened: the repo picker, the review picker,
// a path off a drop, and the File the drop actually carried. All of them end in a session main
// owns — either one it creates here, or one it already had — and every failure they can hit is
// app-level, because an open that failed has no session to report itself in.

export type OpenSlice = {
  /** A failed repo-open is app-level: it never lands in a slice. The
   * OpenFailureBanner renders it while a session is active, the start screen
   * otherwise. */
  openFailure: GitFailure | null;
  /** A failed review-open (bad extension, oversize, malformed, …): also app-level
   * (opens land as sessions, so a *failed* open has no session to report in),
   * surfaced by the ReviewOpenFailureBanner and cleared on the next open. */
  reviewOpenFailure: ReviewOpenFailure | null;
  /** What Locate Repository… would retry the failed open against: set only when the failure is one
   * it can answer (`failureInvitesLocate`) and the renderer knows which review it was — the
   * artifact a drop or a recents click named, or the session a frozen note's locate came from.
   * Null otherwise, File → Open Review… included: main picked that path and the renderer never
   * learns it. Set and cleared with the failure, never apart from it. */
  reviewOpenLocate: ReviewLocateRepoRequest | null;
  /** The tab an open request landed on when it turned out to already be open — a review, or
   * a plain repository — and a nonce so asking twice flashes twice. One tab per artifact means a reader who clicks a review they
   * already have up gets no new tab — and a click that produces no visible change is a click
   * that reads as broken, however correct it was. The strip pulses the tab instead, which is
   * the same "here, this one" the browser gives you. Null until it happens; app-level and
   * transient, like `promptCopy`, never persisted. */
  revealedSession: { id: SessionId; nonce: number } | null;
  openRepository: () => Promise<void>;
  /** The File → Open Review… menu command: main shows the native picker. */
  openReview: () => Promise<void>;
  /** A dropped `.reviewer.json`: `path` came from the preload `getPathForFile`. */
  openReviewByPath: (path: string) => Promise<void>;
  /** A dropped File: resolve its disk path via the preload, then open it. A File
   * with no backing path (getPathForFile → null) becomes a typed failure and is
   * never sent as an empty-path invoke. */
  openDroppedFile: (file: File) => Promise<void>;
  /** Locate Repository…: main shows the directory picker and re-seats the review on the pick. A
   * session's pending write-back is sent first, so the last write main receives before the re-seat
   * is the renderer's newest; a failure lands on the same banner a failed open does. */
  locateReviewRepository: (target: ReviewLocateRepoRequest) => Promise<void>;
  clearOpenFailure: () => void;
  clearReviewOpenFailure: () => void;
};

/** Shared tail of the dialog + drop paths: a typed failure surfaces on the
 * app-level banner; an opened review re-lists (main already created + activated
 * the session) and focuses it; a dialog cancel is a no-op. */
async function applyReviewOpen(
  set: Setter,
  get: Getter,
  response: ReviewOpenResponse,
  nextRevealNonce: () => number,
  /** Which review this was, for the banner's Locate Repository… — null when the renderer does
   * not know (a dialog pick). */
  locate: ReviewLocateRepoRequest | null,
): Promise<void> {
  if (!response.ok) {
    set({
      reviewOpenFailure: response.failure,
      reviewOpenLocate: locate !== null && failureInvitesLocate(response.failure) ? locate : null,
    });
    return;
  }
  if (response.value.kind === "canceled") {
    return;
  }
  set({ reviewOpenFailure: null, reviewOpenLocate: null });
  const { sessionId, created } = response.value;
  // Captured before the await, for the same reason `openRepository` captures it: the reader
  // may have switched tabs while the picker was up, and this is a fact about where the errand
  // started.
  const from = get().activeStartTabId;
  // `syncSessions` is what adds the new slice — and what hands the start tab its slot when a
  // review *arrives*. An already-open review arrives nowhere, so it takes neither, and the
  // start tab has to be dismissed here instead.
  await get().syncSessions();
  get().activateSession(sessionId);
  if (created) {
    return;
  }
  set({ revealedSession: { id: sessionId, nonce: nextRevealNonce() } });
  // Spent all the same: it did its job, the tab it would have become was already open. The
  // same closing rule `openRepository` applies when a repo turns out to be open already.
  if (from !== null) {
    get().closeStartTab(from);
  }
}

export const createOpenSlice: StateCreator<ReviewState, [], [], OpenSlice> = (set, get) => {
  /** Monotonic, scoped to this store, and never rendered — like `promptCopySequence`, it only
   * has to differ from the value before it so a second reveal of the same tab is seen as a new
   * one. Handed to `applyReviewOpen` rather than read from it, so the counter cannot outlive
   * the store it counts for. */
  let revealSequence = 0;
  const nextRevealNonce = (): number => (revealSequence += 1);

  return {
    openFailure: null,
    reviewOpenFailure: null,
    reviewOpenLocate: null,
    revealedSession: null,

    openRepository: async () => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      const opened = await bridge.openRepo();
      if (!opened.ok) {
        // App-level failure: opening belongs to the shell, so it must not clobber
        // whichever session happens to be active. The banner surfaces it
        // over an active session; the start screen renders it otherwise.
        set({ openFailure: opened.failure });
        return;
      }
      if (opened.value.kind === "canceled") {
        return;
      }
      const repo = opened.value.repo;
      // One *plain* tab per repository: re-opening a path that already has a plain session
      // re-activates its tab — two of them over one repo would be the same diff twice, each
      // writing back its own copy of the same selection.
      //
      // A review of that repo is not a match, and until this said so it was: a review session
      // is pinned to a checkout, so it carries the same `repo.path`, and ⌘O on the repo of an
      // open review focused the review and opened nothing. The rule predates reviews, when
      // every session was a plain one. The two share no persisted state — sessions are keyed
      // by id, and a review's progress is keyed by its artifact — and two reviews of one repo
      // already sit side by side (one tab per *artifact*, `main/review/handlers.ts`), so a
      // plain diff beside a review is nothing new. `reviewOrigin` is the review-session
      // marker every other slice asks (`picker.ts`, `lib/diff-plan.ts`).
      //
      // Captured before the awaits: the reader may have switched tabs while the picker was up,
      // and this is a fact about where the errand started.
      const from = get().activeStartTabId;
      const existing = Object.values(get().sessions).find(
        (slice) => slice.reviewOrigin === null && slice.repo.path === repo.path,
      );
      if (existing !== undefined) {
        // Pulsed, like a review that was already open (`revealedSession`): when the tab in
        // question is the active one, activating it changes nothing on screen, and a ⌘O that
        // changes nothing reads as broken.
        set({
          openFailure: null,
          revealedSession: { id: existing.id, nonce: nextRevealNonce() },
        });
        get().activateSession(existing.id);
        // The start tab was still spent — it did its job, the tab it would have become was
        // already open — so it goes rather than lingering as a door nobody opened.
        if (from !== null) {
          get().closeStartTab(from);
        }
        return;
      }
      // The id comes from main (sessions are main-owned); creation also
      // activates on the main side, so no set-active write-back is needed here.
      const session = await bridge.createSession({ source: { kind: "local", repo } });
      // Everything a fresh repo session holds is the factory's default — it has no persisted
      // inputs to restore, which is the whole difference between opening one and reopening one.
      // The four overrides below are the *other* difference, and they all say the same thing:
      // this slice derives here, in the tail of this action, rather than on a later first
      // activation the way a restored one does.
      const slice = createSessionSlice(
        { id: session.id, repo },
        {
          // The log and branch walks are launched below, so the picker shows its two spinners
          // from the first frame. A restored slice holds `null` for both — "never asked" — until
          // `deriveSession` starts them.
          log: { phase: "loading" },
          branches: { phase: "loading" },
          // Likewise the diff, which `runDiffLoad` starts at the end of this action: `idle` is
          // the default because a restored slice genuinely has no load coming, and rendering
          // that state for the frame between here and there would flash the empty pane.
          diff: { phase: "loading" },
          // Already derived — by the two fetches below. `activateSession` must not run
          // `deriveSession` over this slice later and re-ask git for what is being asked here.
          needsDerive: false,
        },
      );
      const sessions = { ...get().sessions, [session.id]: slice };
      set({
        sessions,
        activeSessionId: session.id,
        // Into the start tab's own slot, and that tab out of the strip: the browser's
        // new-tab-page rule (see `placeOpenedSession`). Opened from anywhere else — ⌘O over a
        // review — it appends, and every parked start tab stays where it is.
        tabs: (() => {
          const appended = reconcileTabs(get().tabs, Object.keys(sessions));
          return from === null ? appended : claimStartTabSlot(appended, from, session.id);
        })(),
        activeStartTabId: null,
        openFailure: null,
      });

      const [log, branches] = await Promise.all([
        bridge.getCommitLog({ repoPath: repo.path, range: null }),
        bridge.listBranches({ repoPath: repo.path }),
      ]);
      // Existence-only, like deriveSession: this fresh slice's log/branches can
      // come from nowhere else, and an interleaved user action (which bumps the
      // diff ticket) must not discard the sources it is waiting on.
      const current = get().sessions[session.id];
      if (current === undefined) {
        return;
      }
      setSlice(set, get, session.id, {
        log: log.ok
          ? { phase: "loaded", entries: log.value.entries }
          : { phase: "failed", failure: log.failure },
        branches: branches.ok
          ? { phase: "loaded", list: branches.value }
          : { phase: "failed", failure: branches.failure },
        // The freshest thing in the repo — the working tree when dirty, the newest
        // commit otherwise — is the selection a reviewer wants first.
        brush: log.ok && log.value.entries.length > 0 ? { anchor: 0, focus: 0 } : null,
        head: branches.ok ? (branches.value.currentBranch ?? branches.value.defaultBranch) : null,
      });
      await runDiffLoad(set, get, session.id);
    },

    openReview: async () => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      await applyReviewOpen(set, get, await bridge.openReview(), nextRevealNonce, null);
    },

    openReviewByPath: async (path) => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      await applyReviewOpen(set, get, await bridge.openReviewByPath({ path }), nextRevealNonce, {
        kind: "artifact",
        path,
      });
    },

    openDroppedFile: async (file) => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      const path = bridge.getPathForFile(file);
      if (path === null) {
        // A File built in JS / not backed by disk: nothing to open. Surface it as a
        // typed failure rather than invoking main with an empty path.
        set({ reviewOpenFailure: { code: "unreadable" }, reviewOpenLocate: null });
        return;
      }
      await get().openReviewByPath(path);
    },

    locateReviewRepository: async (target) => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      if (target.kind === "session") {
        get().flushSessionWriteBack(target.sessionId);
      }
      const response = await bridge.locateReviewRepo(target);
      if (target.kind === "artifact" || !response.ok) {
        // An artifact target is an open, retried with a checkout — it lands exactly like one; and
        // a session's failure lands on the same banner, remembering which session to retry.
        await applyReviewOpen(set, get, response, nextRevealNonce, target);
        return;
      }
      if (response.value.kind === "canceled") {
        return;
      }
      set({ reviewOpenFailure: null, reviewOpenLocate: null });
      // Main re-seated a session this renderer already holds; the re-list sees the moved pin and
      // rebuilds that slice (`reseatedSlice`), which derives against the checkout.
      await get().syncSessions();
    },

    clearOpenFailure: () => {
      set({ openFailure: null });
    },

    clearReviewOpenFailure: () => {
      set({ reviewOpenFailure: null, reviewOpenLocate: null });
    },
  };
};
