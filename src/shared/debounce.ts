// The one "leading-schedule, trailing-fire" primitive the app needs, shared by the renderer
// (scroll capture, session write-backs) and main (the session store's disk writer) — it used to
// be hand-rolled three times, once per site, each carrying its own copy of the same six lines.
//
// It is deliberately *not* a plain debounce, and not `lodash`/`es-toolkit`'s `debounce` or
// `throttle` either: the first `notify` arms a timer, and every `notify` after that only
// replaces what will fire — it never resets the timer. A plain debounce (or throttle with a
// leading+trailing edge) restarts the clock on every call, which under a steady trickle of
// input never fires at all. This fires once per window no matter how busy the window is, which
// is the point of a write-back debounce: bound the rate of disk/IPC writes, not delay them
// indefinitely.
//
// `unref` is main-only: `sessions.ts` cannot let its write-back timer hold the Electron process
// open past `will-quit`, since durability there comes from an explicit `flush()`, not from the
// timer firing. The renderer's timer handle has no `.unref()` (the DOM timer is a bare number),
// so the option is a no-op there — call sites simply never set it.

/** One armed-or-idle timer, carrying at most one pending value. */
export type Debouncer<T = void> = {
  /** Records `value` as what the next fire will use. Arms the timer if it is not already
   * armed; an already-armed timer is left running — this call only replaces the value it
   * will fire with. */
  notify(value: T): void;
  /** Fires the pending call now, if there is one, and cancels the timer. A no-op with
   * nothing pending. */
  flush(): void;
  /** Drops the pending call and disarms the timer — the mirror of `flush`, and the only
   * way to be rid of an armed timer without `onFire` running. For an owner being thrown
   * away rather than shut down: a store instance a test is finished with, whose pending
   * write must not land on whatever globals the next one installs. */
  cancel(): void;
};

export type DebouncerOptions<T> = {
  delayMs: number;
  onFire: (value: T) => void;
  /** Node-only: lets the timer avoid holding the process open. Leave unset from the
   * renderer — the DOM timer handle has no `.unref()` to call. */
  unref?: boolean;
};

export function createDebouncer<T = void>({
  delayMs,
  onFire,
  unref,
}: DebouncerOptions<T>): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Boxed so a real pending value — including `undefined` for a `Debouncer<void>`, or a
  // falsy-but-meaningful `0` scroll position — is distinguishable from "nothing pending".
  let pending: { value: T } | null = null;

  function fire(): void {
    timer = null;
    if (pending !== null) {
      const { value } = pending;
      pending = null;
      onFire(value);
    }
  }

  return {
    notify(value) {
      pending = { value };
      if (timer !== null) {
        return;
      }
      timer = setTimeout(fire, delayMs);
      if (unref) {
        // Node's timer carries `.unref()`; the DOM timer (a bare number) does not. A caller
        // opting in is expected to be a Node caller (main/CLI), but this checks structurally
        // rather than casting past the type — a renderer call site that mistakenly set
        // `unref: true` degrades to a no-op instead of throwing on a bare `number`. This file
        // itself stays free of `node:` imports and of any dependency on `@types/node` so it
        // still compiles under the renderer's DOM-only program (see tsconfig.shared.json).
        const maybeNodeTimer: unknown = timer;
        if (
          typeof maybeNodeTimer === "object" &&
          maybeNodeTimer !== null &&
          "unref" in maybeNodeTimer &&
          typeof maybeNodeTimer.unref === "function"
        ) {
          maybeNodeTimer.unref();
        }
      }
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        fire();
      }
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}

export type KeyedDebouncer<K, T = void> = {
  /** Records `value` as key `key`'s next fire, arming that key's timer if it is not already
   * armed. Independent keys never coalesce into each other's write. */
  notify(key: K, value: T): void;
  /** Fires `key`'s pending call now, if it has one. A no-op if `key` has nothing pending. */
  flush(key: K): void;
  /** Fires every key's pending call now — the quit/unload path, so nothing armed is ever
   * silently dropped. */
  flushAll(): void;
  /** Drops every key's pending call and disarms every timer, firing nothing — the discard
   * path (see `Debouncer.cancel`). */
  cancelAll(): void;
};

/** Keyed by `K`, so unrelated keys (sessions, in the one caller that needs this) never
 * coalesce: activity on one key arms only that key's timer, and never postpones or eats
 * another key's pending write. Built on `createDebouncer` — one per key, created on first
 * `notify` and discarded once it fires, so an idle key costs nothing. */
export function createKeyedDebouncer<K, T = void>({
  delayMs,
  onFire,
}: {
  delayMs: number;
  onFire: (key: K, value: T) => void;
}): KeyedDebouncer<K, T> {
  const debouncers = new Map<K, Debouncer<T>>();

  function debouncerFor(key: K): Debouncer<T> {
    const existing = debouncers.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = createDebouncer<T>({
      delayMs,
      onFire: (value) => {
        // Cleared before the call, not after: a re-`notify` from inside `onFire` (none of
        // today's callers do this, but the invariant should hold regardless) arms a fresh
        // timer rather than being swallowed by a key that looks still-pending.
        debouncers.delete(key);
        onFire(key, value);
      },
    });
    debouncers.set(key, created);
    return created;
  }

  return {
    notify(key, value) {
      debouncerFor(key).notify(value);
    },
    flush(key) {
      debouncers.get(key)?.flush();
    },
    flushAll() {
      // Snapshot the keys first: firing one deletes it from `debouncers` (see `onFire`
      // above), which would otherwise skip whichever key iteration lands on next.
      for (const key of Array.from(debouncers.keys())) {
        debouncers.get(key)?.flush();
      }
    },
    cancelAll() {
      // No snapshot needed, unlike `flushAll`: cancelling runs no `onFire`, so nothing can
      // touch the map while this walks it. The map is emptied afterwards — a cancelled key
      // has no timer left to reach, and an idle key is meant to cost nothing.
      for (const debouncer of debouncers.values()) {
        debouncer.cancel();
      }
      debouncers.clear();
    },
  };
}
