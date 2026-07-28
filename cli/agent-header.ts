import type { LocalContext } from "./context";

// The first thing `rvw` says when it is asked what it is.
//
// No human ever types this command: it is run by a coding agent that was told to present its
// findings and given the tool's name, nothing more. That agent's next move is decided by the
// first lines it reads — and Stricli's help opens with a usage block listing six verbs, which
// invites picking one and guessing at the draft format instead of reading the one file that
// describes it. So the pointer goes above the help, not inside it.
//
// This is also what keeps the instruction a *user* pastes down to one sentence ("present the
// findings in Reviewer using the rvw CLI"): the procedure lives here, version-locked to the
// binary, rather than in a prompt written once and never updated.

/** Printed before Stricli's own output, on stdout, where the run is someone asking what this
 * command is. Kept to two claims — what rvw does not do, and the single next step. */
export const AGENT_HEADER = [
  "rvw hands a review your agent has already written to the Reviewer app.",
  "It never performs the review.",
  "",
  "AGENTS START HERE → run `rvw skills present-review` and follow the skill at the path it",
  "prints. It carries the draft format, the rules the gate enforces, and the one call that",
  "publishes. Read it before reaching for any verb below.",
  "",
  "",
].join("\n");

/** Whether this invocation is the "what is this" question rather than a job.
 *
 * Deliberately narrow: no arguments at all, or nothing but a top-level help flag. A run with
 * a verb is an agent that already knows what it is doing, and a header printed above
 * `rvw diff --json` would land in output something else is parsing. */
export function wantsAgentHeader(inputs: readonly string[]): boolean {
  return inputs.every((input) => input === "-h" || input === "--help" || input === "help");
}

export function writeAgentHeader(context: LocalContext, inputs: readonly string[]): void {
  if (wantsAgentHeader(inputs)) {
    context.process.stdout.write(AGENT_HEADER);
  }
}
