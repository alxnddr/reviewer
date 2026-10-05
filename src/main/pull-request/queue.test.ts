import { describe, expect, it } from "vitest";
import { createKeyedQueue } from "./queue";

// The keys are the whole point: a prepare holds its repository and its worktree, so two
// prepares in one repository never overlap (they would both write the base's remote-tracking
// ref, and one would fail on git's ref lock), while work in another repository does not wait.

/** A task that records when it ran, and finishes when told to. */
function gate(log: string[], name: string): { task: () => Promise<string>; open: () => void } {
  let open: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    task: async () => {
      log.push(`start ${name}`);
      await done;
      log.push(`end ${name}`);
      return name;
    },
    open: () => open(),
  };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

describe("createKeyedQueue", () => {
  it("runs two prepares in one repository one after the other, even for different worktrees", async () => {
    const exclusive = createKeyedQueue();
    const log: string[] = [];
    const first = gate(log, "a");
    const second = gate(log, "b");
    const a = exclusive(["repo:/r", "worktree:/wt/a"], first.task);
    const b = exclusive(["repo:/r", "worktree:/wt/b"], second.task);
    await tick();
    expect(log).toEqual(["start a"]);
    first.open();
    await a;
    await tick();
    expect(log).toEqual(["start a", "end a", "start b"]);
    second.open();
    expect(await b).toBe("b");
  });

  it("lets work that shares no key run side by side, and a remove wait only on its worktree", async () => {
    const exclusive = createKeyedQueue();
    const log: string[] = [];
    const prepare = gate(log, "prepare");
    const other = gate(log, "other-repo");
    const remove = gate(log, "remove-same-worktree");
    const p = exclusive(["repo:/r", "worktree:/wt/a"], prepare.task);
    const o = exclusive(["repo:/s", "worktree:/wt/c"], other.task);
    const r = exclusive(["worktree:/wt/a"], remove.task);
    await tick();
    expect(log).toEqual(["start prepare", "start other-repo"]);
    other.open();
    prepare.open();
    await Promise.all([p, o]);
    await tick();
    expect(log).toContain("start remove-same-worktree");
    remove.open();
    await r;
  });

  it("goes on after a task that failed", async () => {
    const exclusive = createKeyedQueue();
    await expect(exclusive(["k"], () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await exclusive(["k"], () => Promise.resolve(1))).toBe(1);
  });
});
