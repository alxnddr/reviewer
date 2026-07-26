import { parseReviewArtifact, validatePlacement, type ValidationProblem } from "./review-validator";

// The assembly half of the authoring skill: turn the agent's authored comments/layers into the
// minimal wire shape and gate every anchor's placement against the captured patch
// before any bytes escape — but write a **refs-only** artifact (no embedded `patch`), which the
// app re-derives `base...head` from git on open. The captured diff is the validation authority,
// not artifact content: it proves each anchor places, then is discarded. Pure and I/O-free — the
// `rvw emit` shell owns the git spawn and the file write; this module only assembles and decides.
// The gate lives here (not in the shell) so "a failing artifact is never written" is a property
// of the returned value, not of prose the agent might skip: only a clean pass yields bytes, so
// the shell has nothing to write on failure.

/** The pieces the shell captures for one artifact. `repo` is the work-tree toplevel, kept
 * loose (a plain string, not the branded `RepoPath`): the gate re-parses it through
 * `RepoPath`, so a second brand here would be a drifting duplicate. `patch` is the captured
 * diff used *only* to validate anchor placement — it is never written into the artifact.
 * `comments`/`layers` stay `unknown` because they are untrusted draft content the agent
 * hand-authored — the single validation authority below schema-checks them (parse-don't-trust);
 * a second shape check here would be a drifting duplicate of `ReviewArtifact`. */
export type EmitInput = {
  repo: string;
  base: string;
  head: string;
  patch: string;
  comments: unknown;
  layers: unknown;
  /** The authored tour doc, or `undefined` when the draft carries none — untrusted like
   * the rest, and dropped from the assembled JSON when absent (the artifact key is
   * optional, so an absent overview is an absent key, never `null`). */
  overview?: unknown;
};

/** Bytes ready to write, or the reasons the artifact is not fit to hand over — never
 * both. Mirrors the validation report so the shell can print problems with `describeProblem`. */
export type EmitResult = { ok: true; bytes: string } | { ok: false; problems: ValidationProblem[] };

/** Assemble the refs-only artifact and gate every anchor against the captured diff. Returns
 * the exact bytes only when every anchor places and every description link resolves — the
 * load-bearing "self-validate before handoff" step, reusing the domain the app anchors with
 * rather than a second checker that could pass what the app fails. */
export function emitReviewArtifact(input: EmitInput): EmitResult {
  // The minimal wire shape, **refs-only**: no embedded `patch`, so the app re-derives
  // `base...head` from git on open. The draft's `comments`/`layers` pass through untouched —
  // the app stamps every id on import and re-sorts nothing, so what the agent nested and
  // ordered is what a reader sees. An absent key stays absent (`JSON.stringify` drops an
  // undefined value) and the schema defaults it to empty, so a comments-only or layers-only
  // draft needs no placeholder for the half it does not carry.
  const candidate = {
    repo: input.repo,
    base: input.base,
    head: input.head,
    // `JSON.stringify` drops an undefined value, so a draft with no overview emits no
    // key at all — the optional-absent shape, not an explicit null the schema rejects.
    overview: input.overview,
    comments: input.comments,
    layers: input.layers,
  };
  const bytes = JSON.stringify(candidate, null, 2);

  // The authored comments/layers are untrusted, so parse the assembled bytes back before
  // placing — then gate every anchor against the captured diff (the emit-time authority),
  // never against artifact content the refs-only file no longer carries.
  const parsed = parseReviewArtifact(bytes);
  if (!parsed.ok) {
    return { ok: false, problems: parsed.problems };
  }
  const problems = validatePlacement(parsed.artifact, input.patch);
  return problems.length === 0 ? { ok: true, bytes } : { ok: false, problems };
}
