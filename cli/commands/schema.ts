import { buildCommand } from "@stricli/core";
import { reviewArtifactJsonSchema } from "../../src/tools/review-schema";
import { EXIT_READY, type LocalContext } from "../context";

// `rvw schema` — the artifact shape an agent authors against, derived from the same
// `ReviewArtifact` zod contract `rvw validate` parses with, never hand-written (the
// hand-written copy is the one that drifts). Read-only and I/O-free apart from stdout, so it
// cannot fail: there is no input to reject and no file to read. Exit 0, always.

type SchemaFlags = {
  readonly json?: boolean;
};

/** The rules JSON Schema structurally cannot carry, restated where a human reading the text
 * output will see them. Not a substitute for the schema's own `description` (an agent
 * parsing `--json` reads that one); this is the same truth on the human channel. */
const ENFORCEMENT_NOTE = [
  "",
  "note: a document satisfying this schema is well-formed, not necessarily valid.",
  "      JSON Schema cannot express an anchor's ascending line range (endLine >= startLine",
  "      compares two sibling properties), nor whether an anchor places on a hunk of the",
  "      review's diff. `rvw validate` and `rvw check` enforce both.",
];

export const schemaCommand = buildCommand<SchemaFlags, [], LocalContext>({
  docs: {
    brief: "Print the .reviewer.json JSON Schema, derived from the enforced zod contract",
    fullDescription: [
      "Emits the JSON Schema for the review artifact, derived from the same `ReviewArtifact`",
      "zod schema the validator parses with, so the shape you author against is the shape that",
      "is enforced. --json emits the schema alone (pipe it to a file or a validator); text mode",
      "pretty-prints it and appends the rules JSON Schema cannot express. Exit 0.",
    ].join("\n"),
    customUsage: ["", "--json", "--json > reviewer.schema.json"],
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit the JSON Schema alone on stdout, with no trailing note",
        optional: true,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  func(this: LocalContext, flags: SchemaFlags): void {
    this.process.stdout.write(`${JSON.stringify(reviewArtifactJsonSchema(), null, 2)}\n`);
    if (!flags.json) {
      for (const line of ENFORCEMENT_NOTE) {
        this.process.stdout.write(`${line}\n`);
      }
    }
    this.process.exitCode = EXIT_READY;
  },
});
