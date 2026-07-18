import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitRunner } from "./runner";

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "reviewer-runner-test-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("createGitRunner", () => {
  const runner = createGitRunner();

  it("captures stdout of a successful run", async () => {
    const result = await runner.run({ cwd: workDir, args: ["--version"] });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.stdout).toContain("git version");
  });

  it("reports a non-zero exit with its stderr for main-side diagnosis", async () => {
    const result = await runner.run({ cwd: workDir, args: ["rev-parse", "--verify", "HEAD"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("exited");
      if (result.failure.code === "exited") expect(result.failure.stderr.length).toBeGreaterThan(0);
    }
  });

  it("treats listed exit codes as success (git diff --no-index exits 1 on differences)", async () => {
    const filePath = join(workDir, "content.txt");
    writeFileSync(filePath, "some content\n");
    const args = ["diff", "--no-color", "--no-index", "--", "/dev/null", "content.txt"];

    const withoutOverride = await runner.run({ cwd: workDir, args });
    expect(withoutOverride.ok).toBe(false);

    const withOverride = await runner.run({ cwd: workDir, args, okExitCodes: [0, 1] });
    expect(withOverride.ok).toBe(true);
    if (withOverride.ok) expect(withOverride.stdout).toContain("+some content");
  });

  it("kills the child and reports overflow when output exceeds the cap", async () => {
    const result = await runner.run({ cwd: workDir, args: ["--version"], maxOutputBytes: 4 });
    expect(result).toEqual({ ok: false, failure: { code: "outputOverflow", limitBytes: 4 } });
  });

  it("kills the child and reports a timeout when it runs past the deadline", async () => {
    // The binary override doubles as the test seam for a child that never exits.
    const sleepRunner = createGitRunner({ gitBinary: "/bin/sleep" });
    const result = await sleepRunner.run({ cwd: workDir, args: ["5"], timeoutMs: 100 });
    expect(result).toEqual({ ok: false, failure: { code: "timeout" } });
  });

  it("reports a missing git binary", async () => {
    const brokenRunner = createGitRunner({ gitBinary: "/nonexistent/git" });
    const result = await brokenRunner.run({ cwd: workDir, args: ["--version"] });
    expect(result).toEqual({ ok: false, failure: { code: "gitMissing" } });
  });

  it("reports a vanished cwd instead of blaming the git binary", async () => {
    const gone = join(workDir, "never-created");
    const result = await runner.run({ cwd: gone, args: ["--version"] });
    expect(result).toEqual({ ok: false, failure: { code: "cwdMissing", cwd: gone } });
  });
});
