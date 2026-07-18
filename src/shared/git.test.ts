import { describe, expect, it } from "vitest";
import * as z from "zod";
import { BranchName, CommitSha, DiffSelection, GitResultOf, Patch, RepoPath } from "./git";

const SHA_40 = "a".repeat(40);
const SHA_64 = "b".repeat(64);

describe("RepoPath", () => {
  it("accepts an absolute path", () => {
    expect(RepoPath.parse("/Users/me/repo")).toBe("/Users/me/repo");
  });

  it.each(["repo", "../repo", ""])("rejects the non-absolute path %j", (path) => {
    expect(RepoPath.safeParse(path).success).toBe(false);
  });
});

describe("CommitSha", () => {
  it("accepts a full SHA-1 and a full SHA-256", () => {
    expect(CommitSha.safeParse(SHA_40).success).toBe(true);
    expect(CommitSha.safeParse(SHA_64).success).toBe(true);
  });

  it.each([
    "abc123", // abbreviation
    "HEAD", // rev expression, not a hash
    `-${"a".repeat(39)}`, // leading dash
    "A".repeat(40), // uppercase
    `${"a".repeat(39)} `, // whitespace
  ])("rejects %j", (sha) => {
    expect(CommitSha.safeParse(sha).success).toBe(false);
  });
});

describe("BranchName", () => {
  it.each(["main", "feature/login", "release-1.2", "v1.2.3", "hotfix_2"])("accepts %j", (name) => {
    expect(BranchName.safeParse(name).success).toBe(true);
  });

  it.each([
    "-foo",
    "--upload-pack=/tmp/evil",
    "a b",
    "a\tb",
    "a\nb",
    "a..b",
    "a~1",
    "a^",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a@{1}",
    ".hidden",
    "/leading",
    "trailing/",
    "trailing.",
    "a//b",
    "a.lock",
    "",
  ])("rejects %j", (name) => {
    expect(BranchName.safeParse(name).success).toBe(false);
  });
});

describe("DiffSelection", () => {
  it("accepts every variant", () => {
    const variants: DiffSelection[] = [
      { kind: "branches", base: "main", head: "feature/x" },
      { kind: "commitRange", first: SHA_40, last: SHA_40 },
      { kind: "commitRangeWithUncommitted", first: SHA_64 },
      { kind: "uncommitted" },
    ];
    for (const variant of variants) {
      expect(DiffSelection.parse(variant)).toEqual(variant);
    }
  });

  it("rejects a flag smuggled as a branch ref before any spawn could see it", () => {
    const selection = { kind: "branches", base: "--upload-pack=/tmp/evil", head: "main" };
    expect(DiffSelection.safeParse(selection).success).toBe(false);
  });

  it("rejects a ref containing whitespace", () => {
    const selection = { kind: "branches", base: "main", head: "main --exec=x" };
    expect(DiffSelection.safeParse(selection).success).toBe(false);
  });

  it("rejects a rev expression where a full sha is required", () => {
    const selection = { kind: "commitRange", first: "HEAD~3", last: "HEAD" };
    expect(DiffSelection.safeParse(selection).success).toBe(false);
  });

  it("rejects an unknown selection kind", () => {
    expect(DiffSelection.safeParse({ kind: "everything" }).success).toBe(false);
  });
});

describe("GitResultOf", () => {
  const PatchResult = GitResultOf(Patch);
  type PatchResult = z.infer<typeof PatchResult>;

  it("round-trips a success envelope", () => {
    const result: PatchResult = { ok: true, value: { patch: "diff --git a/x b/x\n" } };
    expect(PatchResult.parse(result)).toEqual(result);
  });

  it("round-trips a failure envelope", () => {
    const result: PatchResult = { ok: false, failure: { code: "outputOverflow", limitBytes: 1 } };
    expect(PatchResult.parse(result)).toEqual(result);
  });

  it("rejects an unknown failure code", () => {
    const result = { ok: false, failure: { code: "meltdown" } };
    expect(PatchResult.safeParse(result).success).toBe(false);
  });
});
