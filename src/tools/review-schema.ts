import * as z from "zod";
import { ReviewArtifact } from "../shared/review";

// The `.reviewer.json` contract, serialized. An authoring agent needs the artifact
// shape before it writes one; this derives that shape from the *same* `ReviewArtifact` zod
// schema `rvw emit`/`rvw check` parse with, so the published shape can never drift from the
// enforced one (a hand-written schema would). Pure and I/O-free: the CLI shell owns stdout.
//
// One asymmetry is load-bearing and stated in the emitted document rather than hidden:
// `ReviewArtifact`'s ascending-range `.refine` compares `endLine` against its sibling
// `startLine`, and JSON Schema has no keyword that relates two sibling properties. Zod
// drops such refinements silently — it does not even raise them as `unrepresentable`. So a
// consumer that only runs the emitted schema accepts a descending range that
// `rvw check` rejects. Rather than leak that gap, the schema carries the rule as prose
// (`description`, from the zod schemas themselves) and names the command that enforces the
// whole contract.

/** The emitted JSON Schema document. Aliased so callers name the contract rather than
 * zod's internal shape, and so a target change stays one edit. */
export type ReviewJsonSchema = z.core.JSONSchema.BaseSchema;

const SCHEMA_TITLE = ".reviewer.json";

const SCHEMA_DESCRIPTION = [
  "The Reviewer review artifact.",
  "Derived from the zod contract that `rvw emit` and `rvw check` enforce.",
  "Structural rules are expressed as JSON Schema; two classes of rule are not, because",
  "JSON Schema cannot express them: an anchor's ascending line range (endLine >= startLine,",
  "a comparison between sibling properties), and whether an anchor actually places on a hunk",
  "of the review's diff. Both are checked by `rvw emit` / `rvw check`, which is the",
  "authority — a document that satisfies this schema is well-formed, not necessarily valid.",
].join(" ");

/** `ReviewArtifact` as a JSON Schema document an agent authors against. Draft 2020-12 is
 * zod's default target and the one modern validators default to.
 *
 * `io: "input"` is the load-bearing option: the emitted document describes what may be
 * *written*, not what a parse yields. On the output side the schema-filled arrays
 * (`comments`, `layers`, a layer's `ranges`/`children`) all read as required, which would
 * tell an authoring agent to write `"children": []` under every leaf — the exact
 * ceremony this contract exists to remove. The layer schema is recursive, so it lands in
 * `$defs` and is referenced rather than inlined; everything else is self-contained. */
export function reviewArtifactJsonSchema(): ReviewJsonSchema {
  const schema = z.toJSONSchema(ReviewArtifact, { target: "draft-2020-12", io: "input" });
  return { ...schema, title: SCHEMA_TITLE, description: SCHEMA_DESCRIPTION };
}
