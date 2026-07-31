import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import * as z from "zod";
import { createDebouncer } from "../shared/debounce";
import { appStore } from "./store";

// Where the window was last time, kept as one more top-level key in the shared app store (see
// store.ts) rather than a file of its own: one atomic write path, one file to reason about, and
// `settings.ts` carries this key across its own whole-file writes untouched.
//
// Saving the numbers is the easy half. Putting them back is not: a saved position describes a
// desktop layout that may no longer exist — the external display is unplugged, the laptop is
// docked the other way round, a display was rescaled or its resolution changed — and a window
// restored onto coordinates no display covers is a window the user cannot reach, drag, or close,
// with no in-app way out of it. So nothing here is restored before it has been checked against
// the current display list, and anything that cannot be checked is not restored at all.

/** The first-launch window, and the floor the clamp will not shrink past. `window.ts` hands both
 * to `BrowserWindow`, as `width`/`height` and `minWidth`/`minHeight`, so the placement below
 * reasons about the same numbers Electron will go on to enforce. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;
export const MIN_WINDOW_SIZE = { width: 800, height: 500 } as const;

/** The one key this module owns in the shared app store. */
const STORE_KEY = "window";

/** The ceiling on how often a drag or a resize — both of which fire continuously — reaches the
 * disk, the same way the session store bounds its write-backs. `createDebouncer` arms on the first
 * event and fires with the latest value, so a drag costs one write per interval rather than one
 * per pixel; the last position of all is caught by the unconditional write on `close`. */
export const WRITE_DEBOUNCE_MS = 500;

// Every field is required. A half-written record is not something to reconstruct the rest of by
// guessing, and the fallback it degrades to is already the right answer. `x`/`y` are signed: a
// display placed left of or above the primary one has a negative origin, and that is an ordinary
// position, not corruption.
const WindowState = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maximized: z.boolean(),
});
export type WindowState = z.infer<typeof WindowState>;

/** The only part of electron's `Display` the placement needs. Both a display's `workArea` and a
 * window's bounds are in DIP, so a display whose scale factor changed between runs arrives here
 * as a work area of a different size — handled by the same clamp as a smaller monitor, with no
 * special case of its own. */
export type DisplayArea = { workArea: Rectangle };

export type WindowPlacement = {
  width: number;
  height: number;
  /** Absent means "wherever Electron would have put it", which is centred on the primary
   * display: the first launch, and any launch where the saved position could not be checked. */
  x?: number;
  y?: number;
  maximized: boolean;
};

function clamp(value: number, low: number, high: number): number {
  // Low bound last, so it wins when the range is inverted — which happens when the window is
  // wider than the display it is going onto (`MIN_WINDOW_SIZE` can hold it above the work area's
  // width). Overflowing off the right edge with the title bar reachable is recoverable; being
  // pushed left of the display, where the title bar is not, is not.
  return Math.max(low, Math.min(value, high));
}

/** Area of the overlap between two rectangles; 0 when they do not touch. */
function overlapArea(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Turns a saved state into bounds that are guaranteed to land on a display that exists now.
 *
 * `displays[0]` is the fallback home for a window with nowhere to go — `restoreWindowPlacement`
 * passes the primary display first. Pure, and takes the display list as an argument, because
 * every case worth getting right here (a monitor that vanished, a saved window larger than the
 * screen, a negative origin) is a display layout that cannot be produced on the machine running
 * the tests. */
export function placeWindow(
  state: WindowState | null,
  displays: readonly DisplayArea[],
): WindowPlacement {
  // Maximizing is safe whatever the display layout does — it is the OS that decides where the
  // window lands — so that half of the state survives even when the geometry cannot.
  const maximized = state?.maximized ?? false;
  const fallback = displays[0];
  if (state === null || fallback === undefined) {
    return { ...DEFAULT_WINDOW_SIZE, maximized };
  }

  // The display the window was most recently on is the one it overlaps most; a window spanning
  // two displays goes back to whichever held more of it. No overlap at all means the display it
  // was on is gone (or the layout moved out from under it), and the search falls through to the
  // primary — see the position below.
  let home = fallback;
  let homeOverlap = 0;
  for (const display of displays) {
    const overlap = overlapArea(state, display.workArea);
    if (overlap > homeOverlap) {
      home = display;
      homeOverlap = overlap;
    }
  }

  // Size before position: how much room the window needs decides how far its origin can travel.
  const area = home.workArea;
  const width = Math.round(Math.max(MIN_WINDOW_SIZE.width, Math.min(state.width, area.width)));
  const height = Math.round(Math.max(MIN_WINDOW_SIZE.height, Math.min(state.height, area.height)));

  // Where the window would like to be. No overlap at all means its coordinates describe a desktop
  // that no longer exists: there is nothing there worth preserving, and clamping them would jam
  // the window into whichever corner it happened to be nearest, so it is centred on the primary
  // display instead — obviously deliberate, and where a first launch would have put it. Any
  // overlap at all leaves the saved position meaningful (dragged half past an edge, or the display
  // shrank under it), so that is the wish and the clamp only nudges it the shortest way back in.
  const wanted =
    homeOverlap === 0
      ? { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2 }
      : { x: state.x, y: state.y };
  // Both wishes go through the same clamp, centring included: on a display whose work area is
  // smaller than `MIN_WINDOW_SIZE`, centring a window that cannot be shrunk to fit would put the
  // origin — and with it the title bar — off the top-left of the screen, which is the one
  // placement there is no way to drag back from.
  return {
    width,
    height,
    x: Math.round(clamp(wanted.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(wanted.y, area.y, area.y + area.height - height)),
    maximized,
  };
}

/** The saved state, or null for a first launch — and for anything unreadable, which is the same
 * thing as far as the window is concerned. */
export function readWindowState(): WindowState | null {
  try {
    const result = WindowState.safeParse(appStore().get(STORE_KEY));
    return result.success ? result.data : null;
  } catch (error) {
    console.error("Window state unreadable, opening at the default size:", error);
    return null;
  }
}

/** Best-effort by design, unlike `writeSettings`: this runs from window events and from the
 * `close` handler on the way out of the app, where a throw would take a shutdown step with it.
 * Losing the last few pixels of a drag is not worth that. */
export function writeWindowState(state: WindowState): void {
  try {
    // `set` rather than a whole-file assignment: conf reads, merges, and writes atomically, so
    // the preferences `settings.ts` owns ride through untouched.
    appStore().set(STORE_KEY, state);
  } catch (error) {
    console.error("Window state could not be persisted:", error);
  }
}

/** The displays as electron sees them, primary first (see `placeWindow`).
 *
 * `screen` throws if it is touched before the `ready` event. Today every `createMainWindow` call
 * is inside `app.whenReady()`, so this is a guard against a future caller rather than a live
 * case — but the failure it prevents is an unclamped restore, which is exactly the failure this
 * module exists to make impossible. No display list, no restored geometry. */
function availableDisplays(): readonly DisplayArea[] {
  if (!app.isReady()) {
    return [];
  }
  try {
    const primary = screen.getPrimaryDisplay();
    return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  } catch (error) {
    console.error("Displays unavailable, opening at the default size:", error);
    return [];
  }
}

/** The `BrowserWindow` geometry for this launch. One synchronous read of a file the theme has
 * already brought into the page cache, before the window is constructed and long before there is
 * a page to paint — the startup order in `window.ts` is unchanged by it. */
export function restoreWindowPlacement(): WindowPlacement {
  return placeWindow(readWindowState(), availableDisplays());
}

function currentState(window: BrowserWindow): WindowState {
  // `getNormalBounds`, not `getBounds`: it answers with the restored-down geometry while the
  // window is maximized, minimized, or fullscreen, which is precisely the geometry to save —
  // saving the maximized bounds instead would make un-maximizing after a restart fill the screen
  // just the same.
  const bounds = window.getNormalBounds();
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    // Fullscreen is deliberately *not* persisted, and is recorded as not-maximized (Windows
    // reports both at once). Relaunching straight into fullscreen hides the OS chrome from a
    // reader who may have quit from it by accident, and it is the one window state with no
    // obvious way back for someone who does not know the shortcut. Size and position still
    // round-trip, because `getNormalBounds` is answering about the pre-fullscreen window.
    //
    // macOS answers `isMaximized()` for any window whose frame fills the visible area, zoomed or
    // not — so a window the clamp above sized to the work area comes back as maximized on the
    // next launch. That is the same window either way, and it is macOS's own definition of the
    // state, so it is left alone rather than second-guessed with a bounds comparison.
    maximized: window.isMaximized() && !window.isFullScreen(),
  };
}

/** Records `window`'s geometry for the next launch. One window's state is stored, and the app
 * only ever has one; a second window would simply overwrite it on close. */
export function trackWindowState(window: BrowserWindow): void {
  const persist = (): void => {
    // A destroyed window has no bounds to ask for — `getNormalBounds` throws. The `close` handler
    // below disarms the timer, but `destroy()` tears a window down without emitting `close` at
    // all, so a pending write really can outlive its window: this guard is load-bearing.
    if (!window.isDestroyed()) {
      writeWindowState(currentState(window));
    }
  };
  // unref, like the session store's writer: a pending geometry write must never be the reason
  // the process is still alive at quit.
  const writeDebouncer = createDebouncer({
    delayMs: WRITE_DEBOUNCE_MS,
    onFire: persist,
    unref: true,
  });
  const schedulePersist = (): void => {
    writeDebouncer.notify();
  };

  // Listed one by one rather than looped: `BrowserWindow.on` is a union of per-event overloads,
  // so a loop over the names resolves against whichever overload comes last.
  window.on("resize", schedulePersist);
  window.on("move", schedulePersist);
  window.on("maximize", schedulePersist);
  window.on("unmaximize", schedulePersist);

  window.on("close", () => {
    // Unconditional rather than a `flush`, which would do nothing when nothing is pending: this
    // is also how a first launch that was never touched gets a record at all. `close` fires
    // before the window is destroyed, so the bounds are still there to read.
    writeDebouncer.cancel();
    persist();
  });
}
