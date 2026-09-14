import { BrowserWindow, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { IpcChannel } from "../../shared/ipc";
import {
  pinReview,
  type ReviewOrigin,
  type ReviewSourceCheck,
  type ReviewStamp,
} from "../../shared/review";
import type {
  ReviewLocateRepoRequest,
  ReviewOpenFailure,
  ReviewOpenResponse,
} from "../../shared/review-ipc";
import { repinSession, type Session } from "../../shared/session";
import type { GitRunner } from "../git/runner";
import { registerIpcHandler } from "../ipc-registry";
import type { SessionStore } from "../sessions";
import { importReviewFromPath, type ReviewOpenRequest } from "./guard";
import type { ProgressStore } from "./progress";
import { listRecentReviews } from "./recent";
import type { RepoRelocations } from "./relocations";
import { checkReviewSource, findReviewSource } from "./source";

// The three open entries (dialog, drop, CLI/`open-file`) meet here: each hands a
// path to the same guard, and a success becomes a session in the main-owned store.
// Dialog/drop answer through the invoke response; CLI/`open-file` have no pending
// invoke, so the caller (index.ts) delivers via a payload-free push.
//
// A fourth entry re-seats rather than opens: Locate Repository…, which pairs a review with a
// directory the reader picked. It crosses the same source check an open does
// (`review/source.ts`), because a picked directory is exactly as untrusted as an authored one.

/** Everything the open path touches, as one value. Four collaborators passed positionally beside
 * a path and an override made call sites that could swap two of them without a type error. */
export type ReviewOpenDeps = {
  runner: GitRunner;
  store: SessionStore;
  progress: ProgressStore;
  relocations: RepoRelocations;
};

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

const CANCELED: ReviewOpenResponse = { ok: true, value: { kind: "canceled" } };

/** Guard a path, and on success create the active session. The one place a
 * validated review becomes a session — shared by all three entries.
 *
 * The artifact's author picked its `repo`, so a parsed artifact is not yet a
 * trusted session source: `RepoPath` only proves the string is absolute, and the
 * session's path is what later feeds `git:file-contents` (and its `worktree` arm's
 * disk reads). So every path a review could live at — the one the artifact names, one handed
 * over by `rvw open --repo`, one remembered from an earlier Locate — goes through `validateRepo`
 * (which also normalizes to the work-tree toplevel) before a live session may read it: a review
 * pointing at `/Users/you/.ssh` never becomes something the viewer can render.
 *
 * A frozen artifact is exempt from *needing* one, deliberately. An artifact that carries its patch
 * opens even when no path validates, because nothing about rendering it touches the repo — that
 * is the whole `--embed-patch` handoff, a review written on a box and read on a laptop where the
 * box's path does not exist, and refusing it over a repo it does not need was the bug. The
 * exemption does not weaken the rule above: its session keeps the authored path only as a label,
 * nothing git-backed runs against a frozen pin (`deriveSession` skips git, context expansion
 * refuses), and it becomes something git reads only once a later check validates a path and
 * thaws it. A refs-only artifact has nothing to show without its repo and refs, and still fails. */
async function importSession(
  deps: ReviewOpenDeps,
  request: ReviewOpenRequest,
): Promise<ImportSessionResult> {
  const result = await importReviewFromPath(request.path, reviewStamp());
  if (!result.ok) {
    return result;
  }
  // One tab per artifact, checked on the canonical path the guard resolved. Two tabs over one
  // review would each hold their own marks and each write the same progress record, so
  // whichever the reader closed last would silently win — the same reason a repo can only be
  // open once (see `openRepository` in the review store). This sits after the guard rather
  // than before it so a path that is not a review still fails the way it always did.
  const open = deps.store.findByReviewPath(result.path);
  if (open !== null) {
    // `rvw open --repo` against a review already up re-seats that tab rather than being ignored:
    // the caller named a checkout, and a tab left frozen would read as the flag not working.
    if (request.repo === null || open.reviewOrigin === null) {
      return { ok: true, session: open, created: false };
    }
    const relocated = await relocateSession(deps, open, open.reviewOrigin, request.repo);
    return relocated.ok ? { ok: true, session: relocated.session, created: false } : relocated;
  }

  const review = result.review;
  const pin = pinReview(
    review,
    await findReviewSource(deps, review, { override: request.repo, current: null }),
  );
  if (!pin.ok) {
    return { ok: false, failure: pin.failure };
  }
  return {
    ok: true,
    created: true,
    session: deps.store.createFromReview(review, {
      path: result.path,
      progress: await deps.progress.read(result.path),
      repo: pin.repo,
      reviewDiff: pin.reviewDiff,
    }),
  };
}

/** What Locate Repository… says about a directory that did not make the review live. A value-
 * returning switch over the non-live checks, so a new kind of check has to be given a sentence. */
function locateFailure(check: Exclude<ReviewSourceCheck, { kind: "live" }>): ReviewOpenFailure {
  switch (check.kind) {
    case "repoMissing":
      return { code: "repoUnavailable", reason: check.failure };
    case "refsMissing":
      return { code: "refsUnavailable", missing: check.missing };
    case "patchDiffers":
      return { code: "patchMismatch" };
  }
}

type RelocateResult = { ok: true; session: Session } | { ok: false; failure: ReviewOpenFailure };

/** Re-seat an open review on a checkout the reader named — Locate Repository…'s pick, or `rvw
 * open --repo` against a tab already up. Only a live result moves anything: the pairing is
 * remembered for the authored path, so the next review of the same checkout opens live too, and
 * the session takes the new pin.
 *
 * Anything short of live is reported, and the session keeps the pin it had. Unlike an open, this
 * tries no other candidate: a reader who picked a directory asked about *that* directory, and
 * quietly answering about another one would be answering a question nobody asked. */
async function relocateSession(
  deps: ReviewOpenDeps,
  session: Session,
  origin: ReviewOrigin,
  localPath: string,
): Promise<RelocateResult> {
  const check = await checkReviewSource(deps.runner, localPath, origin);
  if (check.kind !== "live") {
    return { ok: false, failure: locateFailure(check) };
  }
  const pin = pinReview(origin, check);
  if (!pin.ok) {
    // A live check always pins; answered rather than asserted, like every other failure here.
    return { ok: false, failure: pin.failure };
  }
  if (check.repo.path !== origin.repo.path) {
    deps.relocations.remember(origin.repo.path, check.repo.path);
  }
  const repinned = repinSession(session, pin);
  if (repinned !== session) {
    deps.store.update(repinned);
  }
  return { ok: true, session: repinned };
}

/** The drop path, and the tail of the dialog and locate paths: guard the request's path →
 * session → invoke outcome carrying the new session id (or the typed failure). */
export async function openReviewFromPath(
  deps: ReviewOpenDeps,
  request: ReviewOpenRequest,
): Promise<ReviewOpenResponse> {
  const result = await importSession(deps, request);
  return result.ok
    ? { ok: true, value: { kind: "opened", sessionId: result.session.id, created: result.created } }
    : { ok: false, failure: result.failure };
}

/** File → Open Review…: the native picker (parented → a window-modal sheet, like
 * the repo dialog), then the shared guard. A dismiss is `canceled`, not a failure. */
async function openReviewViaDialog(deps: ReviewOpenDeps): Promise<ReviewOpenResponse> {
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
    return CANCELED;
  }
  return openReviewFromPath(deps, { path: file, repo: null });
}

/** The directory picker Locate Repository… shows, parented like the review dialog. Null on a
 * dismiss. The pick is a candidate, not a repo: the caller validates it like an authored path. */
async function pickRepository(): Promise<string | null> {
  const options = {
    title: "Locate Repository",
    message: "Choose where this review's repository is checked out on this machine.",
    buttonLabel: "Locate",
    properties: ["openDirectory" as const],
  };
  const owner = BrowserWindow.getFocusedWindow();
  const picked = await (owner === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(owner, options));
  const directory = picked.filePaths[0];
  return picked.canceled || directory === undefined ? null : directory;
}

/** Locate Repository…: the picker, then the re-seat. An `artifact` target is an open that failed
 * on its repo, retried with the pick handed over exactly as `rvw open --repo` hands one over. A
 * `session` target is looked up before the picker, so a review closed in the meantime asks nothing,
 * and again after it, since the picker stays up as long as the reader takes. A dismiss or a
 * vanished session is `canceled`: there is no review left to report a failure against. */
export async function locateReviewRepo(
  deps: ReviewOpenDeps,
  request: ReviewLocateRepoRequest,
): Promise<ReviewOpenResponse> {
  if (request.kind === "artifact") {
    const picked = await pickRepository();
    return picked === null
      ? CANCELED
      : openReviewFromPath(deps, { path: request.path, repo: picked });
  }
  const find = (): Session | undefined =>
    deps.store.list().sessions.find((session) => session.id === request.sessionId);
  if (find()?.reviewOrigin == null) {
    return CANCELED;
  }
  const picked = await pickRepository();
  const session = find();
  if (picked === null || session === undefined || session.reviewOrigin === null) {
    return CANCELED;
  }
  const relocated = await relocateSession(deps, session, session.reviewOrigin, picked);
  return relocated.ok
    ? { ok: true, value: { kind: "opened", sessionId: session.id, created: false } }
    : { ok: false, failure: relocated.failure };
}

export function registerReviewIpcHandlers(deps: ReviewOpenDeps): void {
  registerIpcHandler(IpcChannel.reviewOpen, () => openReviewViaDialog(deps));

  registerIpcHandler(IpcChannel.reviewOpenPath, ({ path }) =>
    openReviewFromPath(deps, { path, repo: null }),
  );

  registerIpcHandler(IpcChannel.reviewLocateRepo, (request) => locateReviewRepo(deps, request));

  registerIpcHandler(IpcChannel.reviewsRecent, () => listRecentReviews(deps.progress));
}

/** CLI / `open-file` delivery: guard + create the session in main, returning it
 * so the caller can notify/create a window. A bad launch arg logs and returns
 * null — never a throw, never a spawn. */
export async function importReviewSessionFromArg(
  deps: ReviewOpenDeps,
  request: ReviewOpenRequest,
): Promise<Session | null> {
  const result = await importSession(deps, request);
  if (!result.ok) {
    console.error(`Open review from launch arg failed: ${result.failure.code}`);
    return null;
  }
  // An already-open review answers with its existing session, which the caller focuses — so
  // `rvw open` on a review the reader already has up raises that tab instead of a duplicate.
  return result.session;
}
