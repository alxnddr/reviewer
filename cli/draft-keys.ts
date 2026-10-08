import {
  FlowEdge,
  FlowNode,
  FlowVisual,
  ReviewAnchor,
  ReviewComment,
  ReviewLayerInput,
  LineLayerRange,
  WholeFileLayerRange,
  ReviewOverview,
  SkeletonLine,
  SkeletonVisual,
  artifactPath,
} from "../src/shared/review";
import type { ValidationProblem } from "../src/tools/review-validator";

// Keys an author wrote that the review has no place for. The artifact schema is deliberately
// lenient about them below the top level: `ReviewComment`, both `ReviewLayerRange` arms and
// `ReviewOverview` are plain `z.object`s, so an artifact written by a newer build still opens in
// an older app with the unknown keys dropped (`shared/review.ts` states that trade on each). That
// leniency is right for the *reader* and wrong for the *author*: a draft's `"suggestion"` on a
// comment passed the gate, was written into the file, and then vanished on open, and a top-level
// `"layer"` (for `layers`) was not even read — `emit` picks out its three keys — so the
// walkthrough silently went missing from an exit-0 emit. The author is the one party who can fix
// a typo, so this is where it is caught.
//
// Here and not in the schema, for that reason: tightening the shared schemas would make the app
// refuse every artifact in the wild that carries a key it does not know. The allowed sets are
// read off the schemas' own shapes, so a field added there is accepted here with no second edit.
//
// Pure, and only about keys. A value of the wrong *type* is the schema's to report (the gate runs
// it right after), so the walk descends only through values shaped like what it expects and says
// nothing about the rest — one problem, from one checker, per mistake.

/** The keys a draft may carry at its top level. `repo`/`base`/`head` are not among them: `rvw
 * emit` resolves the range itself, and a draft that names one is carrying a decision it does not
 * own — and one `emit` would silently ignore. */
const DRAFT_KEYS: ReadonlySet<string> = new Set(["overview", "comments", "layers"]);

/** The keys `rvw emit` fills in on the caller's behalf, refused with the reason rather than as
 * a bare unknown key, because "remove it" is the whole fix. */
const EMIT_SUPPLIED: ReadonlySet<string> = new Set(["repo", "base", "head", "reviewedHead", "pr"]);

const COMMENT_KEYS = keysOf(ReviewComment.shape);
const OVERVIEW_KEYS = keysOf(ReviewOverview.shape);
const LAYER_KEYS = keysOf(ReviewLayerInput.shape);
/** Either arm's keys: a range is a line range or a whole-file one (`ReviewLayerRange`), and
 * which one an author meant is the schema's to report, not a stray key's. */
const RANGE_KEYS = new Set([...keysOf(LineLayerRange.shape), ...keysOf(WholeFileLayerRange.shape)]);
const ANCHOR_KEYS = keysOf(ReviewAnchor.shape);
const FLOW_KEYS = keysOf(FlowVisual.shape);
const SKELETON_KEYS = keysOf(SkeletonVisual.shape);
const NODE_KEYS = keysOf(FlowNode.shape);
const EDGE_KEYS = keysOf(FlowEdge.shape);
const LINE_KEYS = keysOf(SkeletonLine.shape);

function keysOf(shape: object): ReadonlySet<string> {
  return new Set(Object.keys(shape));
}

/** A located place: the path segments `artifactPath` renders, kept as segments while the walk
 * descends so the one renderer the schema's problems go through renders these too. */
type Path = readonly PropertyKey[];

/** Every unknown key in a draft (`{ overview?, comments?, layers? }`), located by the same
 * path a schema problem uses (`comments#3.suggestion`, `layers#1.children#2.ranges#1.why`),
 * rendered by the same `artifactPath`, so an author reads both kinds of problem the same way —
 * and `withoutDuplicates` can match them as strings. */
export function unknownDraftKeys(draft: Readonly<Record<string, unknown>>): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const key of Object.keys(draft)) {
    if (EMIT_SUPPLIED.has(key)) {
      problems.push({
        kind: "schema",
        path: artifactPath([key]),
        message: `"${key}" is filled in by rvw emit — remove it from the draft`,
      });
    } else if (!DRAFT_KEYS.has(key)) {
      problems.push(unknownKey([], key, DRAFT_KEYS));
    }
  }
  problems.push(...unknownArtifactKeys(draft));
  return problems;
}

/** The unknown keys inside the authored parts of a review — its overview, comments and layers —
 * whether they arrive as a draft or inside a finished artifact. `rvw check` runs this on an
 * artifact so the two verbs agree: a file `emit` would have refused for a stray comment key is
 * not one `check` calls ready. The artifact's own top level needs no walk here; it is a
 * `strictObject` and the schema already refuses what it does not know. */
export function unknownArtifactKeys(parts: Readonly<Record<string, unknown>>): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const { overview, comments, layers } = parts;
  if (isRecord(overview)) {
    problems.push(
      ...strayKeys(["overview"], overview, OVERVIEW_KEYS),
      ...visualKeys(["overview", "visual"], overview.visual),
    );
  }
  if (Array.isArray(comments)) {
    comments.forEach((comment, index) => {
      if (isRecord(comment)) {
        problems.push(...strayKeys(["comments", index], comment, COMMENT_KEYS));
      }
    });
  }
  if (Array.isArray(layers)) {
    problems.push(...layerKeys(["layers"], layers));
  }
  return problems;
}

/** One level of the outline, and everything under it. Layers are a `strictObject`, so the
 * schema would also catch a stray layer key — but only that one: the walk has to visit layers
 * anyway to reach their ranges, and reporting both kinds from here keeps an outline's key
 * problems in one place and in one wording. The schema's own duplicate is dropped by
 * `withoutDuplicates` where the two meet. */
function layerKeys(path: Path, layers: readonly unknown[]): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  layers.forEach((layer, index) => {
    if (!isRecord(layer)) {
      return;
    }
    const at = [...path, index];
    problems.push(...strayKeys(at, layer, LAYER_KEYS));
    const { ranges, children, visual, focus } = layer;
    problems.push(...visualKeys([...at, "visual"], visual));
    if (isRecord(focus)) {
      problems.push(...strayKeys([...at, "focus"], focus, ANCHOR_KEYS));
    }
    if (Array.isArray(ranges)) {
      ranges.forEach((range, rangeIndex) => {
        if (isRecord(range)) {
          problems.push(...strayKeys([...at, "ranges", rangeIndex], range, RANGE_KEYS));
        }
      });
    }
    if (Array.isArray(children)) {
      problems.push(...layerKeys([...at, "children"], children));
    }
  });
  return problems;
}

/** A visual and everything in it — the plain objects the schema would silently thin (see the
 * header). The kind picks the key set; a visual whose `kind` is missing or unknown is the
 * schema's to report, so the walk stops there rather than guessing which shape was meant. */
function visualKeys(path: Path, visual: unknown): ValidationProblem[] {
  if (!isRecord(visual)) {
    return [];
  }
  const problems: ValidationProblem[] = [];
  const elements = (key: "nodes" | "edges" | "lines", allowed: ReadonlySet<string>): void => {
    const { [key]: list } = visual;
    if (!Array.isArray(list)) {
      return;
    }
    list.forEach((element, index) => {
      if (!isRecord(element)) {
        return;
      }
      problems.push(...strayKeys([...path, key, index], element, allowed));
      // Every element kind carries an `at` now (an edge's is optional); the guard stays so a
      // future element without one reports a stray `at` once, as a key, not twice.
      const { at } = element;
      if (allowed.has("at") && isRecord(at)) {
        problems.push(...strayKeys([...path, key, index, "at"], at, ANCHOR_KEYS));
      }
    });
  };
  const { kind } = visual;
  if (kind === "flow") {
    problems.push(...strayKeys(path, visual, FLOW_KEYS));
    elements("nodes", NODE_KEYS);
    elements("edges", EDGE_KEYS);
  } else if (kind === "skeleton") {
    problems.push(...strayKeys(path, visual, SKELETON_KEYS));
    elements("lines", LINE_KEYS);
  }
  return problems;
}

function strayKeys(
  path: Path,
  object: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): ValidationProblem[] {
  return Object.keys(object)
    .filter((key) => !allowed.has(key))
    .map((key) => unknownKey(path, key, allowed));
}

/** The problem for one stray key, naming the keys that *are* allowed there: the likeliest
 * cause is a near-miss (`layer`, `severity_level`, `line`), and the list is the fix. */
function unknownKey(path: Path, key: string, allowed: ReadonlySet<string>): ValidationProblem {
  return {
    kind: "schema",
    path: artifactPath([...path, key]),
    message: `unknown key "${key}" — the keys here are ${[...allowed].join(", ")}`,
  };
}

/** Problems from this check and from the schema gate, with the schema's own report of a stray
 * key removed where this check already named it. Layers are the one place both speak (they are
 * a `strictObject`), and two sentences about one typo is one too many. */
export function withoutDuplicates(
  keyProblems: readonly ValidationProblem[],
  gateProblems: readonly ValidationProblem[],
): ValidationProblem[] {
  const named = new Set(
    keyProblems.flatMap((problem) => (problem.kind === "schema" ? [problem.path] : [])),
  );
  const parents = new Set([...named].map((path) => parentPath(path)));
  const rest = gateProblems.filter(
    (problem) =>
      !(
        problem.kind === "schema" &&
        parents.has(problem.path) &&
        problem.message.toLowerCase().includes("unrecognized key")
      ),
  );
  return [...keyProblems, ...rest];
}

function parentPath(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
