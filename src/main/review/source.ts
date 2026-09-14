import { pinReview, type ReviewOrigin, type ReviewSourceCheck } from "../../shared/review";
import { repinSession } from "../../shared/session";
import { getDiff, resolveRefs, validateRepo } from "../git/ops";
import type { GitRunner } from "../git/runner";
import type { SessionStore } from "../sessions";
import type { RepoRelocations } from "./relocations";

// Where a review's diff comes from on *this* machine. An artifact names a repo path and two refs
// from the machine it was written on; whether this one has them is a question only git can answer,
// so it is asked here and the answer handed to `pinReview` (shared/review.ts), which decides.
//
// The pin used to follow from the artifact's shape alone — a patch meant frozen, whatever this
// machine had — which is why a review emitted with `--embed-patch` on a box lost context expansion
// and the commit brush forever, even after its branch had been pulled next to it. Availability,
// not presence, is the rule now: live whenever the repo and refs are here, frozen only when they
// are not.
//
// Answered at open *and* again on launch (`repinReviewSessions`), because a session persists its
// inputs and re-derives the rest: a review opened frozen last night is live this morning if the
// worktree was pulled in between, without anyone reopening it.

/** One candidate path, checked the whole way down. Each step runs only when the one before it
 * passed, so a path that is not a repository costs one spawn and a patchless review never diffs.
 *
 * "Live" for a review that carries a patch means its refs *reproduce* that patch, not merely that
 * they resolve. The app's own export embeds a patch exactly when refs cannot say its diff — a
 * commit range is diffed against `first`'s parent, which the refs do not name, and a working-tree
 * export has `base === head` — so going live on resolving refs alone would render a different
 * diff under the same anchors. A byte comparison is the rule because the app and the CLI capture
 * through one argv (`shared/node/git-diff.ts`); when a machine's own git config makes the two
 * disagree anyway, the review stays frozen, which places every anchor — the safe way to be
 * wrong. */
export async function checkReviewSource(
  runner: GitRunner,
  path: string,
  origin: ReviewOrigin,
): Promise<ReviewSourceCheck> {
  const repo = await validateRepo(runner, path);
  if (!repo.ok) {
    return { kind: "repoMissing", failure: repo.failure };
  }
  const refs = await resolveRefs(runner, repo.value.path, [origin.base, origin.head]);
  if (!refs.ok) {
    return { kind: "repoMissing", failure: refs.failure };
  }
  if (refs.value.length > 0) {
    return { kind: "refsMissing", repo: repo.value, missing: refs.value };
  }
  if (origin.patch === null || origin.patch.length === 0) {
    return { kind: "live", repo: repo.value };
  }
  const derived = await getDiff(runner, repo.value.path, {
    kind: "reviewRefs",
    base: origin.base,
    head: origin.head,
  });
  // A diff that could not be taken (over the cap, a timeout) is not proof the refs reproduce the
  // patch, so it answers the same as one that differs: frozen, which still renders.
  return derived.ok && derived.value.patch === origin.patch
    ? { kind: "live", repo: repo.value }
    : { kind: "patchDiffers", repo: repo.value };
}

/** How much of the review a check lets the app show, for choosing between candidates. A value-
 * returning switch with no default, so a new check kind is a compile error here rather than a
 * silently lowest rank. */
function usefulness(check: ReviewSourceCheck): number {
  switch (check.kind) {
    case "live":
      return 3;
    case "patchDiffers":
      return 2;
    case "refsMissing":
      return 1;
    case "repoMissing":
      return 0;
  }
}

export type ReviewSourceDeps = { runner: GitRunner; relocations: RepoRelocations };

/** Every path this review could live at, best answer first. The candidates, in the order they are
 * tried: the path the caller handed over (`rvw open --repo`), the one remembered for the authored
 * path, the one the session was last seated on, and the authored path itself. The first live one
 * wins without trying the rest; failing that, the most useful — ties going to the authored path
 * unless a path was handed over, so a refusal names what the reader actually asked about.
 *
 * Side effects are confined to the relocation memory: a handed-over path that went live is
 * remembered, and a remembered one that is no longer a repository at all is forgotten. A
 * remembered checkout that merely lacks the refs yet is kept — that is a worktree waiting on a
 * fetch, not a stale entry. */
export async function findReviewSource(
  deps: ReviewSourceDeps,
  origin: ReviewOrigin,
  { override, current }: { override: string | null; current: string | null },
): Promise<ReviewSourceCheck> {
  const authored = origin.repo.path;
  const remembered = deps.relocations.get(authored);
  const others = [...new Set([override, remembered, current])].filter(
    (path): path is string => path !== null && path !== authored,
  );

  const checks: ReviewSourceCheck[] = [];
  for (const path of others) {
    const check = await checkReviewSource(deps.runner, path, origin);
    if (check.kind === "live") {
      if (path === override) {
        deps.relocations.remember(authored, check.repo.path);
      }
      return check;
    }
    if (path === remembered && check.kind === "repoMissing" && check.failure.code === "notARepo") {
      deps.relocations.forget(authored);
    }
    checks.push(check);
  }

  const own = await checkReviewSource(deps.runner, authored, origin);
  if (own.kind === "live") {
    return own;
  }
  const ordered = override === null ? [own, ...checks] : [...checks, own];
  return ordered.reduce((best, check) => (usefulness(check) > usefulness(best) ? check : best));
}

/** Re-decide the pin of every restored review that has a choice to make, before the renderer's
 * first `sessions:list` sees them. Only a review carrying a patch has one: a refs-only review has
 * no other diff to fall back to, so there is nothing to re-decide and nothing to spawn for it.
 *
 * Sequential on purpose — a many-tab relaunch is exactly when a burst of parallel git spawns would
 * hurt, and the renderer only derives the visible session for the same reason. A session whose
 * source cannot be settled keeps the pin it had rather than being dropped: losing the tab would
 * cost the reader more than a stale pin. */
export async function repinReviewSessions(
  deps: ReviewSourceDeps & { store: SessionStore },
): Promise<void> {
  for (const listed of deps.store.list().sessions) {
    const origin = listed.reviewOrigin;
    if (origin === null || origin.patch === null || origin.patch.length === 0) {
      continue;
    }
    const check = await findReviewSource(deps, origin, {
      override: null,
      current: listed.source.repo.path,
    });
    const pin = pinReview(origin, check);
    // Re-read after the awaits: the check spawned git, and the stored session is the one to
    // change, not the snapshot this loop started from.
    const session = deps.store.list().sessions.find((candidate) => candidate.id === listed.id);
    if (!pin.ok || session === undefined) {
      continue;
    }
    const repinned = repinSession(session, pin);
    if (repinned !== session) {
      deps.store.update(repinned);
    }
  }
}
