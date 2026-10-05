import { create } from "zustand";
import { assertNever } from "../../../shared/assert";
import type {
  GitHubFailure,
  GitHubInbox,
  GitHubPullRequestInfo,
  GitHubResult,
} from "../../../shared/github-ipc";
import { pullRequestUrl, type PullRequest } from "../../../shared/pull-request";
import {
  PullRequestBase,
  type BaseSuggestion,
  type PreparedPullRequest,
  type PullRequestCheckout,
  type PullRequestFailure,
  type PullRequestLocateResponse,
  type PullRequestWorktree,
} from "../../../shared/pull-request-ipc";
// Relative, not `@/`, like every unit-tested store (`recent-reviews.ts` says why).
import { expandPrompt } from "../lib/pull-request-prompt";

// Review Pull Request…'s state: the dialog, the pull request it is about, the checkout found for
// it, the worktree made for it, and the list of worktrees made before. Kept out of the review
// store for the reason the recents and onboarding stores are: nothing here belongs to a
// session — this is what happens before the reader's agent has written the review that will
// become one.
//
// The steps are explicit actions rather than one "go" because each is a decision the reader
// may want to see before the next one runs: which checkout the pull request will be fetched
// into (and which remote), and which base it is compared against — the one guess on this
// machine (`BaseSuggestion`). Finding the checkout touches only the disk; the fetch is the
// step that goes to the network, so it is the one behind a button.
//
// What leaves the dialog is the prompt, and it is built here (`expandPrompt`) from the
// template the caller passes — the settings store's — so this store reads no other store and
// its tests need none. The clipboard write is the component's, like every copy in the app
// (`lib/copy-feedback.ts`). The inbox's login arrives the same way, as an argument.
//
// **GitHub's answers ride beside git's, never in front of them** (`next-features.md`, B3 step 2
// and B5). Looking a pull request up also asks GitHub for its title, state and base (`info`) —
// with the reader's token for its owner when main holds one (Layer C), anonymously otherwise: the answer prefills the base — it is the branch the pull request targets, not a
// guess, so it outranks the checkout's (`suggestedBase`) — and the dialog shows the title and
// state. Without it (a private repository, a spent limit, no network) the flow is B3's exactly:
// the local guess stands and a quiet line says why GitHub did not answer. The inbox (`inbox`) is
// fetched on demand only: when the dialog opens with a username set, unless the same login's list
// is under a minute old (`INBOX_FRESH_MS`), and on Refresh — never on a timer, because the
// inbox's search is always unauthenticated (`main/github/handlers.ts` says why) and allows ten
// requests a minute per network.

/** Where the dialog stands on the checkout for `target`. */
export type CheckoutState =
  | { kind: "none" }
  | { kind: "found"; checkout: PullRequestCheckout; suggested: BaseSuggestion | null }
  | { kind: "notFound" };

/** What the dialog is waiting on, if anything. One at a time: every button that starts one is
 * disabled while another runs. */
export type PullRequestBusy = "locating" | "picking" | "cloning" | "preparing" | null;

export type PreparedState = { result: PreparedPullRequest; prompt: string };

/** GitHub's account of the pull request in hand: not asked yet, on its way, or its answer. */
export type PullRequestInfoState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; info: GitHubPullRequestInfo }
  | { phase: "failed"; failure: GitHubFailure };

/** The inbox for one login. The last list stays on screen (`rows`) while a refresh is in flight
 * and under a failed one, so Refresh never blanks what the reader was looking at. */
export type InboxState =
  | { phase: "idle" }
  | { phase: "loading"; login: string; rows: GitHubInbox | null }
  | { phase: "loaded"; login: string; rows: GitHubInbox; fetchedAt: number }
  | { phase: "failed"; login: string; rows: GitHubInbox | null; failure: GitHubFailure };

/** How long a fetched inbox counts as fresh enough that reopening the dialog does not ask again.
 * A reader toggling the dialog is not asking for news; Refresh always asks. */
export const INBOX_FRESH_MS = 60_000;

type PullRequestState = {
  open: boolean;
  /** The field's text, as typed or pasted. Read by `readPullRequestInput` on every render. */
  input: string;
  /** The pull request the panels below the field are about: the one last looked up. */
  target: PullRequest | null;
  checkout: CheckoutState;
  /** The base the fetch will use — prefilled from the suggestion, the reader's to correct. */
  base: string;
  /** Whether the reader has typed in the base field since the checkout was found: a GitHub answer
   * arriving after that never overwrites what they typed. */
  baseEdited: boolean;
  /** GitHub's title, state and base for `target`. */
  info: PullRequestInfoState;
  inbox: InboxState;
  busy: PullRequestBusy;
  /** Cancel was pressed and the operation has not answered yet. It answers at once from a
   * fetch or clone; a checkout already under way is never stopped halfway (a truncated tree is
   * worse than a late one — `addDetachedWorktree` in main), so the dialog says it is finishing. */
  cancelling: boolean;
  failure: PullRequestFailure | null;
  prepared: PreparedState | null;
  worktrees: { phase: "idle" | "loading" | "loaded"; rows: PullRequestWorktree[] };
  /** The worktree a Remove is running on, so its row alone shows it. */
  removing: string | null;
  /** The worktree whose Remove is asking to be confirmed, or null. Removing deletes a directory
   * — ignored files and all — so the first press asks and the second does it. */
  confirmingRemoval: string | null;
  /** The last refused removal and why, shown on that row. */
  removeFailure: { path: string; failure: PullRequestFailure } | null;
  openDialog: () => void;
  close: () => void;
  toggle: () => void;
  setInput: (input: string) => void;
  setBase: (base: string) => void;
  /** Step 1: a checkout among the ones the app knows. */
  locate: (pr: PullRequest) => Promise<void>;
  /** Locate Repository…: the reader names the checkout. */
  pickCheckout: () => Promise<void>;
  /** The no-checkout fallback: a partial clone into a folder the reader picks. */
  cloneCheckout: () => Promise<void>;
  /** Steps 2–4: fetch, worktree, and the prompt — answered so the caller can copy it. */
  prepare: (template: string) => Promise<PreparedState | null>;
  refreshWorktrees: () => Promise<void>;
  /** Kills the fetch, clone or checkout in flight; it answers `cancelled`. */
  cancel: () => Promise<void>;
  askRemove: (path: string) => void;
  cancelRemove: () => void;
  removeWorktree: (path: string) => Promise<void>;
  /** The open pull requests requesting `login`'s review. Skipped while one is in flight for the
   * same login, and — unless `force` — while the last one is fresh (`INBOX_FRESH_MS`). */
  refreshInbox: (login: string, options?: { force?: boolean }) => Promise<void>;
};

/** The base the field starts from once a checkout is found. The one place a suggestion becomes
 * the field's text; which suggestion that is, is `suggestedBase`'s. */
export function initialBase(suggested: BaseSuggestion | null): string {
  return suggested?.name ?? "";
}

/** The suggestion that stands: GitHub's `base.ref` when it answered with one — the branch the
 * pull request targets, which outranks anything this machine can guess — else the checkout's
 * own (`remoteHead` / `localDefault`). */
export function suggestedBase(
  local: BaseSuggestion | null,
  info: PullRequestInfoState,
): BaseSuggestion | null {
  return info.phase === "loaded" && info.info.base !== null
    ? { name: info.info.base, from: "api" }
    : local;
}

/** A GitHub channel's answer, or — when the IPC call itself rejects (main threw past its guard,
 * or its answer did not parse) — the typed failure that stands for it, so the inbox and the pull
 * request's summary settle instead of staying "loading" for the rest of the session. */
async function guarded<T>(ask: () => Promise<GitHubResult<T>>): Promise<GitHubResult<T>> {
  try {
    return await ask();
  } catch (error) {
    console.error("A GitHub request failed unexpectedly:", error);
    return { ok: false, failure: { code: "unexpected" } };
  }
}

/** The last list an inbox state holds for `login`, if any — what stays on screen while it is
 * asked again. A list for another login is not this one's. */
function rowsFor(inbox: InboxState, login: string): GitHubInbox | null {
  return inbox.phase === "idle" || inbox.login !== login ? null : inbox.rows;
}

/** The base as a branch name, or null while the field holds something git would refuse — by
 * git's own rules (`PullRequestBase`, the schema the prepare request is parsed with), so `a/.b`
 * is a field error here and never a refusal from the far end of a fetch. */
export function validBase(base: string): PullRequestBase | null {
  const parsed = PullRequestBase.safeParse(base.trim());
  return parsed.success ? parsed.data : null;
}

/** The prompt for a prepared pull request: the template with its four facts written in. */
export function promptFor(
  template: string,
  pr: PullRequest,
  prepared: PreparedPullRequest,
): string {
  return expandPrompt(template, {
    pr: pullRequestUrl(pr),
    worktree: prepared.worktree,
    base: prepared.base,
    head: prepared.head,
  });
}

/** Everything about the pull request in hand, back to "nothing asked yet". */
const NO_TARGET = {
  target: null,
  checkout: { kind: "none" },
  base: "",
  baseEdited: false,
  info: { phase: "idle" },
  failure: null,
  prepared: null,
} as const satisfies Partial<PullRequestState>;

export const usePullRequestStore = create<PullRequestState>((set, get) => {
  /** A locate-shaped answer landed for `pr`: a checkout to show, the dialog's "none known", a
   * dismissed picker (which changes nothing), or a failure. Ignored when the reader has moved
   * on to another pull request while it was in flight. */
  const settleLocate = (pr: PullRequest, response: PullRequestLocateResponse): void => {
    if (get().target !== pr) {
      return;
    }
    if (!response.ok) {
      set({ busy: null, cancelling: false, failure: response.failure });
      return;
    }
    const outcome = response.value;
    switch (outcome.kind) {
      case "found":
        set({
          busy: null,
          cancelling: false,
          failure: null,
          prepared: null,
          checkout: { kind: "found", checkout: outcome.checkout, suggested: outcome.base },
          base: initialBase(suggestedBase(outcome.base, get().info)),
          baseEdited: false,
        });
        return;
      case "notFound":
        set({ busy: null, cancelling: false, checkout: { kind: "notFound" } });
        return;
      case "canceled":
        set({ busy: null, cancelling: false });
        return;
      default:
        assertNever(outcome);
    }
  };

  /** GitHub's answer about `pr`, beside the checkout lookup and independent of it: whichever
   * lands second finds the other in place, and the base follows `suggestedBase` either way —
   * unless the reader has already typed one. */
  const loadInfo = async (pr: PullRequest): Promise<void> => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    const response = await guarded(() => bridge.getGitHubPullRequest({ pullRequest: pr }));
    if (get().target !== pr) {
      return;
    }
    const info: PullRequestInfoState = response.ok
      ? { phase: "loaded", info: response.value }
      : { phase: "failed", failure: response.failure };
    const { checkout, baseEdited } = get();
    set({
      info,
      ...(checkout.kind === "found" && !baseEdited
        ? { base: initialBase(suggestedBase(checkout.suggested, info)) }
        : {}),
    });
  };

  return {
    open: false,
    input: "",
    ...NO_TARGET,
    inbox: { phase: "idle" },
    busy: null,
    cancelling: false,
    worktrees: { phase: "idle", rows: [] },
    removing: null,
    confirmingRemoval: null,
    removeFailure: null,

    openDialog: () => {
      set({ open: true, removeFailure: null, confirmingRemoval: null });
      void get().refreshWorktrees();
    },
    // The pull request in hand survives a close: a reader who closes the dialog to paste the
    // prompt and comes back finds the worktree and the prompt where they left them. So does an
    // operation in flight — closing is not cancelling (`handlers.ts` in main says why): it runs
    // on, `busy` stays set, and the reopened dialog shows it running with its Cancel.
    close: () => set({ open: false, confirmingRemoval: null }),
    toggle: () => {
      if (get().open) {
        get().close();
      } else {
        get().openDialog();
      }
    },

    setInput: (input) => set({ input }),
    setBase: (base) => set({ base, baseEdited: true, failure: null }),

    locate: async (pr) => {
      const bridge = window.reviewer;
      if (!bridge || get().busy !== null) {
        return;
      }
      set({ ...NO_TARGET, target: pr, busy: "locating", info: { phase: "loading" } });
      void loadInfo(pr);
      settleLocate(pr, await bridge.locatePullRequestCheckout({ pullRequest: pr }));
    },

    pickCheckout: async () => {
      const bridge = window.reviewer;
      const { target, busy } = get();
      if (!bridge || target === null || busy !== null) {
        return;
      }
      set({ busy: "picking", failure: null });
      settleLocate(target, await bridge.pickPullRequestCheckout({ pullRequest: target }));
    },

    cloneCheckout: async () => {
      const bridge = window.reviewer;
      const { target, busy } = get();
      if (!bridge || target === null || busy !== null) {
        return;
      }
      set({ busy: "cloning", failure: null });
      settleLocate(target, await bridge.clonePullRequestRepo({ pullRequest: target }));
    },

    prepare: async (template) => {
      const bridge = window.reviewer;
      const { target, checkout, busy } = get();
      const base = validBase(get().base);
      if (
        !bridge ||
        target === null ||
        checkout.kind !== "found" ||
        base === null ||
        busy !== null
      ) {
        return null;
      }
      set({ busy: "preparing", failure: null, prepared: null });
      const response = await bridge.preparePullRequest({
        pullRequest: target,
        checkout: { repoPath: checkout.checkout.repo.path, remote: checkout.checkout.remote },
        base,
      });
      if (get().target !== target) {
        return null;
      }
      // The list changes whatever happened: a created worktree is a new row, and a failure
      // after the fetch (a dirty worktree left alone) still moved what its row shows.
      void get().refreshWorktrees();
      if (!response.ok) {
        set({ busy: null, cancelling: false, failure: response.failure });
        return null;
      }
      const prepared = {
        result: response.value,
        prompt: promptFor(template, target, response.value),
      };
      set({ busy: null, cancelling: false, prepared });
      return prepared;
    },

    refreshWorktrees: async () => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      set((state) => ({ worktrees: { phase: "loading", rows: state.worktrees.rows } }));
      const response = await bridge.listPullRequestWorktrees();
      set({ worktrees: { phase: "loaded", rows: response.worktrees } });
    },

    cancel: async () => {
      const bridge = window.reviewer;
      const { busy } = get();
      // Only what a Cancel can stop: a picker is the OS's to dismiss, and a locate is quick.
      if (!bridge || (busy !== "preparing" && busy !== "cloning")) {
        return;
      }
      set({ cancelling: true });
      await bridge.cancelPullRequest();
    },

    askRemove: (path) => set({ confirmingRemoval: path, removeFailure: null }),
    cancelRemove: () => set({ confirmingRemoval: null }),

    removeWorktree: async (path) => {
      const bridge = window.reviewer;
      if (!bridge || get().removing !== null || get().confirmingRemoval !== path) {
        return;
      }
      set({ removing: path, removeFailure: null, confirmingRemoval: null });
      const response = await bridge.removePullRequestWorktree({ path });
      set({
        removing: null,
        removeFailure: response.ok ? null : { path, failure: response.failure },
      });
      await get().refreshWorktrees();
    },

    refreshInbox: async (login, options) => {
      const bridge = window.reviewer;
      const { inbox } = get();
      if (!bridge || (inbox.phase === "loading" && inbox.login === login)) {
        return;
      }
      if (
        options?.force !== true &&
        inbox.phase === "loaded" &&
        inbox.login === login &&
        Date.now() - inbox.fetchedAt < INBOX_FRESH_MS
      ) {
        return;
      }
      const rows = rowsFor(inbox, login);
      set({ inbox: { phase: "loading", login, rows } });
      const response = await guarded(() => bridge.listReviewRequests({ login }));
      // The username changed while this was out: the newer ask owns the slot.
      const now = get().inbox;
      if (now.phase !== "loading" || now.login !== login) {
        return;
      }
      set({
        inbox: response.ok
          ? { phase: "loaded", login, rows: response.value, fetchedAt: Date.now() }
          : { phase: "failed", login, rows, failure: response.failure },
      });
    },
  };
});
