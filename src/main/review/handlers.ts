import { BrowserWindow, dialog } from "electron";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { IpcChannel } from "../../shared/ipc";
import type { ReviewStamp } from "../../shared/review";
import {
  ReviewOpenPathRequest,
  ReviewOpenResponse,
  type ReviewOpenFailure,
} from "../../shared/review-open";
import type { Session } from "../../shared/session";
import { registerIpcHandler } from "../ipc-registry";
import type { SessionStore } from "../sessions";
import { importReviewFromPath } from "./guard";

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
  | { ok: true; session: Session }
  | { ok: false; failure: ReviewOpenFailure };

/** Guard a path, and on success create the active session. The one place a
 * validated review becomes a session — shared by all three entries. */
async function importSession(store: SessionStore, rawPath: string): Promise<ImportSessionResult> {
  const result = await importReviewFromPath(rawPath, reviewStamp());
  if (!result.ok) {
    return result;
  }
  return { ok: true, session: store.createFromReview(result.review) };
}

/** The drop path, and the tail of the dialog path: guard `rawPath` → session →
 * invoke outcome carrying the new session id (or the typed failure). */
export async function openReviewFromPath(
  store: SessionStore,
  rawPath: string,
): Promise<ReviewOpenResponse> {
  const result = await importSession(store, rawPath);
  return result.ok
    ? { ok: true, value: { kind: "opened", sessionId: result.session.id } }
    : { ok: false, failure: result.failure };
}

/** File → Open Review…: the native picker (parented → a window-modal sheet, like
 * the repo dialog), then the shared guard. A dismiss is `canceled`, not a failure. */
async function openReviewViaDialog(store: SessionStore): Promise<ReviewOpenResponse> {
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
  return openReviewFromPath(store, file);
}

export function registerReviewIpcHandlers(store: SessionStore): void {
  registerIpcHandler(
    IpcChannel.reviewOpen,
    { request: z.void(), response: ReviewOpenResponse },
    () => openReviewViaDialog(store),
  );

  registerIpcHandler(
    IpcChannel.reviewOpenPath,
    { request: ReviewOpenPathRequest, response: ReviewOpenResponse },
    ({ path }) => openReviewFromPath(store, path),
  );
}

/** CLI / `open-file` delivery: guard + create the session in main, returning it
 * so the caller can notify/create a window. A bad launch arg logs and returns
 * null — never a throw, never a spawn. */
export async function importReviewSessionFromArg(
  store: SessionStore,
  rawPath: string,
): Promise<Session | null> {
  const result = await importSession(store, rawPath);
  if (!result.ok) {
    console.error(`Open review from launch arg failed: ${result.failure.code}`);
    return null;
  }
  return result.session;
}
