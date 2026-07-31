import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncer, createKeyedDebouncer } from "./debounce";

// One behavioural suite for the shared primitive, replacing the three near-identical
// fake-timer suites `scroll.ts`, `stores/review.ts` and `main/sessions.ts` used to carry —
// see 031-consolidate-debounce.md. Each site keeps only a thin test of its own wiring (the
// site-specific delay, and that it calls through).

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createDebouncer", () => {
  it("does not fire before the delay elapses", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.notify(1);
    vi.advanceTimersByTime(99);

    expect(onFire).not.toHaveBeenCalled();
  });

  it("arms on the first notify; later notifies in the same window only replace the value — the timer is not reset", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.notify(1);
    vi.advanceTimersByTime(60);
    // If this reset the timer (a plain debounce), the window below would not be enough to
    // fire — it is only 90ms after this second notify.
    debouncer.notify(2);
    debouncer.notify(3);
    vi.advanceTimersByTime(90);

    expect(onFire).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("starts a fresh window after firing rather than firing once ever", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.notify(1);
    vi.advanceTimersByTime(100);
    debouncer.notify(2);
    vi.advanceTimersByTime(100);

    expect(onFire.mock.calls).toEqual([[1], [2]]);
  });

  it("flush fires the pending value immediately and cancels the timer", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.notify(42);
    debouncer.flush();
    expect(onFire).toHaveBeenCalledExactlyOnceWith(42);

    // The timer was cleared by flush; it must not fire a second time on its own.
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending is a no-op", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.flush();

    expect(onFire).not.toHaveBeenCalled();
  });

  it("cancel drops the pending value instead of firing it", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.notify(42);
    debouncer.cancel();

    vi.advanceTimersByTime(100);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("cancel leaves the debouncer usable, and never fires what it dropped", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.notify(1);
    debouncer.cancel();
    // A cancelled debouncer is idle, not dead: the next window arms as if the first
    // never happened, and the dropped value is gone rather than waiting to ride along.
    debouncer.notify(2);
    vi.advanceTimersByTime(100);

    expect(onFire).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("cancel with nothing pending is a no-op", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.cancel();
    vi.advanceTimersByTime(100);

    expect(onFire).not.toHaveBeenCalled();
  });

  it("a falsy pending value (0) is not mistaken for 'nothing pending'", () => {
    const onFire = vi.fn();
    const debouncer = createDebouncer<number>({ delayMs: 100, onFire });

    debouncer.notify(0);
    debouncer.flush();

    expect(onFire).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("a Debouncer<void> can be notified with no argument, for a site with nothing to carry", () => {
    const onFire = vi.fn<() => void>();
    const debouncer = createDebouncer<void>({ delayMs: 100, onFire });

    debouncer.notify();
    vi.advanceTimersByTime(100);

    expect(onFire).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("unref lets the timer avoid holding the process open (main's requirement)", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const debouncer = createDebouncer({ delayMs: 100, onFire: () => {}, unref: true });

    debouncer.notify();

    // The fake-timer implementation exposes the same `hasRef()` Node's real Timeout does.
    const timer = spy.mock.results[0]?.value as { hasRef: () => boolean };
    expect(timer.hasRef()).toBe(false);
  });

  it("omitting unref leaves the timer ref'd — the renderer's default, and correct for main's own singleton", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const debouncer = createDebouncer({ delayMs: 100, onFire: () => {} });

    debouncer.notify();

    const timer = spy.mock.results[0]?.value as { hasRef: () => boolean };
    expect(timer.hasRef()).toBe(true);
  });
});

describe("createKeyedDebouncer", () => {
  it("coalesces multiple notifies to the same key into one fire with the latest value", () => {
    const onFire = vi.fn();
    const debouncer = createKeyedDebouncer<string, number>({ delayMs: 100, onFire });

    debouncer.notify("a", 1);
    debouncer.notify("a", 2);
    vi.advanceTimersByTime(100);

    expect(onFire).toHaveBeenCalledExactlyOnceWith("a", 2);
  });

  it("keys never coalesce into each other — each carries its own timer", () => {
    const onFire = vi.fn();
    const debouncer = createKeyedDebouncer<string, number>({ delayMs: 100, onFire });

    debouncer.notify("a", 1);
    vi.advanceTimersByTime(50);
    debouncer.notify("b", 2);
    vi.advanceTimersByTime(50);

    // "a" was armed 100ms ago and fires; "b" was armed 50ms ago and has not.
    expect(onFire).toHaveBeenCalledExactlyOnceWith("a", 1);

    vi.advanceTimersByTime(50);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(onFire).toHaveBeenCalledWith("b", 2);
  });

  it("flush(key) fires only that key; an untouched key's window is unaffected", () => {
    const onFire = vi.fn();
    const debouncer = createKeyedDebouncer<string, number>({ delayMs: 100, onFire });

    debouncer.notify("a", 1);
    debouncer.notify("b", 2);
    debouncer.flush("a");

    expect(onFire).toHaveBeenCalledExactlyOnceWith("a", 1);

    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(onFire).toHaveBeenCalledWith("b", 2);
  });

  it("flush(key) for a key with nothing pending is a no-op", () => {
    const onFire = vi.fn();
    const debouncer = createKeyedDebouncer<string, number>({ delayMs: 100, onFire });

    debouncer.flush("never-notified");

    expect(onFire).not.toHaveBeenCalled();
  });

  it("flushAll fires every pending key without skipping any", () => {
    const onFire = vi.fn<(key: string, value: number) => void>();
    const debouncer = createKeyedDebouncer<string, number>({ delayMs: 100, onFire });

    debouncer.notify("a", 1);
    debouncer.notify("b", 2);
    debouncer.notify("c", 3);
    debouncer.flushAll();

    const byKey = (a: [string, number], b: [string, number]): number => a[0].localeCompare(b[0]);
    expect(onFire.mock.calls.toSorted(byKey)).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(3);
  });

  it("cancelAll drops every pending key without firing any of them", () => {
    const onFire = vi.fn<(key: string, value: number) => void>();
    const debouncer = createKeyedDebouncer<string, number>({ delayMs: 100, onFire });

    debouncer.notify("a", 1);
    debouncer.notify("b", 2);
    debouncer.cancelAll();

    vi.advanceTimersByTime(100);
    expect(onFire).not.toHaveBeenCalled();

    // And the map it emptied still takes new keys: cancelling is going idle, not shutting down.
    debouncer.notify("a", 3);
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledExactlyOnceWith("a", 3);
  });

  it("a key that already fired re-arms on its next notify rather than being stuck", () => {
    const onFire = vi.fn();
    const debouncer = createKeyedDebouncer<string, number>({ delayMs: 100, onFire });

    debouncer.notify("a", 1);
    vi.advanceTimersByTime(100);
    debouncer.notify("a", 2);
    vi.advanceTimersByTime(100);

    expect(onFire.mock.calls).toEqual([
      ["a", 1],
      ["a", 2],
    ]);
  });
});
