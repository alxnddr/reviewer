// The prompt Review Pull Request… hands the reader for their agent: the template from Settings
// (`pullRequestPrompt`) with the prepared pull request's facts written into it. Pure, so the
// rules are tested rather than eyeballed in a dialog:
//
// - **Exactly four placeholders**, `{pr}`, `{worktree}`, `{base}`, `{head}`. Anything else in
//   braces is the reader's own text and is left as written — a template that says
//   `{"severity": …}` to its agent must not lose its braces to a substitution it never asked
//   for.
// - **One pass, no recursion.** Each placeholder is replaced by its value and the value is not
//   read again, so a worktree path that happened to contain `{head}` stays a path.
// - **Values are inserted literally.** The replacement is a function, never a replacement
//   string, because `String.replace` reads `$&` and `$1` inside a replacement *string* — and a
//   directory name may hold a `$`.
//
// What the values are is decided by the caller from the prepared pull request
// (`PreparedPullRequest`), not here: `{pr}` the pull request's URL (what `rvw emit --pr` reads
// unambiguously, and an address the agent can open), `{worktree}` the absolute path, `{base}`
// the remote-tracking branch the fetch just updated (`origin/main`), `{head}` the full sha.

/** The placeholders a template may use, in the order the Settings row lists them. */
export const PROMPT_PLACEHOLDERS = ["{pr}", "{worktree}", "{base}", "{head}"] as const;

export type PromptValues = {
  readonly pr: string;
  readonly worktree: string;
  readonly base: string;
  readonly head: string;
};

const PLACEHOLDER = /\{(pr|worktree|base|head)\}/gu;

/** `template` with every known placeholder replaced by its value, in a single pass. */
export function expandPrompt(template: string, values: PromptValues): string {
  return template.replaceAll(PLACEHOLDER, (_match, name: keyof PromptValues) => values[name]);
}
