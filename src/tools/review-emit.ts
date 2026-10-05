import { countLabel } from "../shared/plural";
import { hasPostable } from "../shared/postable-comment";
import type { PullRequest } from "../shared/pull-request";
import type { ReviewArtifact } from "../shared/review";
import { parseReviewArtifact, validatePlacement, type ValidationProblem } from "./review-validator";

// The assembly half of the authoring skill: turn the agent's authored comments/layers into the
// minimal wire shape and gate every anchor's placement against the captured patch
// before any bytes escape — writing a **refs-only** artifact (no embedded `patch`) by default,
// which the app re-derives `base...head` from git on open. The captured diff is then the
// validation authority and not artifact content: it proves each anchor places, then is
// discarded. `embedPatch` keeps it instead — see the flag's note below. Pure and I/O-free — the
// `rvw emit` shell owns the git spawn and the file write; this module only assembles and decides.
// The gate lives here (not in the shell) so "a failing artifact is never written" is a property
// of the returned value, not of prose the agent might skip: only a clean pass yields bytes, so
// the shell has nothing to write on failure.

/** The pieces the shell captures for one artifact. `repo` is the work-tree toplevel, kept
 * loose (a plain string, not the branded `RepoPath`): the gate re-parses it through
 * `RepoPath`, so a second brand here would be a drifting duplicate. `patch` is the captured
 * diff, always the placement authority and — unless `embedPatch` says otherwise — never
 * written into the artifact. `comments`/`layers` stay `unknown` because they are untrusted
 * draft content the agent hand-authored — the single validation authority below schema-checks
 * them (parse-don't-trust); a second shape check here would be a drifting duplicate of
 * `ReviewArtifact`. */
export type EmitInput = {
  repo: string;
  base: string;
  head: string;
  /** The commit `head` resolved to, written through to the artifact's `reviewedHead`.
   * Provenance and nothing else: the gate below never reads it, so an artifact with it and
   * one without it pass or fail identically. Optional here because it is the shell that
   * resolves refs — a caller assembling an artifact from something other than a live range
   * has no sha to offer, and an absent one is an absent key. */
  reviewedHead?: string;
  /** The pull request the review is of, written through to the artifact's `pr` — already
   * resolved by the shell (`cli/pull-request.ts`), which owns reading the `origin` remote a
   * bare `--pr 123` needs. Provenance like `reviewedHead`: the gate never reads it. Absent on
   * a review of the reader's own branch, and then absent from the file. */
  pr?: PullRequest;
  patch: string;
  /** Carry the captured diff *in* the artifact, making it readable on a machine that does not
   * have the repo — the CI case, where the review is produced on a runner whose checkout path
   * and refs mean nothing to the reader who downloads it. Off by default: a refs-only artifact
   * is the smaller, truer file whenever the repo is at hand, and it is the only form that can
   * still show the change as it stands *now* rather than as it stood at emit.
   *
   * The trade the caller is making is not about validation — an embedded artifact is gated
   * against exactly the bytes it carries, which is strictly the stronger check. It is about
   * what the app can then offer: a frozen diff cannot expand context around a hunk and cannot
   * be narrowed to a subrange of its commits, because both read git. */
  embedPatch?: boolean;
  comments: unknown;
  layers: unknown;
  /** The authored tour doc, or `undefined` when the draft carries none — untrusted like
   * the rest, and dropped from the assembled JSON when absent (the artifact key is
   * optional, so an absent overview is an absent key, never `null`). */
  overview?: unknown;
};

/** Bytes ready to write, or the reasons the artifact is not fit to hand over — never
 * both. Mirrors the validation report so the shell can print problems with `describeProblem`.
 * A clean pass also hands back the artifact those bytes parse to, so what the shell reports
 * about the review (`postableGap`) is read off the validated value rather than off the
 * untrusted draft it came from. */
export type EmitResult =
  | { ok: true; bytes: string; artifact: ReviewArtifact }
  | { ok: false; problems: ValidationProblem[] };

/** Assemble the artifact and gate every anchor against the captured diff. Returns the exact
 * bytes only when every anchor places and every description link resolves — the load-bearing
 * "self-validate before handoff" step, reusing the domain the app anchors with rather than a
 * second checker that could pass what the app fails. */
export function emitReviewArtifact(input: EmitInput): EmitResult {
  // The minimal wire shape, **refs-only** unless the caller asked for the diff to ride along:
  // with no `patch` the app re-derives `base...head` from git on open. The draft's
  // `comments`/`layers` pass through untouched —
  // the app stamps every id on import and re-sorts nothing, so what the agent nested and
  // ordered is what a reader sees. An absent key stays absent (`JSON.stringify` drops an
  // undefined value) and the schema defaults it to empty, so a comments-only or layers-only
  // draft needs no placeholder for the half it does not carry.
  const candidate = {
    repo: input.repo,
    base: input.base,
    head: input.head,
    // Undefined drops the key (`JSON.stringify`), which is the absent-optional shape the
    // schema wants — the same rule `overview` below relies on.
    reviewedHead: input.reviewedHead,
    // The same absent-when-undefined rule: only a review emitted with `--pr` names one.
    pr: input.pr,
    // Absent unless asked for, and absent rather than null when the capture came back empty:
    // the schema's `patch` is a non-empty string, and an empty one is not a diff the app
    // could freeze anyway — it would fall through to the refs form on open (`pinReview`),
    // so writing it would only promise portability the file cannot keep.
    patch: input.embedPatch === true && input.patch.length > 0 ? input.patch : undefined,
    // `JSON.stringify` drops an undefined value, so a draft with no overview emits no
    // key at all — the optional-absent shape, not an explicit null the schema rejects.
    overview: input.overview,
    comments: input.comments,
    layers: input.layers,
  };
  const bytes = JSON.stringify(candidate, null, 2);

  // The authored comments/layers are untrusted, so parse the assembled bytes back before
  // placing — then gate every anchor against the captured diff, which is the emit-time
  // authority whether or not a copy of it also went into the file.
  const parsed = parseReviewArtifact(bytes);
  if (!parsed.ok) {
    return { ok: false, problems: parsed.problems };
  }
  const problems = validatePlacement(parsed.artifact, input.patch);
  return problems.length === 0
    ? { ok: true, bytes, artifact: parsed.artifact }
    : { ok: false, problems };
}

/** How many of the review's comments carry no text for the change's author, out of how many.
 * `rvw emit --pr` reports it as one informational line, never as a problem: a comment without
 * `postable` is one the reader can still read, and may well be one they never meant to post —
 * so the count changes no exit code and refuses nothing. */
export function postableGap(artifact: ReviewArtifact): { missing: number; total: number } {
  // `hasPostable`, so a whitespace-only `postable` counts as missing here exactly as the app
  // reads it: no block on the card, nothing to copy.
  const missing = artifact.comments.filter((comment) => !hasPostable(comment)).length;
  return { missing, total: artifact.comments.length };
}

/** `3 of 7 comments have no postable text` — the verb agreeing with the count that has none,
 * so one missing reads `1 of 7 comments has`. Beside the count it renders, so the sentence and
 * the number cannot be maintained apart. */
export function postableGapLine(gap: { missing: number; total: number }): string {
  return `${gap.missing} of ${countLabel(gap.total, "comment")} ${gap.missing === 1 ? "has" : "have"} no postable text`;
}
