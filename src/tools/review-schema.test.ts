import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { MAX_LAYER_DEPTH } from "../shared/layers";
import { ReviewArtifact } from "../shared/review";
import { reviewArtifactJsonSchema } from "./review-schema";

// The emitted schema is only worth emitting if a real third-party validator enforces it,
// so these tests compile it with Ajv rather than inspecting its keys. Where the schema and
// the zod contract *must* diverge (the cross-field range rule), that divergence is asserted
// in both directions — the schema documents it, zod rejects it — so a future zod release
// that starts serializing refinements makes the "schema accepts it" assertion fail loudly
// rather than leaving a stale comment behind.

const VALID = {
  repo: "/repo",
  base: "main",
  head: "feature",
  patch: "diff --git a/a.ts b/a.ts\n",
  comments: [{ file: "a.ts", side: "additions", startLine: 2, endLine: 4, body: "why" }],
  layers: [
    {
      label: "One",
      summary: "first",
      ranges: [{ file: "a.ts", side: "additions", startLine: 2, endLine: 4 }],
    },
  ],
};

function compiled(): ValidateFunction {
  // `strict: false` because zod emits `additionalProperties` alongside `oneOf` branches,
  // which Ajv's strict mode flags as a schema-authoring smell rather than an error.
  return new Ajv2020({ strict: false }).compile(reviewArtifactJsonSchema());
}

describe("reviewArtifactJsonSchema", () => {
  it("accepts a valid artifact", () => {
    expect(compiled()(VALID)).toBe(true);
    expect(ReviewArtifact.safeParse(VALID).success).toBe(true);
  });

  it('rejects side:"old" — the wire word an agent is most likely to guess wrong', () => {
    const artifact = {
      ...VALID,
      comments: [{ file: "a.ts", side: "old", startLine: 2, endLine: 4, body: "why" }],
    };
    expect(compiled()(artifact)).toBe(false);
    expect(ReviewArtifact.safeParse(artifact).success).toBe(false);
  });

  it("rejects an unknown top-level key rather than silently ignoring it", () => {
    expect(compiled()({ ...VALID, submitted: true })).toBe(false);
    expect(ReviewArtifact.safeParse({ ...VALID, submitted: true }).success).toBe(false);
  });

  it("describes what may be *written*: only repo/base/head are required", () => {
    // The schema is what an authoring agent writes against, so it must not demand the keys
    // the parse fills in — an artifact with no comments, or a layer with no children, is
    // written by leaving them out, and the schema has to say so.
    const schema = reviewArtifactJsonSchema();
    expect(schema.required).toEqual(["repo", "base", "head"]);
    expect(compiled()({ repo: "/repo", base: "main", head: "feature" })).toBe(true);
    expect(compiled()({ ...VALID, layers: [{ label: "Bare" }] })).toBe(true);
  });

  it("carries the recursive layer through $defs, so `children` nests to any depth", () => {
    expect(
      compiled()({
        ...VALID,
        layers: [{ label: "Group", children: [{ label: "Inner", children: [{ label: "Deep" }] }] }],
      }),
    ).toBe(true);
  });

  it("documents the descending-range rule it structurally cannot enforce, which zod enforces", () => {
    const descending = {
      ...VALID,
      comments: [{ file: "a.ts", side: "additions", startLine: 9, endLine: 4, body: "why" }],
    };
    // JSON Schema has no keyword relating two sibling properties, so the emitted document
    // cannot reject this. The contract does — which is why `rvw check` is the authority.
    expect(compiled()(descending)).toBe(true);
    expect(ReviewArtifact.safeParse(descending).success).toBe(false);

    // ...and the rule an agent must honor is stated in the schema it authors against.
    const schema = reviewArtifactJsonSchema();
    expect(JSON.stringify(schema)).toContain("endLine must be greater than or equal to startLine");
    expect(schema.description).toContain("`rvw check`");
  });

  it("publishes the two optional fields an author writes by hand: a range note and a verdict", () => {
    // `rvw schema` is what the authoring skill names as the authority on field rules, so a
    // field the app reads and the published document does not describe is a field agents
    // will not write. Both are checked through the compiled validator rather than by looking
    // for a key, since an agent's own validator is what would reject them.
    const annotated = {
      ...VALID,
      overview: { title: "Back off per host", body: "why", verdict: "caution" },
      layers: [
        {
          label: "One",
          ranges: [
            { file: "a.ts", side: "additions", startLine: 2, endLine: 4, note: "read first" },
          ],
        },
      ],
    };
    expect(compiled()(annotated)).toBe(true);
    expect(ReviewArtifact.safeParse(annotated).success).toBe(true);

    // A verdict outside the closed three is refused by both, so an agent authoring against
    // the document alone learns the vocabulary is not open before it emits.
    expect(compiled()({ ...VALID, overview: { title: "t", body: "b", verdict: "approved" } })).toBe(
      false,
    );

    // ...and each carries the one rule its type cannot say. Not the advice on when to write
    // one: that is the skill's, and the descriptions were cut back to the rule on purpose.
    const document = JSON.stringify(reviewArtifactJsonSchema());
    expect(document).toContain("only the first note is shown");
    expect(document).toContain("never replaces the verdict sentence");
  });

  it("publishes a comment's postable text, and the one rule about who it is written to", () => {
    // The field an agent writes for the change's author. Absent from the published document,
    // an agent reviewing a pull request would put that text in `body` — the one field the app
    // never posts.
    const postable = {
      ...VALID,
      comments: [
        {
          file: "a.ts",
          side: "additions",
          startLine: 2,
          endLine: 4,
          body: "why",
          postable: "Could this await the write before it returns?",
        },
      ],
    };
    expect(compiled()(postable)).toBe(true);
    expect(ReviewArtifact.safeParse(postable).success).toBe(true);
    expect(JSON.stringify(reviewArtifactJsonSchema())).toContain(
      "never refers to the agent, the review, the evidence or the tour",
    );
  });

  it("publishes the guide's visuals once, with their limits and the rules zod cannot state", () => {
    const at = { file: "a.ts", side: "additions", startLine: 2, endLine: 4 };
    const guided = {
      ...VALID,
      overview: {
        title: "t",
        lede: "One sentence.",
        steps: ["first", "second"],
        visual: {
          kind: "flow",
          caption: "c",
          nodes: [
            { id: "a", label: "a()", status: "same" },
            { id: "b", label: "b()", status: "added", at },
          ],
          edges: [{ from: "a", to: "b" }],
        },
      },
      layers: [{ ...VALID.layers[0], focus: at }],
    };
    expect(compiled()(guided)).toBe(true);
    expect(ReviewArtifact.safeParse(guided).success).toBe(true);

    // The limits an agent's own validator enforces: a label past 40, a line break in a lede.
    const longLabel = structuredClone(guided);
    longLabel.overview.visual.nodes[1]!.label = "x".repeat(41);
    expect(compiled()(longLabel)).toBe(false);
    expect(compiled()({ ...guided, overview: { ...guided.overview, lede: "a\nb" } })).toBe(false);

    const schema = reviewArtifactJsonSchema();
    expect(Object.keys(schema.$defs ?? {})).toContain("reviewVisual");
    // ...and the anchored rule, which no keyword can express, as prose.
    expect(JSON.stringify(schema)).toContain("needs `at`; an edge may carry one");
    expect(JSON.stringify(schema)).toContain("on the side and lines its status claims");
  });

  it("is derived from the contract, not hand-written: every artifact key appears in the schema", () => {
    const properties = reviewArtifactJsonSchema().properties ?? {};
    expect(Object.keys(properties).toSorted()).toEqual([
      "base",
      "comments",
      "head",
      "layers",
      "overview",
      "patch",
      "pr",
      "repo",
      "reviewedHead",
    ]);
  });

  it("publishes the pull request, says who writes it, and refuses a host it does not know", () => {
    const pr = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
    expect(compiled()({ ...VALID, pr })).toBe(true);
    expect(ReviewArtifact.safeParse({ ...VALID, pr }).success).toBe(true);

    const gitlab = { ...VALID, pr: { ...pr, host: "gitlab.com" } };
    expect(compiled()(gitlab)).toBe(false);
    expect(ReviewArtifact.safeParse(gitlab).success).toBe(false);

    expect(JSON.stringify(reviewArtifactJsonSchema())).toContain("fills this in from `--pr`");
  });
});

describe("the authoring skill's quoted limits", () => {
  // The skill quotes a handful of limits so an agent writes to them the first time rather than
  // learning them from a refusal — and it once said "3 to 5 steps" in two places while the
  // schema enforced 2 to 5, so an agent read two answers to one question. The schema is the one
  // source: each number the skill states is read back here from the published document, and any
  // other "N to M" beside `steps` fails, so an edit to either side that forgets the other is red.
  const skill = readFileSync(
    fileURLToPath(new URL("../../skills/present-review/SKILL.md", import.meta.url)),
    "utf8",
  );
  type Limits = {
    properties: {
      lede: { maxLength: number };
      steps: { minItems: number; maxItems: number; items: { maxLength: number } };
    };
  };
  const overview = (reviewArtifactJsonSchema().properties?.["overview"] ?? {}) as Limits;
  const lede = overview.properties.lede.maxLength;
  const { minItems, maxItems, items } = overview.properties.steps;

  it("states the step count, the step and lede lengths and the nesting depth the schema enforces", () => {
    expect(skill).toContain(
      `\`steps\` holds ${minItems} to ${maxItems} lines of at most ${items.maxLength} each`,
    );
    expect(skill).toContain(
      `| ${minItems} to ${maxItems} lines, each at most ${items.maxLength} characters |`,
    );
    expect(skill).toContain(`Write ${minItems} to ${maxItems} \`steps\``);
    expect(skill).toContain(`\`lede\` is one line of at most ${lede} characters`);
    expect(skill).toContain(`| one sentence, at most ${lede} characters |`);
    expect(skill).toContain(`layers nest at most ${MAX_LAYER_DEPTH} deep`);
  });

  it("gives no other step count anywhere it talks about steps", () => {
    const counts = skill
      .split("\n")
      .filter((line) => line.includes("`steps`"))
      .flatMap((line) => [...line.matchAll(/\b(\d+) to (\d+)\b/gu)].map((match) => match[0]));
    expect(counts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(counts)).toEqual(new Set([`${minItems} to ${maxItems}`]));
  });
});
