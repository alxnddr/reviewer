import { describe, expect, it } from "vitest";
import type { GitFailure } from "../../../shared/git";
import { gitFailureMessage } from "./git-failure-message";

describe("gitFailureMessage", () => {
  it("has a sentence for every failure code", () => {
    const failures: GitFailure[] = [
      { code: "gitMissing" },
      { code: "notARepo", path: "/tmp/nowhere" },
      { code: "unknownRevision" },
      { code: "invalidRange" },
      { code: "outputOverflow", limitBytes: 32 * 1024 * 1024 },
      { code: "timeout" },
      { code: "unexpected" },
    ];
    for (const failure of failures) {
      const message = gitFailureMessage(failure);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("names the offending path and the size limit", () => {
    expect(gitFailureMessage({ code: "notARepo", path: "/tmp/nowhere" })).toContain("/tmp/nowhere");
    expect(gitFailureMessage({ code: "outputOverflow", limitBytes: 32 * 1024 * 1024 })).toContain(
      "32 MiB",
    );
  });

  it("throws on an unknown code", () => {
    expect(() => gitFailureMessage({ code: "nonsense" } as unknown as GitFailure)).toThrow(
      /Unhandled variant/,
    );
  });
});
