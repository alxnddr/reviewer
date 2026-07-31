import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The registry's two guards, from the outside: who is allowed to invoke, and what shape the
// payload has to be. Only `ipcMain.handle` is mocked — the listener it is handed is the unit
// under test, and it is called here the way Electron would call it.

/** `request` is optional so a void-payload channel can be invoked the way it arrives on the
 * wire: with nothing. */
type Listener = (event: unknown, request?: unknown) => Promise<unknown>;

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Listener>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      electron.handlers.set(channel, listener);
    },
  },
  default: {},
}));

import type { IpcMainInvokeEvent, WebFrameMain } from "electron";
import { IpcChannel } from "../shared/ipc";
import { registerIpcHandler } from "./ipc-registry";

/** The built page's URL, derived the way the registry derives its prefix: this file and
 * `ipc-registry.ts` share a directory, so they share the `../renderer/` it resolves. */
const BUNDLE_URL = pathToFileURL(join(__dirname, "../renderer/index.html")).href;

function fakeEvent(frameUrl: string, options: { subFrame?: boolean } = {}): IpcMainInvokeEvent {
  const senderFrame = { url: frameUrl } as WebFrameMain;
  // A sub-frame is a *different* frame object than the contents' main one — the URL alone
  // cannot tell them apart, since an iframe of the page itself has the page's URL.
  const mainFrame = options.subFrame === true ? ({ url: frameUrl } as WebFrameMain) : senderFrame;
  return { senderFrame, sender: { mainFrame } } as unknown as IpcMainInvokeEvent;
}

function registerOnboardingGet(): { invoke: (event: IpcMainInvokeEvent) => Promise<unknown> } {
  const handle = vi.fn(() => true);
  registerIpcHandler(IpcChannel.onboardingGet, handle);
  const listener = electron.handlers.get(IpcChannel.onboardingGet);
  if (listener === undefined) {
    throw new Error("handler was not registered");
  }
  return { invoke: (event) => listener(event) };
}

beforeEach(() => {
  electron.handlers.clear();
  // No dev server unless a test says so, whatever the ambient environment is.
  vi.stubEnv("ELECTRON_RENDERER_URL", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerIpcHandler sender validation", () => {
  it("answers the built page's main frame", async () => {
    const { invoke } = registerOnboardingGet();
    await expect(invoke(fakeEvent(BUNDLE_URL))).resolves.toBe(true);
  });

  it("answers the dev server's page when one is running", async () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    const { invoke } = registerOnboardingGet();
    await expect(invoke(fakeEvent("http://localhost:5173/index.html"))).resolves.toBe(true);
  });

  it("still answers the built page while the dev server's URL is set", async () => {
    // The prefixes are a set, not a choice: disagreeing with window.ts about which one is in
    // play would reject every channel in the app.
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    const { invoke } = registerOnboardingGet();
    await expect(invoke(fakeEvent(BUNDLE_URL))).resolves.toBe(true);
  });

  it("rejects a sub-frame of the page", async () => {
    const { invoke } = registerOnboardingGet();
    await expect(invoke(fakeEvent(BUNDLE_URL, { subFrame: true }))).rejects.toThrow(
      "untrusted sender",
    );
  });

  it("rejects a frame loaded from somewhere else", async () => {
    const { invoke } = registerOnboardingGet();
    await expect(invoke(fakeEvent("https://evil.example/"))).rejects.toThrow("untrusted sender");
  });

  it("rejects an event with no frame at all", async () => {
    const { invoke } = registerOnboardingGet();
    const event = {
      senderFrame: null,
      sender: { mainFrame: null },
    } as unknown as IpcMainInvokeEvent;
    await expect(invoke(event)).rejects.toThrow("untrusted sender");
  });

  it("rejects before the request is parsed, so a bad payload never reaches a handler", async () => {
    const handle = vi.fn(() => {});
    registerIpcHandler(IpcChannel.onboardingComplete, handle);
    const listener = electron.handlers.get(IpcChannel.onboardingComplete);
    await expect(listener?.(fakeEvent("https://evil.example/"))).rejects.toThrow(
      "untrusted sender",
    );
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("registerIpcHandler payload validation", () => {
  // The schemas are no longer passed in — they are the channel's own row of IPC_SCHEMAS. These
  // cover the two directions that lookup has to get right for the boundary to mean anything.

  it("parses the request with the channel's own schema before the handler runs", async () => {
    const handle = vi.fn(() => {});
    registerIpcHandler(IpcChannel.themeSet, handle);
    const listener = electron.handlers.get(IpcChannel.themeSet);
    await expect(listener?.(fakeEvent(BUNDLE_URL), "not-a-theme")).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
    await expect(listener?.(fakeEvent(BUNDLE_URL), "nord")).resolves.toBeUndefined();
    expect(handle).toHaveBeenCalledWith("nord");
  });

  it("parses the response too, so a handler cannot answer off-contract", async () => {
    // `theme:get` answers a ThemeId; this one hands back a string that is not one, which the
    // renderer would otherwise receive as a valid selection it cannot resolve.
    registerIpcHandler(IpcChannel.themeGet, () => "nonesuch" as never);
    const listener = electron.handlers.get(IpcChannel.themeGet);
    await expect(listener?.(fakeEvent(BUNDLE_URL))).rejects.toThrow();
  });

  it("lets a valid response through, pinning the row to theme:get and not merely to some row", async () => {
    // Rejecting "nonesuch" alone proves less than it looks: every one of the 22 response
    // schemas refuses that string, so the test above would still pass if the lookup returned
    // the wrong row entirely. A real ThemeId getting through is what rules that out.
    registerIpcHandler(IpcChannel.themeGet, () => "nord");
    const listener = electron.handlers.get(IpcChannel.themeGet);
    await expect(listener?.(fakeEvent(BUNDLE_URL))).resolves.toBe("nord");
  });
});
