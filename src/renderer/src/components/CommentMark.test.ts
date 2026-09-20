import { describe, expect, it } from "vitest";
import { CommentResolution } from "../../../shared/review-progress";
import { commentMarkLabel, markMeaning } from "@/components/CommentMark";

// The menu itself is portalled and closed until clicked, so a static render shows none of
// it; what is pinned here is the pure half it draws from. Not the sentences — a test that
// repeats a sentence is a second copy of it — but the two properties the wording was added
// to buy: no two words are explained alike (the reader's question was that `skipped` and
// `disagree` read as one thing), and the rail's hint explains a word the way the menu did.

describe("markMeaning", () => {
  it("explains every word, and no two of them the same way", () => {
    const meanings = CommentResolution.options.map(markMeaning);
    expect(meanings.every((meaning) => meaning.trim().length > 0)).toBe(true);
    expect(new Set(meanings).size).toBe(CommentResolution.options.length);
  });

  it("is a caption, not a sentence: the hint supplies the full stop", () => {
    for (const word of CommentResolution.options) {
      expect(markMeaning(word)).not.toMatch(/[.!?]$/u);
    }
  });
});

describe("commentMarkLabel", () => {
  it("says nothing about an unmarked comment", () => {
    expect(commentMarkLabel(null)).toBeNull();
  });

  it("carries the menu's meaning for the word, in the first person", () => {
    for (const word of CommentResolution.options) {
      const label = commentMarkLabel(word);
      expect(label).toMatch(/^You /u);
      expect(label).toContain(`${markMeaning(word)}.`);
    }
  });
});
