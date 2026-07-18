import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

const { isAllowedExternalUrl } = await import("./external-links");

describe("isAllowedExternalUrl", () => {
  it("allows https URLs", () => {
    expect(isAllowedExternalUrl("https://example.com/")).toBe(true);
  });

  it.each(["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "not a url", ""])(
    "rejects %s",
    (url) => {
      expect(isAllowedExternalUrl(url)).toBe(false);
    },
  );
});
