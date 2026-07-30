import { describe, expect, it } from "vitest";
import type { ReviewOpenFailure } from "../../../shared/review-open";
import { reviewOpenFailureMessage } from "./review-open-failure-message";

describe("reviewOpenFailureMessage", () => {
  it("has a sentence for every failure code", () => {
    const failures: ReviewOpenFailure[] = [
      { code: "wrongExtension" },
      { code: "fileNotFound" },
      { code: "tooLarge" },
      { code: "unreadable" },
      { code: "invalidContent" },
      { code: "repoUnavailable", reason: { code: "gitMissing" } },
    ];
    for (const failure of failures) {
      expect(reviewOpenFailureMessage(failure).length).toBeGreaterThan(0);
    }
  });

  it("names the repo the artifact pointed at when git refused it", () => {
    const message = reviewOpenFailureMessage({
      code: "repoUnavailable",
      reason: { code: "notARepo", path: "/Users/victim/.ssh" },
    });
    // The reader needs to see both that the *repository* is the problem and which
    // one — the banner is the only place the artifact's claim becomes visible.
    expect(message).toContain("repository could not be opened");
    expect(message).toContain("/Users/victim/.ssh");
  });

  it("throws on an unknown code", () => {
    expect(() =>
      reviewOpenFailureMessage({ code: "nonsense" } as unknown as ReviewOpenFailure),
    ).toThrow(/Unhandled variant/u);
  });
});
