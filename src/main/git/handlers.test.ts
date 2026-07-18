import { describe, expect, it, vi } from "vitest";
import { IpcChannel } from "../../shared/ipc";
import type { GitRunner } from "./runner";

// Even if a tampered ref slipped past the store's load-time salvage, the
// git:diff channel re-parses every request against the shared git.ts schemas
// before the handler runs, so nothing ref-shaped and hostile can ever reach a
// spawn.

type IpcHandler = (event: unknown, request: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler): void => {
      handlers.set(channel, handler);
    },
  },
  // Present so handlers.ts imports resolve; the repo:open path is never invoked here.
  BrowserWindow: { getFocusedWindow: (): null => null },
  dialog: { showOpenDialog: vi.fn() },
}));

const { registerGitIpcHandlers } = await import("./handlers");

function spyRunner(): { runner: GitRunner; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn();
  return { run, runner: { run, terminateAll: vi.fn(), maxOutputBytes: 32 * 1024 * 1024 } };
}

function handlerFor(runner: GitRunner, channel: string): IpcHandler {
  handlers.clear();
  registerGitIpcHandlers(runner);
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} handler was not registered`);
  }
  return handler;
}

function diffHandler(runner: GitRunner): IpcHandler {
  return handlerFor(runner, IpcChannel.gitDiff);
}

function fileContentsHandler(runner: GitRunner): IpcHandler {
  return handlerFor(runner, IpcChannel.gitFileContents);
}

// Each is a well-formed IPC envelope whose ref is exactly what a tampered store
// could carry — a smuggled flag, a bare option, a rev expression, a relative cwd.
const spawnBait: ReadonlyArray<{ label: string; request: unknown }> = [
  {
    label: "a branch base smuggling an upload-pack flag",
    request: {
      repoPath: "/repo",
      selection: { kind: "branches", base: "--upload-pack=/tmp/evil", head: "main" },
    },
  },
  {
    label: "a branch head that is a bare dash option",
    request: {
      repoPath: "/repo",
      selection: { kind: "branches", base: "main", head: "-x" },
    },
  },
  {
    label: "a commit range anchored to a rev expression",
    request: {
      repoPath: "/repo",
      selection: { kind: "commitRange", first: "HEAD~1", last: "HEAD" },
    },
  },
  {
    label: "a non-absolute repo path",
    request: { repoPath: "relative/repo", selection: { kind: "uncommitted" } },
  },
];

describe("git:diff IPC boundary", () => {
  it.each(spawnBait)("rejects $label before any git spawn", async ({ request }) => {
    const { runner, run } = spyRunner();
    const handler = diffHandler(runner);

    await expect(handler({}, request)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("admits a valid selection through to the runner (the boundary is not vacuous)", async () => {
    const { runner, run } = spyRunner();
    run.mockResolvedValue({ ok: true, stdout: "" });
    const handler = diffHandler(runner);

    await handler({}, { repoPath: "/repo", selection: { kind: "uncommitted" } });
    expect(run).toHaveBeenCalled();
  });
});

// The full-file read shares the git:diff posture: the same validated boundary
// before the spawn, and the same result envelope on the way back — plus a path
// that must be a real repo-relative string, and an absence that stays typed.
const fileContentsBait: ReadonlyArray<{ label: string; request: unknown }> = [
  {
    label: "a ref that is a rev expression",
    request: { repoPath: "/repo", source: { kind: "ref", ref: "HEAD~1" }, path: "src/a.ts" },
  },
  {
    label: "a ref smuggling a dash option",
    request: {
      repoPath: "/repo",
      source: { kind: "ref", ref: "--output=/tmp/evil" },
      path: "src/a.ts",
    },
  },
  {
    label: "a parentOf commit that is not a full sha",
    request: { repoPath: "/repo", source: { kind: "parentOf", commit: "HEAD" }, path: "src/a.ts" },
  },
  {
    label: "an unknown source kind",
    request: { repoPath: "/repo", source: { kind: "branch", ref: "main" }, path: "src/a.ts" },
  },
  {
    label: "a missing source field",
    request: { repoPath: "/repo", path: "src/a.ts" },
  },
  {
    label: "an absolute path escaping the repo",
    request: { repoPath: "/repo", source: { kind: "ref", ref: "main" }, path: "/etc/passwd" },
  },
  {
    label: "a path with a parent-directory traversal segment",
    request: { repoPath: "/repo", source: { kind: "worktree" }, path: "../../../etc/passwd" },
  },
  {
    label: "a path carrying a NUL byte",
    request: {
      repoPath: "/repo",
      source: { kind: "ref", ref: "main" },
      path: "src/a.ts\u0000.png",
    },
  },
  {
    label: "a non-absolute repo path",
    request: { repoPath: "relative/repo", source: { kind: "ref", ref: "main" }, path: "src/a.ts" },
  },
];

describe("git:file-contents IPC boundary", () => {
  it.each(fileContentsBait)("rejects $label before any git spawn", async ({ request }) => {
    const { runner, run } = spyRunner();
    const handler = fileContentsHandler(runner);

    await expect(handler({}, request)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("round-trips a present file's text through the registry envelope", async () => {
    const { runner, run } = spyRunner();
    run.mockResolvedValue({ ok: true, stdout: "line one\nline two\n" });
    const handler = fileContentsHandler(runner);

    const response = await handler(
      {},
      { repoPath: "/repo", source: { kind: "ref", ref: "main" }, path: "src/a.ts" },
    );
    expect(response).toEqual({
      ok: true,
      value: { kind: "present", text: "line one\nline two\n" },
    });
  });

  // Both phrasings git uses for "no blob here" must reach the renderer as the typed
  // absent variant — never a thrown error, never empty content masquerading as a file.
  const absentStderr: ReadonlyArray<string> = [
    "fatal: path 'src/a.ts' does not exist in 'main'",
    "fatal: path 'src/a.ts' exists on disk, but not in 'main'",
  ];
  it.each(absentStderr)(
    "maps the absent-path failure (%s) to the typed absent variant",
    async (stderr) => {
      const { runner, run } = spyRunner();
      run.mockResolvedValue({ ok: false, failure: { code: "exited", exitCode: 128, stderr } });
      const handler = fileContentsHandler(runner);

      const response = await handler(
        {},
        { repoPath: "/repo", source: { kind: "ref", ref: "main" }, path: "src/a.ts" },
      );
      expect(response).toEqual({ ok: true, value: { kind: "absent" } });
    },
  );

  it("does not swallow a genuine failure as an absence", async () => {
    const { runner, run } = spyRunner();
    run.mockResolvedValue({
      ok: false,
      failure: { code: "exited", exitCode: 128, stderr: "fatal: not a git repository" },
    });
    const handler = fileContentsHandler(runner);

    const response = await handler(
      {},
      { repoPath: "/repo", source: { kind: "ref", ref: "main" }, path: "src/a.ts" },
    );
    expect(response).toEqual({ ok: false, failure: { code: "notARepo", path: "/repo" } });
  });
});
