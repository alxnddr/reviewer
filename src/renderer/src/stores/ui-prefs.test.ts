import { afterEach, describe, expect, it, vi } from "vitest";

type PrefsModule = typeof import("./ui-prefs");

/** A synchronous in-memory `localStorage`. The suite runs in the node environment, where the
 * global does not exist at all, so each case installs one over a Map it can then read back. */
function stubStorage(seed: Record<string, string>): Map<string, string> {
  const cells = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      cells.set(key, value);
    },
    removeItem: (key: string): void => {
      cells.delete(key);
    },
    clear: (): void => {
      cells.clear();
    },
    key: (index: number): string | null => [...cells.keys()][index] ?? null,
    get length(): number {
      return cells.size;
    },
  });
  return cells;
}

/** The store is built — and persist reads storage — at module load, so a launch is a fresh
 * module against freshly seeded storage, not a `setState` reset. */
async function launch(
  seed: Record<string, string> = {},
): Promise<{ prefs: PrefsModule; cells: Map<string, string> }> {
  const cells = stubStorage(seed);
  vi.resetModules();
  return { prefs: await import("./ui-prefs"), cells };
}

function storedField(cells: Map<string, string>, key: string, field: string): unknown {
  const raw = cells.get(key);
  if (raw === undefined) {
    return undefined;
  }
  return (JSON.parse(raw) as { state?: Record<string, unknown> }).state?.[field];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the diff-layout preference", () => {
  it("starts split on an install that has never chosen", async () => {
    const { prefs, cells } = await launch();

    expect(prefs.useUiPrefsStore.getState().diffStyle).toBe("split");
    // Nothing chosen, nothing written: the default is not a stored preference.
    expect(cells.has(prefs.UI_PREFS_STORAGE_KEY)).toBe(false);
  });

  it("writes a choice through to one namespaced key", async () => {
    const { prefs, cells } = await launch();

    prefs.useUiPrefsStore.getState().setDiffStyle("unified");

    expect(prefs.useUiPrefsStore.getState().diffStyle).toBe("unified");
    expect(storedField(cells, prefs.UI_PREFS_STORAGE_KEY, "diffStyle")).toBe("unified");
    expect([...cells.keys()]).toEqual([prefs.UI_PREFS_STORAGE_KEY]);
  });

  it("comes back unified after a relaunch — the whole point of moving it out of the session", async () => {
    const first = await launch();
    first.prefs.useUiPrefsStore.getState().setDiffStyle("unified");

    // Same storage contents, new module: this is a quit and a fresh launch.
    const second = await launch(Object.fromEntries(first.cells));

    expect(second.prefs.useUiPrefsStore.getState().diffStyle).toBe("unified");
  });

  it("stores the preference and nothing else — never the setter", async () => {
    const { prefs, cells } = await launch();

    prefs.useUiPrefsStore.getState().setDiffStyle("unified");

    const raw = cells.get(prefs.UI_PREFS_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(Object.keys((JSON.parse(raw ?? "{}") as { state: object }).state)).toEqual([
      "diffStyle",
      "railCollapsed",
    ]);
  });

  it.each([
    ["a value no branch handles", '{"state":{"diffStyle":"side-by-side"},"version":0}'],
    ["a key written without the field", '{"state":{},"version":0}'],
    ["something that is not an object", '"unified"'],
    ["truncated JSON", '{"state":{"diffStyle":"unif'],
  ])("falls back to split on %s, and leaves it there to be overwritten", async (_label, raw) => {
    const { prefs, cells } = await launch({ "reviewer:ui": raw });

    expect(prefs.useUiPrefsStore.getState().diffStyle).toBe("split");
    // Not rewritten on the way past — only a click writes.
    expect(cells.get("reviewer:ui")).toBe(raw);
  });

  it("loads with no storage at all — the preview harness has no localStorage", async () => {
    // `createJSONStorage` swallows the throwing getter, so persist degrades to a plain store:
    // the module still constructs and the toggle still works, it just does not survive.
    vi.unstubAllGlobals();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const prefs = await import("./ui-prefs");

    expect(prefs.useUiPrefsStore.getState().diffStyle).toBe("split");
    prefs.useUiPrefsStore.getState().setDiffStyle("unified");
    expect(prefs.useUiPrefsStore.getState().diffStyle).toBe("unified");

    warn.mockRestore();
  });
});

describe("the rail-collapsed preference", () => {
  it("starts with the rail showing, and writes nothing until it is flipped", async () => {
    const { prefs, cells } = await launch();

    expect(prefs.useUiPrefsStore.getState().railCollapsed).toBe(false);
    expect(cells.has(prefs.UI_PREFS_STORAGE_KEY)).toBe(false);
  });

  it("comes back put away after a relaunch — a rail is not a per-session thing", async () => {
    const first = await launch();
    first.prefs.useUiPrefsStore.getState().toggleRail();
    expect(first.prefs.useUiPrefsStore.getState().railCollapsed).toBe(true);

    const second = await launch(Object.fromEntries(first.cells));

    expect(second.prefs.useUiPrefsStore.getState().railCollapsed).toBe(true);
  });

  it("shares the one key with the layout choice", async () => {
    const { prefs, cells } = await launch();

    prefs.useUiPrefsStore.getState().setRailCollapsed(true);

    expect(storedField(cells, prefs.UI_PREFS_STORAGE_KEY, "railCollapsed")).toBe(true);
    expect([...cells.keys()]).toEqual([prefs.UI_PREFS_STORAGE_KEY]);
  });

  it.each([
    ["a string that looks like one", '{"state":{"railCollapsed":"true"},"version":0}'],
    ["a number", '{"state":{"railCollapsed":1},"version":0}'],
    ["a key written without the field", '{"state":{"diffStyle":"unified"},"version":0}'],
  ])("falls back to showing the rail on %s", async (_label, raw) => {
    const { prefs, cells } = await launch({ "reviewer:ui": raw });

    expect(prefs.useUiPrefsStore.getState().railCollapsed).toBe(false);
    expect(cells.get("reviewer:ui")).toBe(raw);
  });

  // The salvage is per key, not per file: the reader edited one field into nonsense and keeps
  // the other choice they made. `shared/settings.ts` states the same rule for settings on disk.
  it("keeps a readable layout choice beside an unreadable rail flag", async () => {
    const { prefs } = await launch({
      "reviewer:ui": '{"state":{"diffStyle":"unified","railCollapsed":"yes"},"version":0}',
    });

    expect(prefs.useUiPrefsStore.getState().diffStyle).toBe("unified");
    expect(prefs.useUiPrefsStore.getState().railCollapsed).toBe(false);
  });
});
