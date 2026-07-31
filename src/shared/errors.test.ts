import { describe, expect, it } from "vitest";
import { errnoCode, errorMessage } from "./errors";

/** A rejection shaped the way `node:fs` shapes one. */
function fsError(code: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory`), { code });
}

describe("errorMessage", () => {
  it("takes an Error's message and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
    // The case the helper exists for: a thrown object would otherwise reach a user as
    // "[object Object]" through a template literal.
    expect(errorMessage({ boom: true })).toBe("[object Object]");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("errnoCode", () => {
  it("reads the errno off a node rejection", () => {
    expect(errnoCode(fsError("ENOENT"))).toBe("ENOENT");
    expect(errnoCode(fsError("EISDIR"))).toBe("EISDIR");
  });

  it("answers undefined for anything that is not an Error carrying a string code", () => {
    expect(errnoCode(new Error("plain"))).toBeUndefined();
    expect(errnoCode("ENOENT")).toBeUndefined();
    // A bare object with a `code` is not a caught node error — every call site this replaced
    // either checked for an `Error` first, cast past the type to reach `.code`, or (the git
    // runner's `error` event) trusted an annotation that promised one.
    expect(errnoCode({ code: "ENOENT" })).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode(Object.assign(new Error("odd"), { code: 2 }))).toBeUndefined();
  });
});
