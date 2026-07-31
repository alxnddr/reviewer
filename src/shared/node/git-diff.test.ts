import { describe, expect, it } from "vitest";
import {
  DIFF_ARGS,
  DIFF_CONFIG,
  GIT_ENV_PINS,
  GIT_ENV_STRIP,
  committedDiffArgs,
  hardenedGitEnv,
  rangeDiffArgs,
  rangeSpec,
} from "./git-diff";

// The correctness pin. The app's git runner and the CLI's both build a review range's
// diff from these, so the *shape* of the argument vector is the contract: a two-dot range
// or a dropped `--` would produce a patch whose line numbers no longer match the anchors
// authored against it — coverage and anchor placement would drift in silence, which is the
// exact failure this module exists to prevent. Asserted here so a drift is a red test, not
// a wrong review.

describe("rangeSpec", () => {
  it("is three-dot, so a range is what head adds over the merge base", () => {
    expect(rangeSpec("main", "feature")).toBe("main...feature");
  });
});

describe("committedDiffArgs", () => {
  it("wraps the revs in the pinned config and flags, terminated by `--`", () => {
    expect(committedDiffArgs(["main...feature"])).toEqual([
      ...DIFF_CONFIG,
      ...DIFF_ARGS,
      "main...feature",
      "--",
    ]);
  });

  it("ends with `--` so a rev that looks like a path can never be read as one", () => {
    expect(committedDiffArgs(["main...feature"]).at(-1)).toBe("--");
  });
});

describe("rangeDiffArgs", () => {
  it("is the committed-diff vector over the three-dot range — one builder, both runners", () => {
    expect(rangeDiffArgs("main", "feature")).toEqual(
      committedDiffArgs([rangeSpec("main", "feature")]),
    );
  });
});

// The env-hardening pin. The CLI's sync spawnSync adapter (cli/git.ts) and the app's
// async/streaming runner (src/main/git/runner.ts) each build their child's env by calling
// this one function — asserted here so the posture (no prompts, no optional locks, C locale,
// no leaked GIT_* repo overrides) cannot drift silently back into two copies.
describe("hardenedGitEnv", () => {
  it("pins the hardening vars, overriding whatever the base env carries", () => {
    const base = { GIT_TERMINAL_PROMPT: "1", LC_ALL: "en_US.UTF-8", PATH: "/usr/bin" };
    expect(hardenedGitEnv(base)).toEqual({ PATH: "/usr/bin", ...GIT_ENV_PINS });
  });

  it("strips the GIT_* overrides that would redirect to a different repo", () => {
    const base = {
      GIT_DIR: "/other/.git",
      GIT_WORK_TREE: "/other",
      GIT_INDEX_FILE: "/other/.git/index",
      PATH: "/usr/bin",
    };
    const env = hardenedGitEnv(base);
    for (const key of GIT_ENV_STRIP) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
  });

  it("leaves the rest of the base env untouched", () => {
    const base = { CUSTOM_VAR: "kept", PATH: "/usr/bin" };
    expect(hardenedGitEnv(base)).toEqual({ ...base, ...GIT_ENV_PINS });
  });

  it("returns a fresh object rather than mutating the base — the base is `process.env` at both call sites", () => {
    const base = { GIT_DIR: "/elsewhere/.git", LC_ALL: "en_US.UTF-8" };
    const env = hardenedGitEnv(base);
    expect(base).toEqual({ GIT_DIR: "/elsewhere/.git", LC_ALL: "en_US.UTF-8" });
    expect(env).not.toBe(base);
  });
});
