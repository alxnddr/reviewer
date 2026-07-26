import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The exit-code contract on the *real* process: Stricli's `run` leaves a code in
// `process.exitCode`, and index.ts collapses it to 0/1/2 and calls `process.exit`.
// The in-process suite (app.test.ts) proves the routing; this proves the wiring — that
// the shipped entrypoint, invoked as an agent invokes it, actually exits with those
// codes, including the negative Stricli failure codes normalized to 2.

const VALID_ARTIFACT = JSON.stringify({
  version: 1,
  source: { kind: "local", repo: { path: "/repo", name: "repo" }, base: "main", head: "feature" },
  patch: [
    "diff --git a/src/bar.ts b/src/bar.ts",
    "index 3333333..4444444 100644",
    "--- a/src/bar.ts",
    "+++ b/src/bar.ts",
    "@@ -1,2 +1,3 @@",
    " keep1",
    "+added2",
    " keep3",
    "",
  ].join("\n"),
  comments: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2, body: "note" }],
  layers: [
    {
      id: "leaf",
      label: "Leaf",
      summary: "child",
      // A stop, so it points at code: a layer with no ranges of its own is a heading, and
      // a heading with nothing under it is what the gate refuses.
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
    },
  ],
});

function fixture(bytes: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-rvw-"));
  const file = join(dir, "artifact.reviewer.json");
  writeFileSync(file, bytes);
  return file;
}

function rvw(args: readonly string[]): { status: number | null; stderr: string } {
  // Invoked through the `cli` script so the test also proves package.json forwards the
  // verb + args to the entrypoint — the exact `bun run cli validate …` path the skill
  // and an agent use.
  const result = spawnSync("bun", ["run", "cli", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe("rvw entrypoint exit codes (real process)", () => {
  it("exits 0 on a valid artifact", () => {
    expect(rvw(["validate", fixture(VALID_ARTIFACT)]).status).toBe(0);
  });

  it("exits 1 on a mis-anchored artifact", () => {
    const misAnchored = JSON.parse(VALID_ARTIFACT) as { comments: unknown[] };
    misAnchored.comments = [
      { file: "src/bar.ts", side: "additions", startLine: 900, endLine: 900, body: "drifted" },
    ];
    const { status, stderr } = rvw(["validate", fixture(JSON.stringify(misAnchored))]);
    expect(status).toBe(1);
    expect(stderr).toContain("does not place");
  });

  it("exits 2 when the artifact cannot be read", () => {
    const { status, stderr } = rvw(["validate", join(tmpdir(), "reviewer-rvw-missing.json")]);
    expect(status).toBe(2);
    expect(stderr).toContain("cannot read");
  });

  it("exits 2 on an unknown verb (Stricli's negative code normalized to shell-cannot-run)", () => {
    expect(rvw(["frobnicate"]).status).toBe(2);
  });
});
