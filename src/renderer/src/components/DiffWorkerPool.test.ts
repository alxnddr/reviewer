import { describe, expect, it } from "vitest";
import { resolvePoolSize } from "./DiffWorkerPool";

// Diff highlighting is bursty and cache-backed, not throughput-bound, so the pool is capped
// at 4 workers regardless of core count — see the comment on resolvePoolSize. This guards
// against a many-core machine (e.g. hardwareConcurrency: 16) spawning one worker per core,
// each carrying the full resolved theme + grammar payload.
describe("resolvePoolSize", () => {
  it("never exceeds 4 workers on many-core machines", () => {
    expect(resolvePoolSize(16)).toBe(4);
    expect(resolvePoolSize(8)).toBe(4);
  });

  it("uses the core count when it is at or below the cap", () => {
    expect(resolvePoolSize(4)).toBe(4);
    expect(resolvePoolSize(2)).toBe(2);
    expect(resolvePoolSize(1)).toBe(1);
  });

  it("falls back to 4 when hardwareConcurrency is unavailable", () => {
    expect(resolvePoolSize(0)).toBe(4);
  });
});
