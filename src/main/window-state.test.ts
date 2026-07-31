import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// `screen` and `app.isReady` are the two pieces of electron this module reads; electron-store,
// one import further down, only needs the default export to be destructurable and takes the `cwd`
// these tests hand it. The display list is a plain field so a test can describe a monitor layout —
// including ones this machine does not have — in a line.
const electron = vi.hoisted(() => ({
  ready: true,
  displays: [] as { id: number; workArea: Rectangle }[],
  primaryId: 1,
}));
vi.mock("electron", () => ({
  app: { isReady: () => electron.ready },
  screen: {
    getPrimaryDisplay: () =>
      electron.displays.find((display) => display.id === electron.primaryId) ??
      electron.displays[0],
    getAllDisplays: () => electron.displays,
  },
  default: {},
}));

import type { BrowserWindow, Rectangle } from "electron";
import { writeSettings } from "./settings";
import { configureAppStore } from "./store";
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  placeWindow,
  readWindowState,
  restoreWindowPlacement,
  trackWindowState,
  WRITE_DEBOUNCE_MS,
  writeWindowState,
  type DisplayArea,
  type WindowState,
} from "./window-state";

let tempDirs: string[] = [];

function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-window-"));
  tempDirs.push(dir);
  configureAppStore({ directory: dir });
  return dir;
}

/** A relaunch: the process is gone, so the next read comes off disk. */
function restart(dir: string): void {
  configureAppStore({ directory: dir });
}

function readFile(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs) {
    // Restored first: the read-only-filesystem test leaves its directory unwritable.
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  configureAppStore();
  electron.ready = true;
  electron.displays = [];
  electron.primaryId = 1;
});

/** A 1920×1080 display at the origin, minus a 25px menu bar — the shape `workArea` has on a
 * laptop, and the reason positions are clamped to the work area rather than the full bounds. */
const LAPTOP: DisplayArea = { workArea: { x: 0, y: 25, width: 1920, height: 1055 } };
/** A second display to the right of it, as a docked machine reports one. */
const EXTERNAL: DisplayArea = { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } };

function saved(state: Partial<WindowState> = {}): WindowState {
  return { x: 100, y: 100, width: 1280, height: 800, maximized: false, ...state };
}

describe("placeWindow", () => {
  it("opens at the default size, unpositioned, on a first launch", () => {
    expect(placeWindow(null, [LAPTOP])).toEqual({ ...DEFAULT_WINDOW_SIZE, maximized: false });
  });

  it("returns a saved window that still fits where it was, unchanged", () => {
    const state = saved({ x: 300, y: 200, width: 1400, height: 800 });

    expect(placeWindow(state, [LAPTOP])).toEqual({
      x: 300,
      y: 200,
      width: 1400,
      height: 800,
      maximized: false,
    });
  });

  it("carries the maximized flag through every path", () => {
    expect(placeWindow(saved({ maximized: true }), [LAPTOP]).maximized).toBe(true);
    // Including the ones that throw the geometry away: the OS decides where a maximized window
    // goes, so restoring it is safe with no display list at all.
    expect(placeWindow(saved({ maximized: true }), [])).toEqual({
      ...DEFAULT_WINDOW_SIZE,
      maximized: true,
    });
  });

  it("falls back to the default size when the display list is empty", () => {
    // Unverifiable geometry is not restored — see `availableDisplays`.
    expect(placeWindow(saved({ x: 4000, y: 3000 }), [])).toEqual({
      ...DEFAULT_WINDOW_SIZE,
      maximized: false,
    });
  });

  it("clamps a window saved larger than the display it lands on", () => {
    const state = saved({ x: 0, y: 25, width: 3000, height: 2000 });

    // The whole window is on-screen afterwards, work area included: no title bar under the menu
    // bar, nothing hanging off the right edge.
    expect(placeWindow(state, [LAPTOP])).toEqual({
      x: 0,
      y: 25,
      width: 1920,
      height: 1055,
      maximized: false,
    });
  });

  it("moves a window saved on a display that is gone onto the primary one", () => {
    // Saved while docked, relaunched on the laptop alone: these coordinates are now nowhere.
    const state = saved({ x: 2400, y: 300, width: 1600, height: 1000 });

    const placement = placeWindow(state, [LAPTOP]);

    // Centred rather than clamped — a position no display covers has nothing worth preserving.
    expect(placement).toEqual({ x: 160, y: 53, width: 1600, height: 1000, maximized: false });
    expectFullyOnDisplay(placement, LAPTOP);
  });

  it("keeps a window that is still on its external display exactly where it was", () => {
    const state = saved({ x: 2400, y: 300, width: 1600, height: 1000 });

    expect(placeWindow(state, [LAPTOP, EXTERNAL])).toEqual({
      x: 2400,
      y: 300,
      width: 1600,
      height: 1000,
      maximized: false,
    });
  });

  it("sends a window spanning two displays back to the one that held more of it", () => {
    // 300px on the laptop, 900px on the external — and the external's work area starts at y=0,
    // so a y that only the laptop's menu bar gap explains proves which one was chosen.
    const state = saved({ x: 1620, y: 25, width: 1200, height: 800 });

    expect(placeWindow(state, [LAPTOP, EXTERNAL])).toEqual({
      x: 1920,
      y: 25,
      width: 1200,
      height: 800,
      maximized: false,
    });
  });

  it("keeps a position on a display left of or above the primary", () => {
    // Negative origins are an ordinary layout, not corruption.
    const left: DisplayArea = { workArea: { x: -1920, y: -200, width: 1920, height: 1080 } };
    const state = saved({ x: -1800, y: -100, width: 1000, height: 700 });

    expect(placeWindow(state, [LAPTOP, left])).toEqual({
      x: -1800,
      y: -100,
      width: 1000,
      height: 700,
      maximized: false,
    });
  });

  it("nudges a partly off-screen window back inside the work area", () => {
    // Dragged mostly past the right edge, and its title bar under the menu bar.
    const state = saved({ x: 1800, y: 0, width: 1200, height: 800 });

    const placement = placeWindow(state, [LAPTOP]);

    expect(placement).toEqual({ x: 720, y: 25, width: 1200, height: 800, maximized: false });
    expectFullyOnDisplay(placement, LAPTOP);
  });

  it("shrinks with a display whose scale factor changed under it", () => {
    // Bounds and work areas are both DIP, so doubling the scale of a 2560×1440 panel halves the
    // work area this window has to fit into — and it does, without a case of its own.
    const state = saved({ x: 1920, y: 0, width: 2400, height: 1300 });
    const rescaled: DisplayArea = { workArea: { x: 1920, y: 0, width: 1280, height: 720 } };

    const placement = placeWindow(state, [LAPTOP, rescaled]);

    expect(placement).toEqual({ x: 1920, y: 0, width: 1280, height: 720, maximized: false });
    expectFullyOnDisplay(placement, rescaled);
  });

  it("keeps the origin on-screen when the window cannot be made to fit", () => {
    // A display smaller than the minimum window size: `minWidth`/`minHeight` win, so something
    // has to hang off an edge. What must not happen is the *origin* going off — a title bar left
    // of the display is a window with no way to drag it back.
    const tiny: DisplayArea = { workArea: { x: 0, y: 0, width: 640, height: 400 } };
    const state = saved({ x: 500, y: 300, width: 1280, height: 800 });

    expect(placeWindow(state, [tiny])).toEqual({
      x: 0,
      y: 0,
      ...MIN_WINDOW_SIZE,
      maximized: false,
    });
  });

  it("keeps the origin on-screen when a window that cannot fit is centred instead", () => {
    // Same display too small for `MIN_WINDOW_SIZE`, but reached down the other branch: nothing
    // overlaps, so the position is thrown away and the window centred. Centring a window wider
    // than the work area puts its origin left of and above the display unless the clamp catches
    // it too — and an off-display origin is exactly what the clamp exists to prevent.
    const tiny: DisplayArea = { workArea: { x: -900, y: -500, width: 640, height: 400 } };

    expect(placeWindow(saved({ x: 8000, y: 8000 }), [tiny])).toEqual({
      x: -900,
      y: -500,
      ...MIN_WINDOW_SIZE,
      maximized: false,
    });
  });

  it("rounds to whole pixels", () => {
    // An odd-sized work area centring an even-sized window lands on a half pixel; Electron's
    // bounds are integers, and a fractional one is silently truncated somewhere downstream.
    const odd: DisplayArea = { workArea: { x: 0, y: 0, width: 1001, height: 701 } };
    const placement = placeWindow(saved({ x: 5000, y: 5000, width: 800, height: 500 }), [odd]);
    expect(placement).toMatchObject({ x: 101, y: 101 });

    for (const value of Object.values(placement)) {
      if (typeof value === "number") {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

/** The property every restore has to hold: all four edges inside the display's work area. */
function expectFullyOnDisplay(
  placement: { x?: number; y?: number; width: number; height: number },
  display: DisplayArea,
): void {
  const { x, y } = placement;
  expect(x).toBeDefined();
  expect(y).toBeDefined();
  const area = display.workArea;
  expect(x).toBeGreaterThanOrEqual(area.x);
  expect(y).toBeGreaterThanOrEqual(area.y);
  expect((x ?? 0) + placement.width).toBeLessThanOrEqual(area.x + area.width);
  expect((y ?? 0) + placement.height).toBeLessThanOrEqual(area.y + area.height);
}

describe("readWindowState / writeWindowState", () => {
  it("round-trips the geometry across a restart", () => {
    const dir = makeStoreDir();
    writeWindowState(saved({ x: 40, y: 60, width: 1440, height: 900, maximized: true }));

    restart(dir);
    expect(readWindowState()).toEqual({
      x: 40,
      y: 60,
      width: 1440,
      height: 900,
      maximized: true,
    });
  });

  it("reads as a first launch when the record is absent, partial, or nonsense", () => {
    const dir = makeStoreDir();
    expect(readWindowState()).toBeNull();

    for (const window of [{ width: 1280, height: 800 }, { x: "left" }, 42, null]) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ window }));
      restart(dir);
      expect(readWindowState()).toBeNull();
    }
  });

  it("ignores fields it does not know rather than reading the whole record as absent", () => {
    const dir = makeStoreDir();
    // What a record written by a later build looks like to this one. Dropping the extra keys is
    // free; rejecting the record over them would throw away a perfectly good position.
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ window: { ...saved(), display: "external", zoom: 2 } }),
    );

    restart(dir);
    expect(readWindowState()).toEqual(saved());
  });

  it("shares the settings file with the preferences without either overwriting the other", () => {
    const dir = makeStoreDir();
    writeSettings({ theme: "nord", onboarded: true });

    writeWindowState(saved({ maximized: true }));
    expect(readFile(dir)).toEqual({
      theme: "nord",
      onboarded: true,
      window: { x: 100, y: 100, width: 1280, height: 800, maximized: true },
    });

    // And the settings writer, which replaces the file wholesale, carries the geometry across.
    writeSettings({ theme: "dracula" });
    restart(dir);
    expect(readWindowState()).toEqual(saved({ maximized: true }));
  });

  it("swallows a write the filesystem refuses", () => {
    if (process.getuid?.() === 0) {
      // root writes to a read-only directory anyway, so there is nothing to observe.
      return;
    }
    const dir = makeStoreDir();
    chmodSync(dir, 0o500);

    // Unlike `writeSettings`, which throws for its caller to log: this one runs from `close`, on
    // the way out of the app, where a throw would take the rest of the shutdown with it.
    expect(() => {
      writeWindowState(saved());
    }).not.toThrow();
  });
});

describe("restoreWindowPlacement", () => {
  it("clamps the saved geometry against the displays electron reports", () => {
    makeStoreDir();
    electron.displays = [{ id: 1, workArea: LAPTOP.workArea }];
    writeWindowState(saved({ x: 2400, y: 300, width: 3000, height: 2000 }));

    const placement = restoreWindowPlacement();

    expect(placement).toEqual({ x: 0, y: 25, width: 1920, height: 1055, maximized: false });
  });

  it("falls back to the primary display, not to whichever getAllDisplays lists first", () => {
    makeStoreDir();
    electron.displays = [
      { id: 1, workArea: LAPTOP.workArea },
      { id: 2, workArea: EXTERNAL.workArea },
    ];
    electron.primaryId = 2;
    // Nowhere near either display, so the placement falls through to the list's head — which is
    // why `availableDisplays` puts the primary there.
    writeWindowState(saved({ x: 9000, y: 9000, width: 1200, height: 800 }));

    expectFullyOnDisplay(restoreWindowPlacement(), EXTERNAL);
  });

  it("restores nothing it cannot check, when asked before the display list exists", () => {
    makeStoreDir();
    electron.displays = [{ id: 1, workArea: LAPTOP.workArea }];
    writeWindowState(saved({ x: 300, y: 200, maximized: true }));

    // `screen` throws before the `ready` event, and an unclamped restore is the one outcome this
    // module exists to prevent — so a caller that got here too early gets the default window.
    electron.ready = false;
    expect(restoreWindowPlacement()).toEqual({ ...DEFAULT_WINDOW_SIZE, maximized: true });
  });
});

type FakeWindow = {
  window: BrowserWindow;
  state: { bounds: Rectangle; maximized: boolean; fullScreen: boolean; destroyed: boolean };
  emit: (event: string) => void;
};

/** The five methods `trackWindowState` calls, plus a way to fire the events it listens for. */
function fakeWindow(): FakeWindow {
  const listeners = new Map<string, (() => void)[]>();
  const state = {
    bounds: { x: 100, y: 100, width: 1280, height: 800 },
    maximized: false,
    fullScreen: false,
    destroyed: false,
  };
  const window = {
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    getNormalBounds() {
      if (state.destroyed) {
        throw new Error("Object has been destroyed");
      }
      return state.bounds;
    },
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    isDestroyed: () => state.destroyed,
  } as unknown as BrowserWindow;
  return {
    window,
    state,
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

describe("trackWindowState", () => {
  it("records where the window was when it closed", () => {
    makeStoreDir();
    const { window, state, emit } = fakeWindow();
    trackWindowState(window);

    state.bounds = { x: 240, y: 160, width: 1600, height: 1000 };
    emit("move");
    emit("close");

    // Unconditional on close, so a window nobody touched still leaves a record behind.
    expect(readWindowState()).toEqual({
      x: 240,
      y: 160,
      width: 1600,
      height: 1000,
      maximized: false,
    });
  });

  it("coalesces a drag into one write instead of one per pixel", async () => {
    vi.useFakeTimers();
    makeStoreDir();
    const { window, state, emit } = fakeWindow();
    trackWindowState(window);

    for (let step = 0; step < 50; step++) {
      state.bounds = { ...state.bounds, x: 100 + step };
      emit("move");
    }
    // Nothing on disk yet — the whole point of the debounce is that a drag is not 50 writes.
    expect(readWindowState()).toBeNull();

    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(readWindowState()?.x).toBe(149);
  });

  it("saves the restored-down bounds of a maximized window, not the filled screen", () => {
    makeStoreDir();
    const { window, state, emit } = fakeWindow();
    trackWindowState(window);

    // What `getNormalBounds` answers while maximized: the size the window goes back to.
    state.maximized = true;
    state.bounds = { x: 120, y: 90, width: 1280, height: 800 };
    emit("maximize");
    emit("close");

    expect(readWindowState()).toEqual({
      x: 120,
      y: 90,
      width: 1280,
      height: 800,
      maximized: true,
    });
  });

  it("does not bring a fullscreen window back as a maximized one", () => {
    makeStoreDir();
    const { window, state, emit } = fakeWindow();
    trackWindowState(window);

    // Windows reports fullscreen as maximized too; quitting from fullscreen must not mean
    // relaunching into a window with no visible chrome.
    state.fullScreen = true;
    state.maximized = true;
    emit("close");

    expect(readWindowState()?.maximized).toBe(false);
    // The pre-fullscreen geometry still round-trips, because that is what `getNormalBounds` is.
    expect(readWindowState()?.width).toBe(1280);
  });

  it("writes nothing more once the window has closed", async () => {
    vi.useFakeTimers();
    makeStoreDir();
    const { window, state, emit } = fakeWindow();
    trackWindowState(window);

    state.bounds = { x: 240, y: 160, width: 1600, height: 1000 };
    emit("move");
    emit("close");

    // The armed timer goes with the window. Left running, it would fire against a window on its
    // way out and overwrite the record `close` just took — the last thing written has to be the
    // state the app was actually quit in.
    state.bounds = { x: 900, y: 900, width: 800, height: 500 };
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 4);

    expect(readWindowState()).toEqual({
      x: 240,
      y: 160,
      width: 1600,
      height: 1000,
      maximized: false,
    });
  });

  it("does not read a window that has gone away under a pending write", async () => {
    vi.useFakeTimers();
    makeStoreDir();
    const { window, state, emit } = fakeWindow();
    trackWindowState(window);

    emit("resize");
    state.destroyed = true;

    // `getNormalBounds` throws on a destroyed window, so this both writes nothing and, more to
    // the point, does not take the timer callback down with it.
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(readWindowState()).toBeNull();
  });
});
