import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The de-dup guard: there is exactly one `validate` shell (and one `emit` shell) — not two
// drifting ones. These assertions fail if a future change resurrects the old standalone script
// or its `validate:review` alias.

const REPO_ROOT = join(import.meta.dirname, "..");

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

describe("validate shell de-duplication", () => {
  it("has deleted the standalone src/tools/validate-review.ts shell", () => {
    expect(existsSync(join(REPO_ROOT, "src/tools/validate-review.ts"))).toBe(false);
  });

  it("no longer exposes a validate:review script or references the old shell in package.json", () => {
    const pkg = read("package.json");
    expect(pkg).not.toContain("validate:review");
    expect(pkg).not.toContain("validate-review.ts");
  });

  it("points the authoring-review skill at the rvw gate, not the deleted script", () => {
    const skill = read("skills/authoring-review/SKILL.md");
    expect(skill).not.toContain("validate:review");
    // `rvw check` is the skill's pre-handoff gate and runs the same validator `rvw validate`
    // does, so it — not a bare `validate` — is what the skill now invokes.
    expect(skill).toContain("rvw check");
  });
});

describe("emit shell de-duplication", () => {
  it("has deleted the skill-bundled scripts/emit-review.ts shell", () => {
    expect(existsSync(join(REPO_ROOT, "skills/authoring-review/scripts/emit-review.ts"))).toBe(
      false,
    );
  });

  it("no longer includes the dead skill scripts glob in tsconfig.tools.json", () => {
    expect(read("tsconfig.tools.json")).not.toContain("authoring-review/scripts");
  });

  it("points the authoring-review skill at rvw emit, not the deleted script", () => {
    const skill = read("skills/authoring-review/SKILL.md");
    expect(skill).not.toContain("emit-review.ts");
    expect(skill).not.toContain("scripts/emit-review");
    expect(skill).toContain("rvw emit");
  });
});
