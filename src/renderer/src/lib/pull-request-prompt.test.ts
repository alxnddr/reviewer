import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../../../shared/settings";
import { expandPrompt, PROMPT_PLACEHOLDERS, type PromptValues } from "./pull-request-prompt";

const VALUES: PromptValues = {
  pr: "https://github.com/acme/widget/pull/12",
  worktree: "/Users/me/Library/Application Support/Reviewer/worktrees/acme/widget-12",
  base: "origin/main",
  head: "a".repeat(40),
};

describe("expandPrompt", () => {
  it("fills every placeholder, each as often as it appears", () => {
    expect(expandPrompt("{pr} {worktree} {base} {head} {pr}", VALUES)).toBe(
      `${VALUES.pr} ${VALUES.worktree} ${VALUES.base} ${VALUES.head} ${VALUES.pr}`,
    );
  });

  it("expands the default template into a prompt that names the PR for rvw", () => {
    const prompt = expandPrompt(SETTINGS_DEFAULTS.pullRequestPrompt, VALUES);
    expect(prompt).toContain(`--pr ${VALUES.pr} --repo "${VALUES.worktree}" --base ${VALUES.base}`);
    expect(prompt).toContain(VALUES.worktree);
    expect(prompt).toContain(`against ${VALUES.base}`);
    expect(prompt).not.toMatch(/\{(?:pr|worktree|base|head)\}/u);
  });

  it("leaves unknown placeholders and other braces as written", () => {
    expect(expandPrompt('{repo} {PR} { pr } {"a": 1} {pr}', VALUES)).toBe(
      `{repo} {PR} { pr } {"a": 1} ${VALUES.pr}`,
    );
  });

  it("does not expand a placeholder that arrives inside a value", () => {
    const values = { ...VALUES, worktree: "/tmp/{head}" };
    expect(expandPrompt("{worktree} {head}", values)).toBe(`/tmp/{head} ${VALUES.head}`);
  });

  it("inserts a value with $-patterns literally", () => {
    const values = { ...VALUES, worktree: "/tmp/$&-$1-$$" };
    expect(expandPrompt("at {worktree}", values)).toBe("at /tmp/$&-$1-$$");
  });

  it("lists exactly the placeholders it expands", () => {
    for (const placeholder of PROMPT_PLACEHOLDERS) {
      expect(expandPrompt(placeholder, VALUES)).not.toBe(placeholder);
    }
  });
});
