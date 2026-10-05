import { parsePatch, type PatchFile } from "../../../../shared/diff/patch";
import type { GitHubDiffCheckResponse } from "../../../../shared/github-ipc";
import { hasPostable } from "../../../../shared/postable-comment";
import { settleGitHubCheck } from "../../lib/github-links";
import type { SessionId } from "../../../../shared/session";
import { planDiff, sameSelection } from "../../lib/diff-plan";
import { initialFolds } from "../../lib/initial-folds";
import { brushAfterWalk, logRangeFor, recoverReviewBrush } from "../../lib/log-range";
import { withCollapsed } from "../../lib/read-progress";
import { setSlice, type Getter, type SessionSlice, type Setter } from "./slice";

// The four git errands: a diff load, a log re-walk, a session's first derivation, and the read
// of a pull request's fetched head — and one errand to GitHub, the check of a review's anchors
// against GitHub's own diff of its pull request (`checkGitHubDiff`). Each one is a
// `(set, get, sessionId)` function rather than an action because more than one slice starts it:
// the picker reloads the log, the tab strip and both opening paths derive a session, and every
// one of those ends in a diff load; the head and the GitHub check are started by the derivation
// and again by `refreshPullRequestHeads` (boot.ts).
//
// One thing that is not a git errand rides along with the diff load anyway: the one-time
// initial fold seed (`seedFolds`). It is here because this is where a session first holds its
// files, and because riding in the same patch is what keeps the folds from appearing a frame
// after the diff they are about.
//
// They share one staleness discipline, stated per call site: a response is applied only to a
// slice that still exists, and — for the diff and the log re-walk — only against the ticket
// its own request was issued under (`requestTicket`, `logTicket`; one each, because the two
// errands go stale independently). The first derivation deliberately takes neither.

/** The one-time initial fold seed, expressed as a patch that rides along with the very load
 * that produced the files — so the first frame a reader ever sees of this diff already has
 * the lockfiles closed, rather than showing them open and folding them a tick later.
 *
 * Empty for a session that has already been seeded, which is what keeps a reader's unfold
 * from being undone on the next load (`slice.ts`'s `collapsedFiles` header draws the line
 * between this seed and a spring). Empty too when the load carried no files: there is
 * nothing to decide about yet, and burning the one seed on an empty diff would leave the
 * real one unfolded forever.
 *
 * `withCollapsed` is additive and answers its input when nothing moved, so a restored
 * session whose folds already cover the seed allocates nothing and re-renders nothing.
 *
 * It deliberately schedules **no write-back of its own**, unlike every other write of
 * persisted state in this store. Two reasons, and both have to hold for this to stay right.
 * A diff load is the one place a write can be in flight *after* `cancelWriteBacks` — the load
 * resolves on its own promise — so a store nobody holds any more would go on writing through
 * whichever bridge the next one installed, which is exactly what cancelling is for. And it
 * costs nothing: the seed is a pure function of the files and the layers, so a session that
 * persisted nothing after it re-seeds to the identical set next time, while a session whose
 * reader unfolded one of these files has *by that gesture* scheduled a write-back that carries
 * `foldsSeeded` along with the unfold (`persistedSession` reads it off the slice like any
 * other field). Adding a schedule here would buy nothing and reopen the cancel hole. */
function seedFolds(slice: SessionSlice, files: readonly PatchFile[]): Partial<SessionSlice> {
  if (slice.foldsSeeded || files.length === 0) {
    return {};
  }
  return {
    collapsedFiles: withCollapsed(slice.collapsedFiles, initialFolds(files, slice.layers), true),
    foldsSeeded: true,
  };
}

export async function runDiffLoad(set: Setter, get: Getter, sessionId: SessionId): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined) {
    return;
  }
  const plan = planDiff(slice);
  // Bumped on every outcome, not just fetches: a plan that resolves to empty or
  // blocked must also invalidate an older in-flight response for this session.
  const ticket = slice.requestTicket + 1;
  if (plan.kind === "blocked") {
    setSlice(set, get, sessionId, {
      requestTicket: ticket,
      selection: null,
      diff: { phase: "failed", failure: plan.failure },
      selectedFilePath: null,
    });
    return;
  }
  if (plan.kind === "nothing") {
    setSlice(set, get, sessionId, {
      requestTicket: ticket,
      selection: null,
      diff: { phase: "empty" },
      selectedFilePath: null,
    });
    return;
  }
  if (plan.kind === "frozenPatch") {
    // A frozen review renders its embedded patch off git entirely: parse it
    // here, no bridge round-trip. `selection` stays null — there is no git selection
    // to name — and the result never changes, so a re-run over a settled load is a
    // no-op rather than a loadId churn.
    if (
      slice.diff.phase === "loaded" ||
      slice.diff.phase === "empty" ||
      slice.diff.phase === "unreadable"
    ) {
      return;
    }
    const frozenFiles = parsePatch(plan.patch, `${sessionId}:${ticket}`);
    const seed = seedFolds(slice, frozenFiles);
    setSlice(set, get, sessionId, {
      requestTicket: ticket,
      selection: null,
      diff:
        frozenFiles.length === 0
          ? { phase: plan.patch.trim() === "" ? "empty" : "unreadable" }
          : { phase: "loaded", loadId: ticket, files: frozenFiles },
      selectedFilePath: frozenFiles.some((file) => file.path === slice.selectedFilePath)
        ? slice.selectedFilePath
        : (frozenFiles[0]?.path ?? null),
      ...seed,
    });
    return;
  }
  if (
    sameSelection(slice.selection, plan.selection) &&
    (slice.diff.phase === "loaded" || slice.diff.phase === "empty")
  ) {
    return;
  }

  setSlice(set, get, sessionId, {
    requestTicket: ticket,
    selection: plan.selection,
    // A repo session's commit-brush arm persists as the SHA-anchored `commitSelection`;
    // `branches`, a review's pinned `reviewRefs`, and a review session's own commit
    // arm (which persists as `reviewSubrange` instead) all leave it untouched.
    commitSelection:
      plan.selection.kind === "branches" ||
      plan.selection.kind === "reviewRefs" ||
      slice.reviewOrigin !== null
        ? slice.commitSelection
        : plan.selection,
    diff: { phase: "loading" },
  });

  const response = await bridge.getDiff({ repoPath: slice.repo.path, selection: plan.selection });
  const current = get().sessions[sessionId];
  if (current === undefined || current.requestTicket !== ticket) {
    return;
  }
  if (!response.ok) {
    setSlice(set, get, sessionId, { diff: { phase: "failed", failure: response.failure } });
    return;
  }
  const files = parsePatch(response.value.patch, `${sessionId}:${ticket}`);
  if (files.length === 0) {
    // The wire contract (Patch, src/shared/git.ts) sends "" for a changeless
    // selection; zero files out of a non-empty patch is a parse failure, not
    // a clean diff.
    setSlice(set, get, sessionId, {
      diff: { phase: response.value.patch.trim() === "" ? "empty" : "unreadable" },
    });
    return;
  }
  const seed = seedFolds(current, files);
  setSlice(set, get, sessionId, {
    diff: { phase: "loaded", loadId: ticket, files },
    // A restored (or merely persistent) file focus survives when the fresh diff
    // still contains it; otherwise focus starts at the top like a fresh open.
    selectedFilePath: files.some((file) => file.path === current.selectedFilePath)
      ? current.selectedFilePath
      : (files[0]?.path ?? null),
    ...seed,
  });
}

/** Re-walk the log after the picker moves an endpoint, then place the brush in what came
 * back. */
export async function reloadLog(set: Setter, get: Getter, sessionId: SessionId): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined) {
    return;
  }
  const ticket = slice.logTicket + 1;
  setSlice(set, get, sessionId, { logTicket: ticket, log: { phase: "loading" } });
  const log = await bridge.getCommitLog({
    repoPath: slice.repo.path,
    range: logRangeFor(slice),
  });
  const current = get().sessions[sessionId];
  if (
    current === undefined ||
    current.logTicket !== ticket ||
    current.head !== slice.head ||
    current.base !== slice.base
  ) {
    // The reviewer moved the endpoints again while this was in flight. The ticket is what
    // actually decides it — the endpoint comparison stays because it is free and it says
    // what the guard is *for*, but it cannot see the A → B → A case, where two walks are
    // outstanding and both of them match the pair now on screen.
    return;
  }
  if (!log.ok) {
    setSlice(set, get, sessionId, { log: { phase: "failed", failure: log.failure }, brush: null });
    await runDiffLoad(set, get, sessionId);
    return;
  }
  const entries = log.value.entries;
  setSlice(set, get, sessionId, {
    log: { phase: "loaded", entries },
    brush: brushAfterWalk(entries, current, true),
  });
  await runDiffLoad(set, get, sessionId);
}

/** The pull request's head as last fetched into the session's repository (`pullRequestRef`: `refs/rvw/pr/<owner>/<repo>/<n>`),
 * onto `prHead`. Only a live review that names a pull request asks: a plain repo session has no
 * pull request, and a frozen review's repo path is a label nothing git-backed may run against
 * (`deriveSession`). A failed read is the same as no ref — null, and the drift warning falls
 * back to the branch (`prHeadDrift`) — because it only ever decides a tooltip.
 *
 * Applied only to a slice that still exists and still names the same repository and pull
 * request; there is no ticket because nothing else writes this field in between. */
export async function readPrHead(set: Setter, get: Getter, sessionId: SessionId): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  const pr = slice?.reviewOrigin?.pr ?? null;
  if (!bridge || slice === undefined || pr === null || slice.reviewDiff?.kind === "frozenPatch") {
    return;
  }
  const response = await bridge.getPullRequestHead({
    repoPath: slice.repo.path,
    pullRequest: pr,
  });
  const current = get().sessions[sessionId];
  if (current === undefined || current.repo.path !== slice.repo.path) {
    return;
  }
  const prHead = response.ok ? response.value : null;
  if (current.prHead !== prHead) {
    setSlice(set, get, sessionId, { prHead });
  }
}

/** Ask GitHub, through main, whether its own diff of the review's pull request carries each
 * comment's lines (B4), onto `githubCheck`. Only a review that can be checked asks: one that
 * names a pull request, records the commit it read (`reviewedHead` — GitHub's diff is compared
 * only at that commit), and has at least one comment written for the author, because the
 * postable block is the only surface that reads the answer — a review of the reader's own branch
 * never spends a request. Frozen reviews ask too: the question is about GitHub's diff, not this
 * machine's checkout.
 *
 * A failure is not an error here: it is stored as `unchecked` — or, when an earlier check did
 * answer, that answer is kept and marked stale (`settleGitHubCheck`) — the local diff stays
 * trusted, and the tooltip mentions it quietly. Applied only to a slice that still exists and
 * still holds the very origin it was asked for (a re-seat rebuilds the origin, and re-derives);
 * there is no ticket because two answers for the same question agree. */
export async function checkGitHubDiff(
  set: Setter,
  get: Getter,
  sessionId: SessionId,
  /** `fresh`: read the pull request's head from GitHub now, past main's memo — the check after a
   * fetch, when a remembered head would hide that the pull request moved. */
  options: { fresh?: boolean } = {},
): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  const pr = slice?.reviewOrigin?.pr ?? null;
  const reviewedHead = slice?.reviewOrigin?.reviewedHead ?? null;
  if (
    !bridge ||
    slice === undefined ||
    pr === null ||
    reviewedHead === null ||
    !slice.comments.some(hasPostable)
  ) {
    return;
  }
  let response: GitHubDiffCheckResponse;
  try {
    response = await bridge.checkGitHubDiff({
      pullRequest: pr,
      reviewedHead,
      ...(options.fresh === true ? { fresh: true } : {}),
      anchors: slice.comments.map(({ id, file, side, startLine, endLine }) => ({
        id,
        file,
        side,
        startLine,
        endLine,
      })),
    });
  } catch (error) {
    // The IPC call itself failed (main threw past its own guard, or the answer did not parse):
    // the same "not checked" as any other failure, never a promise left rejected.
    console.error("The check against GitHub's diff failed:", error);
    response = { ok: false, failure: { code: "unexpected" } };
  }
  // The slice must still be the one asked about: closed tabs drop the answer, and a slice main
  // re-seated in the meantime (`reseatedSlice`) carries a new origin and asks for itself.
  const current = get().sessions[sessionId];
  if (current === undefined || current.reviewOrigin !== slice.reviewOrigin) {
    return;
  }
  setSlice(set, get, sessionId, { githubCheck: settleGitHubCheck(current.githubCheck, response) });
}

/** First activation of a restored slice: fetch log + branches, re-locate the
 * SHA-anchored brush in the fresh log, then load the diff. Never runs twice for
 * one slice — later activations render what is already there. */
export async function deriveSession(set: Setter, get: Getter, sessionId: SessionId): Promise<void> {
  const bridge = window.reviewer;
  const slice = get().sessions[sessionId];
  if (!bridge || slice === undefined || !slice.needsDerive) {
    return;
  }
  // GitHub's answer lands on its own, like the head below: it decides a note and a tooltip, and
  // nothing here waits on it. Asked for a frozen review too — the question is about GitHub's
  // diff, not this machine's checkout.
  void checkGitHubDiff(set, get, sessionId);
  // Where its comments stand on GitHub, for a review that could have posted any (Layer C): one
  // question to main, which asks GitHub only when it has a record of a pending review and a token
  // to ask with — the "re-query on open" of C3, bounded to one request per open.
  if (slice.reviewOrigin?.pr != null && slice.comments.some(hasPostable)) {
    void get().refreshPosted(sessionId);
  }
  // A frozen review is not backed by a repo that has to exist: its diff comes out of the
  // artifact, and the two things git would answer here are things it has no use for — the
  // brush is replaced by a note (SelectionPanel) and the branch picker is not its picker.
  // Asking anyway is how an artifact emitted somewhere else — a CI runner, whose checkout
  // path means nothing on this machine — used to open with two failed panels beside a diff
  // that rendered perfectly. `log`/`branches` stay null, which is the same "never asked"
  // they hold before any derivation, rather than a `failed` that invites a retry.
  if (slice.reviewDiff?.kind === "frozenPatch") {
    setSlice(set, get, sessionId, { needsDerive: false, diff: { phase: "loading" } });
    await runDiffLoad(set, get, sessionId);
    return;
  }

  setSlice(set, get, sessionId, {
    needsDerive: false,
    log: { phase: "loading" },
    branches: { phase: "loading" },
    diff: { phase: "loading" },
  });

  // A review session lists only its own `base..head` commits; a repo session walks
  // whichever branch its picker was left on. The pin still renders the diff, so a
  // failed ranged log only costs the reviewer the ability to narrow, never the review.
  const range = logRangeFor(slice);
  // The pull request's head rides beside the two reads it is no less cheap than, and lands on
  // its own: it decides one tooltip, and nothing below waits on it.
  void readPrHead(set, get, sessionId);
  const [log, branches] = await Promise.all([
    bridge.getCommitLog({ repoPath: slice.repo.path, range }),
    bridge.listBranches({ repoPath: slice.repo.path }),
  ]);
  // Existence is the only staleness that applies here: nothing else can produce
  // log/branches for this slice (needsDerive flipped synchronously, and opens
  // always create fresh slices). Both tickets guard their own errand and nothing else —
  // `requestTicket` a diff response, `logTicket` a picker re-walk — and this fetch is
  // issued under neither: an interleaved user action must not discard the derivation it
  // waits on.
  const current = get().sessions[sessionId];
  if (current === undefined) {
    return;
  }
  const review =
    current.reviewOrigin !== null && log.ok
      ? recoverReviewBrush(log.value.entries, current.reviewSubrange)
      : null;
  setSlice(set, get, sessionId, {
    log: log.ok
      ? { phase: "loaded", entries: log.value.entries }
      : { phase: "failed", failure: log.failure },
    branches: branches.ok
      ? { phase: "loaded", list: branches.value }
      : { phase: "failed", failure: branches.failure },
    brush:
      review === null
        ? log.ok
          ? brushAfterWalk(log.value.entries, current, false)
          : null
        : review.brush,
    reviewSubrange: review === null ? current.reviewSubrange : review.reviewSubrange,
    // A persisted pick wins; a fresh session lists the branch it is standing on. `base`
    // is deliberately not defaulted: a session opens on the branch's own history, and a
    // comparison is something the reviewer asks for.
    head:
      current.head ??
      (branches.ok ? (branches.value.currentBranch ?? branches.value.defaultBranch) : null),
  });
  await runDiffLoad(set, get, sessionId);
}
