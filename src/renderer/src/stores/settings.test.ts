import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSettings, Settings } from "../../../shared/settings";
import { SETTINGS_DEFAULTS } from "../../../shared/settings";
import { stubBridge } from "./__fixtures__/bridge";
import { createSettingsStore } from "./settings";

// The store around a recording `apply`, so what would have reached the document is a list of
// records to assert on rather than a DOM to inspect.

function makeStore(systemDark = false) {
  const apply = vi.fn<(next: ResolvedSettings, previous: ResolvedSettings | null) => void>();
  const store = createSettingsStore({ apply, systemPrefersDark: () => systemDark });
  return { store, apply };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("init", () => {
  it("applies the OS seed before main answers, then the stored record", async () => {
    const stored: Settings = { theme: "nord", diffFontSize: 15 };
    stubBridge({ getSettings: vi.fn().mockResolvedValue(stored) });
    const { store, apply } = makeStore(true);

    const pending = store.getState().init();
    // Synchronously, before the bridge answers: the window is painting already.
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0].theme).toBe("pierre-dark");
    expect(store.getState().settings).toBeNull();

    await pending;
    expect(store.getState().settings).toEqual(stored);
    expect(store.getState().resolved).toEqual({ ...SETTINGS_DEFAULTS, ...stored });
    expect(apply).toHaveBeenLastCalledWith(store.getState().resolved, expect.anything());
  });

  it("settles on the OS default outside Electron", async () => {
    vi.stubGlobal("window", {});
    const { store, apply } = makeStore(true);

    await store.getState().init();

    expect(store.getState().settings).toBeNull();
    expect(store.getState().resolved.theme).toBe("pierre-dark");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("lets a choice made while main was still answering win", async () => {
    let answer: (settings: Settings) => void = () => {};
    stubBridge({
      getSettings: vi.fn().mockReturnValue(
        new Promise<Settings>((resolve) => {
          answer = resolve;
        }),
      ),
    });
    const { store } = makeStore();

    const pending = store.getState().init();
    await store.getState().update({ theme: "dracula" });
    answer({ theme: "nord" });
    await pending;

    expect(store.getState().settings).toEqual({ theme: "dracula" });
    expect(store.getState().resolved.theme).toBe("dracula");
  });
});

describe("update", () => {
  it("applies, then sends the whole record back to main", async () => {
    const bridge = stubBridge();
    const { store, apply } = makeStore();
    store.setState({ settings: { theme: "nord" } });

    await store.getState().update({ diffFontSize: 16 });

    expect(store.getState().settings).toEqual({ theme: "nord", diffFontSize: 16 });
    expect(store.getState().resolved.diffFontSize).toBe(16);
    expect(apply).toHaveBeenCalledWith(store.getState().resolved, expect.anything());
    expect(bridge.setSettings).toHaveBeenCalledWith({ theme: "nord", diffFontSize: 16 });
  });

  it("removes a reset key from the record it sends, so disk forgets it too", async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined);
    stubBridge({ setSettings });
    const { store } = makeStore();
    store.setState({ settings: { theme: "nord", diffFontSize: 16 } });

    await store.getState().update({ diffFontSize: undefined });

    expect(store.getState().settings).toEqual({ theme: "nord" });
    expect(store.getState().resolved.diffFontSize).toBe(SETTINGS_DEFAULTS.diffFontSize);
    const sent: unknown = setSettings.mock.calls[0]?.[0];
    expect(sent).toEqual({ theme: "nord" });
    expect(typeof sent === "object" && sent !== null && "diffFontSize" in sent).toBe(false);
  });

  it("hands the previous record to apply, so a theme apply can be skipped when nothing changed", async () => {
    stubBridge();
    const { store, apply } = makeStore();
    const before = store.getState().resolved;

    await store.getState().update({ diffWrap: true });

    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ diffWrap: true }), before);
  });

  it("keeps the change on screen when main refuses the write", async () => {
    stubBridge({ setSettings: vi.fn().mockRejectedValue(new Error("EROFS")) });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = makeStore();

    await store.getState().update({ theme: "dracula" });

    expect(store.getState().resolved.theme).toBe("dracula");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("the dialog", () => {
  it("toggles, so the chord that opened it is the one that closes it", () => {
    const { store } = makeStore();
    store.getState().toggleDialog();
    expect(store.getState().dialogOpen).toBe(true);
    store.getState().toggleDialog();
    expect(store.getState().dialogOpen).toBe(false);
  });
});
