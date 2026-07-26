import { describe, expect, it } from "vitest";
import { absoluteTime, shortAge } from "./relative-time";

const NOW = new Date("2026-07-04T12:00:00Z");

describe("shortAge", () => {
  it("formats the same magnitudes as a column, without the 'ago'", () => {
    expect(shortAge("2026-07-04T11:59:40Z", NOW)).toBe("now");
    expect(shortAge("2026-07-04T11:45:00Z", NOW)).toBe("15m");
    expect(shortAge("2026-07-04T09:00:00Z", NOW)).toBe("3h");
    expect(shortAge("2026-07-01T12:00:00Z", NOW)).toBe("3d");
    expect(shortAge("2026-05-01T12:00:00Z", NOW)).toBe("2mo");
    expect(shortAge("2024-07-04T12:00:00Z", NOW)).toBe("2y");
  });

  it("never goes negative on a skewed future timestamp, and stays empty on garbage", () => {
    expect(shortAge("2026-07-04T12:05:00Z", NOW)).toBe("now");
    expect(shortAge("not a date", NOW)).toBe("");
  });
});

describe("absoluteTime", () => {
  it("names the day the age cannot", () => {
    // Locale-formatted, so the assertion is on the parts rather than the punctuation
    // between them — the point is that the day, month, year and clock time are there.
    const formatted = absoluteTime("2026-07-04T09:30:00Z");
    expect(formatted).toMatch(/Jul/);
    expect(formatted).toMatch(/4/);
    expect(formatted).toMatch(/2026/);
  });

  it("returns empty for an unparseable timestamp", () => {
    expect(absoluteTime("not a date")).toBe("");
  });
});
