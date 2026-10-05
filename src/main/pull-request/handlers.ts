import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { mkdir, realpath } from "node:fs/promises";
import { IpcChannel } from "../../shared/ipc";
import { pullRequestLabel, type PullRequest } from "../../shared/pull-request";
import type { PullRequestLocateResponse, PullRequestResult } from "../../shared/pull-request-ipc";
import { registerIpcHandler } from "../ipc-registry";
import { listRecentReviews } from "../review/recent";
import type { ReviewOpenDeps } from "../review/handlers";
import { storeCheckouts } from "./checkouts";
import {
  adoptCheckout,
  cloneCheckout,
  cloneQueueKey,
  locateCheckout,
  preparePullRequest,
  readPullRequestHead,
  removePullRequestWorktree,
  type PullRequestDeps,
} from "./flow";
import { createKeyedQueue, type Queue } from "./queue";
import { listPullRequestWorktrees, repositoryOf, worktreeLocation } from "./worktrees";

// Review Pull Request…'s IPC rows, and the three things about it that need main's process
// rather than the flow: the native pickers, the serialization the flow relies on, and Cancel.
// Everything else is `flow.ts`, which runs without Electron.
//
// **What waits for what.** Preparing writes a worktree directory and git's bookkeeping for it,
// and removing deletes both; two of those racing over the same worktree — a double click, a
// Remove pressed while that pull request's fetch is still going — would have `worktree add`
// meet a half-made directory. And two prepares in the *same repository*, even of different
// pull requests, both fetch into `refs/remotes/<remote>/<base>`, where the second fails on git's
// ref lock. So the operations that write are queued under keys: a prepare under its repository
// *and* its worktree path, a remove under its worktree path. Prepares in one repository run one
// after another; a prepare in another repository, or a Remove of a worktree nobody is preparing,
// runs at once — git's own locks are per repository and per worktree, and so are these. A clone
// is queued under its target directory (`cloneQueueKey` says why: a failed clone's cleanup
// would otherwise remove a concurrent one's directory). The reads (locating, listing, the head)
// never are.
//
// **Cancel** stops the fetch or clone in flight (there is only ever the one the dialog started):
// the runner sends git's process group SIGTERM, which git cleans up after, and SIGKILL only if
// it has not gone after a grace (`git/runner.ts`'s `KILL_GRACE_MS`); the operation answers
// `cancelled`. A checkout (`worktree add`, the move's `switch`) is never cancelled — it is let
// finish, because a worktree stopped halfway is a truncated tree an agent could be sent to
// review. Closing the dialog is *not* a cancel: a fetch the reader asked for runs on, and the
// dialog shows it still running when reopened (`stores/pull-request.ts`), with Cancel there.

/** The dependencies the flow runs on, built from the app's own stores. `worktreesRoot` is the
 * directory `worktrees.ts` lays worktrees out in; created on first use and resolved, because git
 * reports every worktree path with symlinks resolved and the flow compares against those. */
export function pullRequestDeps(reviewDeps: ReviewOpenDeps, worktreesDir: string): PullRequestDeps {
  let root: Promise<string> | null = null;
  return {
    runner: reviewDeps.runner,
    // Best candidates first: what is open now, then what the reader located by hand, then the
    // repositories of reviews `rvw emit` has written. The recents read is the one the picker
    // already does on every opening, so a locate costs no more than opening that list.
    knownRepoPaths: async () => {
      const recent = await listRecentReviews(reviewDeps.progress);
      return [
        ...reviewDeps.store.list().sessions.map((session) => session.source.repo.path),
        ...reviewDeps.relocations.locals(),
        ...recent.reviews.flatMap((review) =>
          review.summary === null ? [] : [review.summary.repoPath],
        ),
      ];
    },
    openRepoPaths: () =>
      reviewDeps.store.list().sessions.map((session) => session.source.repo.path),
    checkouts: storeCheckouts(),
    worktreesRoot: () => {
      root ??= mkdir(worktreesDir, { recursive: true }).then(() => realpath(worktreesDir));
      // A failed creation is not cached: the next call tries again rather than failing forever.
      root.catch(() => {
        root = null;
      });
      return root;
    },
  };
}

/** An unexpected throw — the worktrees directory could not be made, a disk error under
 * `mkdir` — answered as a typed failure and logged, so no rejected promise crosses the bridge;
 * every failure the flow anticipates is already a value. */
async function settled<T>(
  task: () => Promise<PullRequestResult<T>>,
): Promise<PullRequestResult<T>> {
  try {
    return await task();
  } catch (error) {
    console.error("Review Pull Request failed unexpectedly:", error);
    return { ok: false, failure: { code: "git", failure: { code: "unexpected" } } };
  }
}

/** The abort controllers of the operations Cancel can stop, while they run. */
function createCancellation(): {
  track: <T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  cancelAll: () => void;
} {
  const running = new Set<AbortController>();
  return {
    track: async (task) => {
      const controller = new AbortController();
      running.add(controller);
      try {
        return await task(controller.signal);
      } finally {
        running.delete(controller);
      }
    },
    cancelAll: () => {
      for (const controller of running) {
        controller.abort();
      }
    },
  };
}

/** A directory picker parented to the focused window — a window-modal sheet on macOS, so a
 * second request cannot stack a parallel picker over this one. Null on a dismiss. */
async function pickDirectory(options: OpenDialogOptions): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow();
  const picked = await (owner === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(owner, options));
  const directory = picked.filePaths[0];
  return picked.canceled || directory === undefined ? null : directory;
}

const CANCELED: PullRequestLocateResponse = { ok: true, value: { kind: "canceled" } };

/** Locate Repository… for a pull request: the reader names the checkout the app could not find. */
async function locateViaPicker(
  deps: PullRequestDeps,
  pr: PullRequest,
): Promise<PullRequestLocateResponse> {
  const picked = await pickDirectory({
    title: "Locate Repository",
    message: `Choose where ${pullRequestLabel(pr)}'s repository is checked out on this machine.`,
    buttonLabel: "Locate",
    properties: ["openDirectory"],
  });
  return picked === null ? CANCELED : adoptCheckout(deps, pr, picked);
}

/** The clone fallback: the reader picks the folder the clone goes *into* — `createDirectory` so
 * a new one can be made from the sheet — and the clone is `<folder>/<repo>`. Cancellable once
 * the picker has answered. */
async function cloneViaPicker(
  deps: PullRequestDeps,
  pr: PullRequest,
  track: ReturnType<typeof createCancellation>["track"],
  exclusive: Queue,
): Promise<PullRequestLocateResponse> {
  const picked = await pickDirectory({
    title: "Clone Repository",
    message: `Choose the folder to clone ${pullRequestLabel(pr)}'s repository into.`,
    buttonLabel: "Clone Here",
    properties: ["openDirectory", "createDirectory"],
  });
  return picked === null
    ? CANCELED
    : track((signal) =>
        exclusive([cloneQueueKey(picked, pr)], () => cloneCheckout(deps, pr, picked, signal)),
      );
}

export function registerPullRequestIpcHandlers(deps: PullRequestDeps): void {
  const exclusive = createKeyedQueue();
  const { track, cancelAll } = createCancellation();

  registerIpcHandler(IpcChannel.pullRequestLocate, ({ pullRequest }) =>
    settled(() => locateCheckout(deps, pullRequest)),
  );
  registerIpcHandler(IpcChannel.pullRequestLocateCheckout, ({ pullRequest }) =>
    settled(() => locateViaPicker(deps, pullRequest)),
  );
  registerIpcHandler(IpcChannel.pullRequestClone, ({ pullRequest }) =>
    settled(() => cloneViaPicker(deps, pullRequest, track, exclusive)),
  );
  registerIpcHandler(IpcChannel.pullRequestPrepare, (request) =>
    settled(async () => {
      const path = worktreeLocation(await deps.worktreesRoot(), request.pullRequest);
      // The repository as `repositoryOf` names it — the same from any of its working trees —
      // so two prepares reaching one repository through different paths still share a key.
      const repo = await repositoryOf(deps.runner, request.checkout.repoPath);
      const repoKey = `repo:${repo.ok ? repo.value.path : request.checkout.repoPath}`;
      return track((signal) =>
        exclusive([repoKey, `worktree:${path}`], () => preparePullRequest(deps, request, signal)),
      );
    }),
  );
  registerIpcHandler(IpcChannel.pullRequestCancel, () => {
    cancelAll();
  });
  registerIpcHandler(IpcChannel.pullRequestWorktrees, async () => {
    try {
      return {
        worktrees: await listPullRequestWorktrees(deps.runner, await deps.worktreesRoot()),
      };
    } catch (error) {
      // No directory to list is no worktrees; the next prepare reports why it cannot make one.
      console.error("Pull request worktrees could not be listed:", error);
      return { worktrees: [] };
    }
  });
  registerIpcHandler(IpcChannel.pullRequestRemoveWorktree, ({ path }) =>
    settled(() => exclusive([`worktree:${path}`], () => removePullRequestWorktree(deps, path))),
  );
  registerIpcHandler(IpcChannel.pullRequestHead, ({ repoPath, pullRequest }) =>
    readPullRequestHead(deps.runner, repoPath, pullRequest),
  );
}
