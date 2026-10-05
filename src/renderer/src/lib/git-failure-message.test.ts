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
      { code: "authFailed" },
      { code: "remoteNotFound" },
      { code: "remoteRefMissing", ref: "refs/pull/12/head" },
      { code: "network" },
      { code: "remoteFailed", detail: "remote: SSO required" },
      { code: "cancelled" },
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

  it("names the missing remote ref and carries the remote's own line", () => {
    expect(gitFailureMessage({ code: "remoteRefMissing", ref: "refs/pull/12/head" })).toContain(
      "refs/pull/12/head",
    );
    expect(gitFailureMessage({ code: "remoteFailed", detail: "remote: SSO required" })).toContain(
      "remote: SSO required",
    );
  });

  it("throws on an unknown code", () => {
    expect(() => gitFailureMessage({ code: "nonsense" } as unknown as GitFailure)).toThrow(
      /Unhandled variant/u,
    );
  });
});
