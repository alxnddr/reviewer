import { describe, expect, it, vi } from "vitest";
import { claimFileDrag, isFileDrag, takeDroppedFile, type DragLike } from "./review-drop";

// The load-bearing invariant: a file drag is always preventDefault'd, so the
// dropped `file://` never reaches `will-navigate` (window.ts) as a navigation.

function fileDrag(files: File[] = []): DragLike & { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn(), dataTransfer: { types: ["Files"], files } };
}

function textDrag(): DragLike & { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn(), dataTransfer: { types: ["text/plain"], files: [] } };
}

describe("isFileDrag", () => {
  it("is true only when the drag carries files", () => {
    expect(isFileDrag({ types: ["Files"] })).toBe(true);
    expect(isFileDrag({ types: ["text/plain"] })).toBe(false);
  });
});

describe("claimFileDrag", () => {
  it("preventDefaults and claims a file drag", () => {
    const event = fileDrag();
    expect(claimFileDrag(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-file drag untouched (no preventDefault)", () => {
    const event = textDrag();
    expect(claimFileDrag(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("takeDroppedFile", () => {
  it("preventDefaults and returns the first dropped file", () => {
    const file = new File(["{}"], "x.reviewer.json");
    const event = fileDrag([file]);
    expect(takeDroppedFile(event)).toBe(file);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("still preventDefaults when the drop carried no file", () => {
    const event = fileDrag([]);
    expect(takeDroppedFile(event)).toBeNull();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
