import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("runs a detached child like any other", async () => {
    const result = await runner.run({ cwd: workDir, args: ["--version"], detached: true });
    expect(result).toMatchObject({ ok: true });
  });

  it("takes a detached child's whole process group down on a timeout", async () => {
    // The shell stands in for git, the backgrounded sleep for the ssh it would have started:
    // killing the leader alone would leave the sleep running for its full 30 seconds.
    const shellRunner = createGitRunner({ gitBinary: "/bin/sh" });
    const pidFile = join(workDir, "helper.pid");
    const result = await shellRunner.run({
      cwd: workDir,
      args: ["-c", `sleep 30 & echo $! > ${pidFile}; wait`],
      timeoutMs: 300,
      detached: true,
    });
    expect(result).toEqual({ ok: false, failure: { code: "timeout" } });
    const helper = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(() => process.kill(helper, 0)).toThrow();
  });

  it("kills a run whose signal is aborted, and answers cancelled", async () => {
    const shellRunner = createGitRunner({ gitBinary: "/bin/sh" });
    const controller = new AbortController();
    const running = shellRunner.run({
      cwd: workDir,
      args: ["-c", "sleep 30 & wait"],
      detached: true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    expect(await running).toEqual({ ok: false, failure: { code: "cancelled" } });
    // Already aborted: nothing is spawned at all.
    expect(
      await runner.run({ cwd: workDir, args: ["--version"], signal: controller.signal }),
    ).toEqual({
      ok: false,
      failure: { code: "cancelled" },
    });
  });

  it("lets a timed-out child clean up on SIGTERM before anything harder", async () => {
    // The trap is git's own cleanup in miniature: it runs on SIGTERM and never on SIGKILL.
    const shellRunner = createGitRunner({ gitBinary: "/bin/sh", killGraceMs: 2_000 });
    const marker = join(workDir, "cleaned-up");
    const controller = new AbortController();
    const running = shellRunner.run({
      cwd: workDir,
      args: ["-c", `trap 'echo cleaned > ${marker}; exit 143' TERM; sleep 30 & wait`],
      detached: true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    expect(await running).toEqual({ ok: false, failure: { code: "cancelled" } });
    expect(readFileSync(marker, "utf8").trim()).toBe("cleaned");
  });

  it("SIGKILLs a child that ignores SIGTERM once the grace runs out", async () => {
    const shellRunner = createGitRunner({ gitBinary: "/bin/sh", killGraceMs: 200 });
    const started = Date.now();
    const result = await shellRunner.run({
      cwd: workDir,
      args: ["-c", "trap '' TERM; sleep 30 & wait"],
      timeoutMs: 100,
      detached: true,
    });
    expect(result).toEqual({ ok: false, failure: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(5_000);
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

  it("reports a cwd that is a file as cwdMissing, never a synchronous throw", async () => {
    // spawn throws ENOTDIR *synchronously* for this one, which would escape the
    // promise contract every caller relies on.
    const filePath = join(workDir, "not-a-dir.txt");
    writeFileSync(filePath, "contents\n");
    const result = await runner.run({ cwd: filePath, args: ["--version"] });
    expect(result).toEqual({ ok: false, failure: { code: "cwdMissing", cwd: filePath } });
  });
});
