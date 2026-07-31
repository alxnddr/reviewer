import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { StricliProcess } from "@stricli/core";
import { afterAll, describe, expect, it } from "vitest";
import { outPathFor } from "./commands/emit";
import { buildContext } from "./context";
import { runCli, testContext } from "./fixtures";

// The process seams, proven one at a time and without a repo. Everything here used to require
// either mutating the real process (`chdir`, a redefined `isTTY`, a redefined `platform`, an
// assigned `process.env.RVW_HOME`) or standing up a git fixture in a temp dir for an assertion
// that was never about git: which directory a defaulted range is resolved from, where an
// `--out`-less artifact lands, which platform the launcher branches on, and what `rvw emit`
// does with the draft on fd 0. They are context fields now, so each is a run given the value it
// is about.
//
// The suites that *are* about git keep their fixtures: `emit.test.ts` and `live-range.test.ts`
// still build real repos, because a captured patch and a resolved fork point cannot be faked.

const roots: string[] = [];

/** A directory that does not exist, under a name no repo will ever have — so a run given it as
 * its cwd fails with git naming *that path*, which is the assertion: the range was resolved
 * from the context's cwd and not from the one this test process happens to be in (which is this
 * checkout, itself a repo that would have resolved). */
const NOWHERE = join(tmpdir(), "rvw-context-not-a-repo-93e1");

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("buildContext", () => {
  it("reports the real process, so what the tests inject is what the entrypoint supplies", () => {
    // The one place the seams are read for real. If a field here drifted from its global — a
    // `cwd` captured from somewhere else, a `home` read out of `$HOME` — every suite below
    // would keep passing while the shipped CLI resolved against something else entirely.
    const context = buildContext(process);
    expect(context.cwd).toBe(process.cwd());
    expect(context.env).toBe(process.env);
    expect(context.platform).toBe(process.platform);
    expect(context.home).toBe(homedir());
    expect(context.process.stdout).toBe(process.stdout);
    expect(context.process.stderr).toBe(process.stderr);
    // `null`, not the real `process.exitCode`: Stricli fills it with `??=` and the entrypoint
    // reads it back.
    expect(context.process.exitCode).toBe(null);
  });

  it("reports a terminal on fd 0 as a read that will never complete, rather than starting it", () => {
    // The guard the whole `readStdin` seam exists for, proven on the real adapter rather than on
    // an injected one: with a terminal on fd 0 nothing was piped and nothing ever will be, so a
    // `readFileSync(0)` would hang `rvw` forever with nothing on either stream. Every suite below
    // hands `run(...)` a `readStdin` of its own, so this is the only place the decision itself is
    // made. A stub process, not the real one — the point is to declare fd 0 a terminal without
    // redefining `isTTY` on the process this worker shares. (The arm where fd 0 *does* deliver
    // bytes is proven for real in `exit-gate.test.ts`, where the draft is piped into a spawned
    // bundle; it cannot be proven here without reading this worker's own fd 0.)
    const context = buildContext({
      stdout: process.stdout,
      stderr: process.stderr,
      cwd: () => "/work/repo",
      env: { RVW_HOME: "/elsewhere/rvw" },
      platform: "linux",
      stdin: { isTTY: true },
    } as unknown as NodeJS.Process);

    expect(context.readStdin()).toEqual({ ok: false, reason: "tty" });
    // And the rest is threaded off that same object, so a field can never be filled from the
    // ambient process while the others come from the argument.
    expect(context.cwd).toBe("/work/repo");
    expect(context.env).toEqual({ RVW_HOME: "/elsewhere/rvw" });
    expect(context.platform).toBe("linux");
  });
});

describe("the cwd a range defaults from", () => {
  it("resolves the repo from the context's cwd, not the process's", async () => {
    const result = await runCli(["diff"], { cwd: NOWHERE });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(NOWHERE);
  });

  it("prefers an explicit --repo over it, so the cwd is only ever the default", async () => {
    const result = await runCli(["diff", "--repo", NOWHERE], { cwd: tmpdir() });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(NOWHERE);
  });
});

describe("where an --out-less artifact lands", () => {
  const range = { repoPath: "/work/repo", base: "main", head: "feature" };

  it("hangs the default under the context's home, never the developer's", () => {
    const context = testContext({} as StricliProcess, { env: {}, home: "/home/agent" });
    expect(outPathFor(context, undefined, range, 1700000000000)).toBe(
      "/home/agent/.rvw/reviews/repo-main-feature-1700000000000.reviewer.json",
    );
  });

  it("honors $RVW_HOME from the context's environment", () => {
    const context = testContext({} as StricliProcess, {
      env: { RVW_HOME: "/elsewhere/rvw" },
      home: "/home/agent",
    });
    expect(outPathFor(context, undefined, range, 1)).toBe(
      "/elsewhere/rvw/reviews/repo-main-feature-1.reviewer.json",
    );
  });

  it("resolves a given --out against the context's cwd, because the launcher needs it absolute", () => {
    const context = testContext({} as StricliProcess, { cwd: "/work/repo", home: "/home/agent" });
    expect(outPathFor(context, "change.reviewer.json", range, 1)).toBe(
      "/work/repo/change.reviewer.json",
    );
    expect(outPathFor(context, "/tmp/change.reviewer.json", range, 1)).toBe(
      "/tmp/change.reviewer.json",
    );
  });
});

describe("the platform the launcher branches on", () => {
  it("declines on a platform Reviewer does not ship for, and says how to open it by hand", async () => {
    // A real artifact path (`open` stats it before launching) but no repo: what is under test is
    // the branch, and on darwin this same run would have spawned `/usr/bin/open`.
    const artifact = join(tempRoot("rvw-context-open-"), "change.reviewer.json");
    writeFileSync(artifact, "{}");

    const result = await runCli(["open", artifact], { platform: "linux" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("linux");
    expect(result.stderr).toContain("File → Open");
  });

  it("reports it as a cannot-run envelope for a --json caller", async () => {
    const artifact = join(tempRoot("rvw-context-open-json-"), "change.reviewer.json");
    writeFileSync(artifact, "{}");

    const result = await runCli(["open", artifact, "--json"], { platform: "linux" });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "notInstalled" },
    });
    expect(result.stderr).toBe("");
  });
});

describe("the draft on stdin", () => {
  it("refuses to wait on a stdin nobody will write to, both ways of naming it", async () => {
    // With no --draft the draft comes from stdin — but a *terminal* on stdin is a read that can
    // never complete, so the command names both ways in rather than hanging. (The stdin draft
    // itself is piped for real in `exit-gate.test.ts`, where the bundle is a spawned process.)
    // `--draft -` is the *documented* way to ask for stdin, so it is the same read and must
    // produce the same guidance — not a wait for an EOF the terminal will never send.
    for (const args of [
      ["emit", "--json"],
      ["emit", "--draft", "-", "--json"],
    ]) {
      const result = await runCli(args, { readStdin: () => ({ ok: false, reason: "tty" }) });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        // The same sentence, not merely the same code: a read that reaches fd 0 fails
        // `draftUnreadable` too, but on whatever fd 0 happened to be (an EAGAIN, or bytes
        // that are not JSON) — none of which tells a caller whose terminal simply never
        // sent anything what to do next.
        error: {
          code: "draftUnreadable",
          message: "no draft: pass --draft <file>, or pipe the draft JSON on stdin",
        },
      });
    }
  });

  it("reads the draft from the context, before it spawns anything", async () => {
    // The bytes are the context's, and they are read first: a draft that presents nothing is
    // refused with no cwd to resolve and no git to run — which is why this needs no repo.
    const empty = await runCli(["emit", "--json"], {
      cwd: NOWHERE,
      readStdin: () => ({ ok: true, bytes: "{}" }),
    });
    expect(empty.code).toBe(2);
    expect(JSON.parse(empty.stdout)).toMatchObject({ ok: false, error: { code: "draftEmpty" } });

    const malformed = await runCli(["emit", "--json"], {
      cwd: NOWHERE,
      readStdin: () => ({ ok: true, bytes: "not json" }),
    });
    expect(malformed.code).toBe(2);
    expect(JSON.parse(malformed.stdout).error.message).toContain("draft stdin is not valid JSON");
  });

  it("names a failed read of fd 0 as such, distinctly from a terminal", async () => {
    const result = await runCli(["emit", "--json"], {
      readStdin: () => ({ ok: false, reason: "failed", message: "EAGAIN: resource unavailable" }),
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "draftUnreadable",
        message: "cannot read draft from stdin: EAGAIN: resource unavailable",
      },
    });
  });

  it("does not read stdin at all when --draft names a file", async () => {
    // The one arm that must never touch fd 0: a named draft is read from disk, so a `readStdin`
    // that throws is proof the command never called it.
    const draft = join(tempRoot("rvw-context-draft-"), "draft.json");
    writeFileSync(draft, JSON.stringify({ comments: [] }));

    const result = await runCli(["emit", "--draft", draft, "--json"], {
      cwd: NOWHERE,
      readStdin: () => {
        throw new Error("stdin must not be read for a named draft");
      },
    });
    // Past the draft, refused at the range: the cwd is not a repo (see NOWHERE).
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "gitFailed" } });
  });
});
