import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const NOW = new Date("2026-07-04T12:00:00Z");

describe("relativeTime", () => {
  it("formats each magnitude at commit-list density", () => {
    expect(relativeTime("2026-07-04T11:59:40Z", NOW)).toBe("just now");
    expect(relativeTime("2026-07-04T11:45:00Z", NOW)).toBe("15m ago");
    expect(relativeTime("2026-07-04T09:00:00Z", NOW)).toBe("3h ago");
    expect(relativeTime("2026-07-01T12:00:00Z", NOW)).toBe("3d ago");
    expect(relativeTime("2026-05-01T12:00:00Z", NOW)).toBe("2mo ago");
    expect(relativeTime("2024-07-04T12:00:00Z", NOW)).toBe("2y ago");
  });

  it("treats a skewed future timestamp as just now, never negative", () => {
    expect(relativeTime("2026-07-04T12:05:00Z", NOW)).toBe("just now");
  });

  it("returns empty for an unparseable timestamp", () => {
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});
