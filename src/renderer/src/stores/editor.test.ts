import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBridge } from "./__fixtures__/bridge";
import { createEditorStore } from "./editor";

const REQUEST = { sessionId: "11111111-1111-4111-8111-111111111111", path: "src/a.ts", line: 3 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor store", () => {
  it("passes the request through and keeps a refusal until the next success", async () => {
    const bridge = stubBridge({
      openInEditor: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, failure: { code: "missing" } })
        .mockResolvedValueOnce({ ok: true }),
    });
    const store = createEditorStore();
    await store.getState().open(REQUEST);
    expect(bridge.openInEditor).toHaveBeenCalledWith(REQUEST);
    expect(store.getState().failure).toEqual({ code: "missing" });
    await store.getState().open(REQUEST);
    expect(store.getState().failure).toBeNull();
  });

  it("dismisses on request", async () => {
    stubBridge({
      openInEditor: vi.fn().mockResolvedValue({ ok: false, failure: { code: "noEditor" } }),
    });
    const store = createEditorStore();
    await store.getState().open(REQUEST);
    store.getState().clearFailure();
    expect(store.getState().failure).toBeNull();
  });

  it("is a no-op with no bridge", async () => {
    vi.stubGlobal("window", {});
    const store = createEditorStore();
    await store.getState().open(REQUEST);
    expect(store.getState().failure).toBeNull();
  });
});
