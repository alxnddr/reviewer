import { BrowserWindow, dialog } from "electron";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { IpcChannel } from "../../shared/ipc";
import { RecentReviewsResponse } from "../../shared/recent-reviews";
import type { ReviewStamp } from "../../shared/review";
import {
  ReviewOpenPathRequest,
  ReviewOpenResponse,
  type ReviewOpenFailure,
} from "../../shared/review-open";
import type { Session } from "../../shared/session";
import { validateRepo } from "../git/ops";
import type { GitRunner } from "../git/runner";
import { registerIpcHandler } from "../ipc-registry";
import type { SessionStore } from "../sessions";
import { importReviewFromPath } from "./guard";
import type { ProgressStore } from "./progress";
import { listRecentReviews } from "./recent";

// The three open entries (dialog, drop, CLI/`open-file`) meet here: each hands a
// path to the same guard, and a success becomes a session in the main-owned store.
// Dialog/drop answer through the invoke response; CLI/`open-file` have no pending
// invoke, so the caller (index.ts) delivers via a payload-free push.

/** Identity `importReview` stamps onto each comment: main supplies the real UUID
 * to the pure resolver. */
function reviewStamp(): ReviewStamp {
  return { newId: () => randomUUID() };
}

type ImportSessionResult =
  /** `created` false means the artifact was already open and this is its existing session.
   * The renderer needs the distinction: a session it already has a slice for must be
   * *activated*, not added, and the tab it lands on should say so rather than appearing to
   * ignore the click. */
  { ok: true; session: Session; created: boolean } | { ok: false; failure: ReviewOpenFailure };

/** Guard a path, and on success create the active session. The one place a
 * validated review becomes a session — shared by all three entries.
 *
 * The artifact's author picked its `repo`, so a parsed artifact is not yet a
 * trusted session source: `RepoPath` only proves the string is absolute, and the
 * session's path is what later feeds `git:file-contents` (and its `worktree` arm's
 * disk reads). Validating here refuses a review pointing at any directory that is
 * not a git work tree — `/Users/you/.ssh` never becomes something the viewer can
 * render — and, as on the dialog path, normalizes to the work-tree toplevel. */
async function importSession(
  runner: GitRunner,
  store: SessionStore,
  progress: ProgressStore,
  rawPath: string,
): Promise<ImportSessionResult> {
  const result = await importReviewFromPath(rawPath, reviewStamp());
  if (!result.ok) {
    return result;
  }
  // One tab per artifact, checked on the canonical path the guard resolved. Two tabs over one
  // review would each hold their own marks and each write the same progress record, so
  // whichever the reader closed last would silently win — the same reason a repo can only be
  // open once (see `openRepository` in the review store). This sits after the guard rather
  // than before it so a path that is not a review still fails the way it always did.
  const open = store.findByReviewPath(result.path);
  if (open !== null) {
    return { ok: true, session: open, created: false };
  }
  const repo = await validateRepo(runner, result.review.repo.path);
  if (!repo.ok) {
    return { ok: false, failure: { code: "repoUnavailable", reason: repo.failure } };
  }
  return {
    ok: true,
    created: true,
    session: store.createFromReview(
      { ...result.review, repo: repo.value },
      { path: result.path, progress: await progress.read(result.path) },
    ),
  };
}

/** The drop path, and the tail of the dialog path: guard `rawPath` → session →
 * invoke outcome carrying the new session id (or the typed failure). */
export async function openReviewFromPath(
  runner: GitRunner,
  store: SessionStore,
  progress: ProgressStore,
  rawPath: string,
): Promise<ReviewOpenResponse> {
  const result = await importSession(runner, store, progress, rawPath);
  return result.ok
    ? { ok: true, value: { kind: "opened", sessionId: result.session.id, created: result.created } }
    : { ok: false, failure: result.failure };
}

/** File → Open Review…: the native picker (parented → a window-modal sheet, like
 * the repo dialog), then the shared guard. A dismiss is `canceled`, not a failure. */
async function openReviewViaDialog(
  runner: GitRunner,
  store: SessionStore,
  progress: ProgressStore,
): Promise<ReviewOpenResponse> {
  const options = {
    title: "Open Review",
    properties: ["openFile" as const],
    // macOS matches only the last extension segment, so `.reviewer.json` files
    // surface under the `json` filter; the guard still enforces the full
    // `.reviewer.json` extension on whatever is picked.
    filters: [{ name: "Reviewer review", extensions: ["reviewer.json", "json"] }],
  };
  const owner = BrowserWindow.getFocusedWindow();
  const picked = await (owner === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(owner, options));
  const file = picked.filePaths[0];
  if (picked.canceled || file === undefined) {
    return { ok: true, value: { kind: "canceled" } };
  }
  return openReviewFromPath(runner, store, progress, file);
}

export function registerReviewIpcHandlers(
  runner: GitRunner,
  store: SessionStore,
  progress: ProgressStore,
): void {
  registerIpcHandler(
    IpcChannel.reviewOpen,
    { request: z.void(), response: ReviewOpenResponse },
    () => openReviewViaDialog(runner, store, progress),
  );

  registerIpcHandler(
    IpcChannel.reviewOpenPath,
    { request: ReviewOpenPathRequest, response: ReviewOpenResponse },
    ({ path }) => openReviewFromPath(runner, store, progress, path),
  );

  registerIpcHandler(
    IpcChannel.reviewsRecent,
    { request: z.void(), response: RecentReviewsResponse },
    () => listRecentReviews(progress),
  );
}

/** CLI / `open-file` delivery: guard + create the session in main, returning it
 * so the caller can notify/create a window. A bad launch arg logs and returns
 * null — never a throw, never a spawn. */
export async function importReviewSessionFromArg(
  runner: GitRunner,
  store: SessionStore,
  progress: ProgressStore,
  rawPath: string,
): Promise<Session | null> {
  const result = await importSession(runner, store, progress, rawPath);
  if (!result.ok) {
    console.error(`Open review from launch arg failed: ${result.failure.code}`);
    return null;
  }
  // An already-open review answers with its existing session, which the caller focuses — so
  // `rvw open` on a review the reader already has up raises that tab instead of a duplicate.
  return result.session;
}
