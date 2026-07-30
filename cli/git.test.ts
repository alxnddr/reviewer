import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

// The one claim about the CLI's git runner a fixture repo cannot make: what happens when the
// child never comes back. A git hung on a stalled network mount, an `fsmonitor`, or a hook is
// not a slow test to write but one that never ends, so the spawn is faked here — everything
// else about this module is proven against real repos in `emit.test.ts` and `live-range.test.ts`.
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const { git } = await import("./git");
const spawnSyncMock = vi.mocked(spawnSync);

/** What a child killed by `spawnSync`'s own deadline hands back: no status, a kill signal, and
 * an `ETIMEDOUT` spawn error rather than anything on stderr to explain itself. */
const TIMED_OUT = {
  pid: 1,
  output: [],
  stdout: "",
  stderr: "",
  status: null,
  signal: "SIGTERM" as const,
  error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
};

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("git", () => {
  it("bounds every spawn with a deadline", () => {
    spawnSyncMock.mockReturnValue({
      pid: 1,
      output: [],
      stdout: "git version 2.0.0\n",
      stderr: "",
      status: 0,
      signal: null,
    });

    expect(git("/repo", ["--version"])).toEqual({ ok: true, stdout: "git version 2.0.0\n" });
    // Without this option the child owns the CLI's lifetime: `rvw` would sit there with nothing
    // on either stream for as long as git does.
    expect(spawnSyncMock.mock.calls[0]?.[2]?.timeout).toBe(30_000);
  });

  it("names a git that ran past the deadline rather than reporting an opaque failure", () => {
    spawnSyncMock.mockReturnValue(TIMED_OUT);

    const captured = git("/repo", ["status", "--porcelain"]);
    expect(captured.ok).toBe(false);
    if (!captured.ok) {
      // The command it could not finish, and why — the same shape as the overflow arm, because
      // a timeout is likewise not a non-zero exit and has no stderr of its own to quote.
      expect(captured.message).toContain("git status --porcelain");
      expect(captured.message).toContain("did not finish within 30s");
    }
  });
});
