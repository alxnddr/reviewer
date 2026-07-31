import type { RepoInfo } from "../../../../shared/git";
import type { Session, SessionId } from "../../../../shared/session";
import { NO_COLLAPSED_FILES, NO_READ_FILES } from "../../lib/read-progress";
import type { SessionSlice } from "./slice";

// The two ways a `SessionSlice` comes into being: from nothing (a repository the reader just
// opened) and from disk (a session main handed back). They sit together because the second is
// written as a set of named differences from the first, which is the only way the two stay
// honest about where they actually disagree.

/** The one `SessionSlice` literal there is: every slice in the app, in the preview harness and
 * in the tests is this shape with named differences layered over it.
 *
 * The defaults are a slice that has not done anything yet — nothing walked, nothing loaded,
 * nothing read, `needsDerive` set — which is exactly what a session restored from disk is
 * before its first activation. Everything else a caller wants is an override it has to write
 * down, which is the point: TypeScript catches a *missing* field, but a copy of the literal
 * whose default has quietly drifted from its neighbour's typechecks perfectly, and the two
 * copies this replaced already disagreed in four places with nothing anywhere saying why. */
export function createSessionSlice(
  { id, repo }: { id: SessionId; repo: RepoInfo },
  overrides?: Partial<SessionSlice>,
): SessionSlice {
  return {
    id,
    repo,
    log: null,
    branches: null,
    brush: null,
    head: null,
    base: null,
    selection: null,
    diff: { phase: "idle" },
    selectedFilePath: null,
    scrollTop: 0,
    commitSelection: null,
    comments: [],
    layers: [],
    overview: null,
    overviewOpen: false,
    reviewDiff: null,
    reviewSubrange: null,
    reviewOrigin: null,
    activeLayerId: null,
    lastChapterId: null,
    activeCommentId: null,
    pendingCommentScroll: null,
    // A slice with no progress behind it has read nothing, and has no artifact to have read
    // it against.
    readFiles: NO_READ_FILES,
    collapsedFiles: NO_COLLAPSED_FILES,
    readTotal: 0,
    reviewPath: null,
    needsDerive: true,
    requestTicket: 0,
    logTicket: 0,
    ...overrides,
  };
}

/** A restored slice before first activation: inputs from disk, derived state absent — which is
 * the factory's own default, so this names only what the session carries. */
export function restoredSlice(session: Session): SessionSlice {
  return createSessionSlice(
    { id: session.id, repo: session.source.repo },
    {
      head: session.head,
      base: session.base,
      selectedFilePath: session.selectedFilePath,
      scrollTop: session.scrollTop,
      commitSelection: session.commitSelection,
      comments: session.comments,
      layers: session.layers,
      overview: session.overview,
      // A review that carries a tour doc opens on it: the doc is where the review starts,
      // and a restore (or a fresh open, which lands here too) should read the same way as
      // the first open did. A session with no doc restores straight onto its diff.
      overviewOpen: session.overview !== null,
      reviewDiff: session.reviewDiff,
      reviewSubrange: session.reviewSubrange,
      reviewOrigin: session.reviewOrigin,
      // Progress comes back with the session, unlike the soloed layer and the focused comment
      // beside it. Those are where the reader's attention was, which a relaunch is entitled to
      // reset; this is what they have already done, which it is not. A restored review still
      // opens on its overview — but the overview now shows how far in they are.
      ...restoredProgress(session),
      reviewPath: session.reviewPath,
    },
  );
}

/** The persisted wire shape back into what the app reads it as. The mirror of
 * `persistedSession`'s conversion (`lib/session-projection.ts`), and kept next to the one
 * place that builds a slice so neither can drift from the other. */
function restoredProgress(
  session: Session,
): Pick<SessionSlice, "readFiles" | "collapsedFiles" | "readTotal"> {
  return {
    readFiles: new Map(Object.entries(session.readFiles)),
    collapsedFiles: new Set(session.collapsedFiles),
    readTotal: session.readTotal,
  };
}
