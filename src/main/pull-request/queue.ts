// The write queue Review Pull Request…'s handlers serialize through (`handlers.ts` says which
// operations take which keys, and why). Its own module so it is tested without Electron.

export type Queue = <T>(keys: readonly string[], task: () => Promise<T>) => Promise<T>;

/** Runs `task` once every task queued before it under *any* of its keys has settled, whatever
 * their outcome; tasks that share no key run side by side. A task waits only on tasks that
 * were queued before it, so no two can wait on each other. */
export function createKeyedQueue(): Queue {
  const tails = new Map<string, Promise<unknown>>();
  return (keys, task) => {
    const before = Promise.all(keys.map((key) => tails.get(key) ?? Promise.resolve()));
    const run = before.then(task, task);
    const tail = run.catch(() => {});
    for (const key of keys) {
      tails.set(key, tail);
    }
    // The last task out drops its keys, so the map holds only keys with work pending.
    void tail.then(() => {
      for (const key of keys) {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    });
    return run;
  };
}
