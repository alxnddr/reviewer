import { parsePullRequestArg, type PullRequest } from "../../../shared/pull-request";
import type { PullRequestInputProblem } from "./pull-request-failure-message";

// What the Review Pull Request… field holds, read the moment it changes: nothing yet, a pull
// request, or a problem the dialog names under the field. One parser for the dialog and
// `rvw emit --pr` (`shared/pull-request.ts`), so the two cannot disagree about whether an
// address names a pull request; the dialog adds only the refusal of a bare number, which the
// CLI can complete from its checkout and the dialog cannot (`pullRequestInputMessage`).

export type PullRequestInput =
  | { kind: "empty" }
  | { kind: "pullRequest"; pullRequest: PullRequest }
  | { kind: "problem"; problem: PullRequestInputProblem };

export function readPullRequestInput(text: string): PullRequestInput {
  if (text.trim() === "") {
    return { kind: "empty" };
  }
  const parsed = parsePullRequestArg(text);
  if (!parsed.ok) {
    return { kind: "problem", problem: parsed.reason };
  }
  return parsed.arg.kind === "number"
    ? { kind: "problem", problem: "number" }
    : { kind: "pullRequest", pullRequest: parsed.arg.pullRequest };
}
