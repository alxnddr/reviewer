import { parseReviewArtifact, validatePlacement, type ValidationProblem } from "./review-validator";

// The assembly half of the authoring skill: turn the agent's authored comments/layers into the
// minimal `version: 1` wire shape and gate every anchor's placement against the captured patch
// before any bytes escape — but write a **refs-only** artifact (no embedded `patch`), which the
// app re-derives `base...head` from git on open. The captured diff is the validation authority,
// not artifact content: it proves each anchor places, then is discarded. Pure and I/O-free — the
// `rvw emit` shell owns the git spawn and the file write; this module only assembles and decides.
// The gate lives here (not in the shell) so "a failing artifact is never written" is a property
// of the returned value, not of prose the agent might skip: only a clean pass yields bytes, so
// the shell has nothing to write on failure.

/** The repo a captured patch came from, kept loose (plain strings, not the branded
 * `RepoPath`): the gate re-parses it through `RepoInfo`/`RepoPath`, so a second brand
 * here would be a drifting duplicate. */
export type EmitRepo = { path: string; name: string };

/** The pieces the shell captures for one artifact. `patch` is the captured diff used
 * *only* to validate anchor placement — it is never written into the artifact.
 * `comments`/`layers` stay `unknown` because they are untrusted draft content the agent
 * hand-authored — the single validation authority below schema-checks them (parse-don't-trust);
 * a second shape check here would be a drifting duplicate of `ReviewArtifact`. */
export type EmitInput = {
  repo: EmitRepo;
  base: string;
  head: string;
  patch: string;
  comments: unknown;
  layers: unknown;
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
  // `base...head` from git on open. The app assigns each comment an `id` and re-sorts nothing,
  // so `layers` order is emitted as authored.
  const candidate = {
    version: 1,
    source: { kind: "local", repo: input.repo, base: input.base, head: input.head },
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
