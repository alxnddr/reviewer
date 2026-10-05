import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GRAPHQL } from "./graphql-documents";

// "Never submit" (`next-features.md`, C4), held against the source, because nothing else can hold
// it. A fine-grained token with Pull requests: Read and write can also submit, approve, request
// changes and publish single comments — no token can be narrowed below that — so the only thing
// standing between the reader's token and a review or comment they did not publish is that this
// app has no code that asks for one. A GraphQL document is a string and a request body is data:
// the types see neither, lint sees neither, and a runtime test covers only the paths it drives.
// So this test reads the files, in the form of `dom-ids.test.ts`, in four layers:
//
//   1. **The words.** No non-test file under `src/main/`, `src/preload/` or `src/shared/` names a
//      way to submit: the `submitPullRequestReview` mutation, a review's `event` key, the event
//      values `APPROVE` / `REQUEST_CHANGES` / `COMMENT`, or the REST `/reviews/{id}/events` path.
//      `COMMENT` is matched in uppercase as a whole word: that is how the event value is spelled
//      and nothing else in product code spells it so (`fingerprint.test.ts`'s `const COMMENT` is
//      a test, and tests ship nowhere — this one has to spell what it forbids).
//   2. **The one way to write.** `client.ts` can POST exactly one thing: a `GraphqlDocument` — the
//      constants in `graphql-documents.ts`, a literal union no other string satisfies — to a
//      hard-coded `/graphql`. A `GitHubCall` has no body. So outside `client.ts`, no file may
//      build a request shape (`method: "POST"`, a `"POST"` string, a `json:` property), reach the
//      network another way (`fetch(…)`, `net.request` / `net.fetch` — `index.ts` may hand
//      `net.request` to the transport, nothing else may), or hold a GraphQL operation: no string
//      literal outside `graphql-documents.ts` contains the word `mutation` at all, which catches
//      the anonymous (`mutation($id: ID!) {…}`, `mutation {…}`) forms a named-operation pattern
//      misses. String literals are read off the TypeScript AST, so comments may say "mutation".
//   3. **The three mutations, and exactly their inputs.** The documents hold three mutations, one
//      field each — start a pending review, add a thread to it, delete a pending comment — and
//      each one's `input: {…}` keys are whitelisted exactly. Starting the review names the pull
//      request and the commit and nothing else (no `event`, `body`, `threads`, `comments`: a body
//      or threads would ride on a review that could be submitted with them, an event submits it).
//      The thread names `pullRequestReviewId` — the pending review — and never `pullRequestId`,
//      which GitHub takes as "comment on the pull request now" and can publish the comment alone.
//      Queries read `repository`, `node` and `nodes` only.
//   4. **Proof each rule bites**, on planted samples below — including the five a review planted in
//      a scratch copy and an earlier version of this test let through (A–E), and the seven ways
//      round the second version a later review found (F–L): a concatenated or templated document
//      cast to the document type, `globalThis.fetch` signed with the token, an aliased `net` or
//      `https`, a document in a `.json` or `.mjs` file, and a bracket in a string hiding an input
//      key. Two rules close most of them at once: nothing outside `client.ts` and
//      `credentials.ts` reads a token's `bearer` — every write needs it — and nothing under
//      `src/main/github/` asserts a value to `GraphqlDocument`, `never` or `any`.

const ROOT = join(__dirname, "..", "..", "..");
const SCANNED = ["src/main", "src/preload", "src/shared"].map((dir) => join(ROOT, dir));
const DOCUMENTS_FILE = join(__dirname, "graphql-documents.ts");
const CLIENT_FILE = join(__dirname, "client.ts");
const INDEX_FILE = join(ROOT, "src", "main", "index.ts");
const CREDENTIALS_FILE = join(__dirname, "credentials.ts");
const GITHUB_DIR = __dirname;

/** Node's and Electron's ways onto the network other than the client's transport. */
const NETWORK_MODULES = new Set(
  ["http", "https", "http2", "net", "tls", "dgram", "undici"].flatMap((name) => [
    name,
    `node:${name}`,
  ]),
);

/** Type assertions that would let any string pass as a `GraphqlDocument`. */
const LAUNDERING_TYPES = new Set(["GraphqlDocument", "never", "any"]);

/** Every `.ts`/`.tsx` under `dir`, tests excluded. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

// --- 1. the words -------------------------------------------------------------------------

const FORBIDDEN: Readonly<Record<string, RegExp>> = {
  submitMutation: /submitPullRequestReview/iu,
  // A quoted `"event":` key in any text; the unquoted forms are read off the AST below
  // (`requestShapesIn`), where a parameter `event: IpcEventName` is told apart from a key.
  eventField: /["']event["']\s*:/iu,
  eventValue: /\b(?:APPROVE|REQUEST_CHANGES|COMMENT)\b/u,
  eventsPath: /\/events\b/u,
};

function forbiddenIn(text: string): string[] {
  return Object.entries(FORBIDDEN)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

// --- 2. the one way to write --------------------------------------------------------------

/** What a source text does that only `client.ts` (and, for `net.request`, `index.ts`) may: build
 * a request with a body, reach the network another way, or carry a GraphQL operation — and the
 * evasions of those rules a review found:
 *
 *   - `bearerAccess`: reading a token's `bearer` anywhere but `client.ts` (which sends it) and
 *     `credentials.ts` (which makes it). Every write to GitHub needs the token, so this one rule
 *     closes every other network primitive — `globalThis.fetch`, an aliased `net`, `https`.
 *   - `launderedDocument`: a type assertion to `GraphqlDocument`, `never` or `any` anywhere under
 *     `src/main/github/` — how a concatenated or templated string, which no literal rule can read,
 *     would get past the document type — and any assertion at all inside a `.graphql(` call.
 *   - `networkModule` / `electronNet`: importing `http`, `https`, `net`, `tls`… anywhere, or
 *     Electron's `net` anywhere but `index.ts`.
 *   - `fetchCall`: `fetch(…)`, or `x.fetch(…)` on any object. */
function requestShapesIn(text: string, file = "sample.ts"): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const inGitHubDir = file.startsWith(`${GITHUB_DIR}/`);
  const isAssertion = (node: ts.Node): node is ts.AsExpression | ts.TypeAssertion =>
    ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
  const containsAssertion = (node: ts.Node): boolean =>
    isAssertion(node) || (ts.forEachChild(node, containsAssertion) ?? false);
  const visit = (node: ts.Node): void => {
    if (isAssertion(node) && inGitHubDir && LAUNDERING_TYPES.has(node.type.getText(source))) {
      found.add("launderedDocument");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "graphql" &&
      node.arguments.some((argument) => containsAssertion(argument))
    ) {
      found.add("launderedDocument");
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "bearer") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "bearer") ||
      (ts.isBindingElement(node) &&
        (node.propertyName ?? node.name).getText(source).replaceAll(/["']/gu, "") === "bearer")
    ) {
      found.add("bearerAccess");
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      if (NETWORK_MODULES.has(from)) {
        found.add("networkModule");
      }
      const named = node.importClause?.namedBindings;
      if (
        from === "electron" &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.some(
          (element) => (element.propertyName ?? element.name).getText(source) === "net",
        )
      ) {
        found.add("electronNet");
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "require" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      NETWORK_MODULES.has(node.arguments[0].text)
    ) {
      found.add("networkModule");
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // A whole string that is the method — not the first word of a sentence in a template.
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /^post$/iu.test(node.text.trim())
      ) {
        found.add("postMethod");
      }
      if (/\bmutation\b/iu.test(node.text)) {
        found.add("graphqlMutation");
      }
      if (/\bevent\s*:/iu.test(node.text)) {
        found.add("eventInString");
      }
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = node.name.getText(source).replaceAll(/["']/gu, "");
      if (name === "json") {
        found.add("jsonBody");
      }
      if (name.toLowerCase() === "event") {
        found.add("eventKey");
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.getText(source);
      if (/^net\.(?:request|fetch)$/u.test(target)) {
        found.add("netRequest");
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.getText(source) === "fetch" ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "fetch" &&
          node.expression.expression.getText(source) !== "net"))
    ) {
      found.add("fetchCall");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].toSorted();
}

/** The request-shape findings a file is allowed. */
function allowedShapes(path: string): ReadonlySet<string> {
  if (path === CLIENT_FILE) {
    // The one POST (`"POST"`), `ACCEPT.json` (the media table's key), and the one place the
    // token is read into a header.
    return new Set(["postMethod", "jsonBody", "bearerAccess"]);
  }
  if (path === CREDENTIALS_FILE) {
    return new Set(["bearerAccess"]);
  }
  if (path === DOCUMENTS_FILE) {
    return new Set(["graphqlMutation"]);
  }
  if (path === INDEX_FILE) {
    return new Set(["netRequest", "electronNet"]);
  }
  return new Set();
}

/** Files TypeScript does not parse but a bundler would still take — a `.json` document imported
 * as data, an `.mjs` module — under `src/main` and `src/shared`. Read as text. */
function dataFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...dataFiles(path));
    } else if (/\.(?:js|mjs|cjs|json)$/u.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** What a data or plain-JavaScript file may not hold: a GraphQL operation, an `event` key, or any
 * of the words. */
function dataViolations(text: string): string[] {
  return [
    ...forbiddenIn(text),
    ...(/\bmutation\b/iu.test(text) ? ["graphqlMutation"] : []),
    ...(/["']?\bevent["']?\s*:/iu.test(text) ? ["eventKey"] : []),
  ];
}

// --- 3. the three mutations, and exactly their inputs -------------------------------------

/** The top-level fields an operation asks for, aliases resolved — read by depth, so a second
 * field after the first cannot hide. */
function topLevelFields(document: string): { operation: string; fields: string[] } {
  const operation = /^\s*(\w+)/u.exec(document)?.[1] ?? "";
  const fields: string[] = [];
  let braces = 0;
  let parens = 0;
  for (let index = 0; index < document.length; index += 1) {
    const char = document[index] ?? "";
    if (char === "{") {
      braces += 1;
    } else if (char === "}") {
      braces -= 1;
    } else if (char === "(") {
      parens += 1;
    } else if (char === ")") {
      parens -= 1;
    } else if (braces === 1 && parens === 0 && /[A-Za-z_]/u.test(char)) {
      const word = /^[A-Za-z_]\w*/u.exec(document.slice(index))?.[0] ?? "";
      const after = document.slice(index + word.length).trimStart();
      if (!after.startsWith(":")) {
        fields.push(word);
      }
      index += word.length - 1;
    }
  }
  return { operation, fields };
}

/** The keys of a mutation's `input: { … }` object, top level only, or null with no input. */
function inputKeys(document: string): string[] | null {
  const start = /\binput\s*:\s*\{/u.exec(document);
  if (start === null) {
    return null;
  }
  let depth = 0;
  let key = "";
  const keys: string[] = [];
  let expectKey = true;
  for (let index = start.index + start[0].length - 1; index < document.length; index += 1) {
    const char = document[index] ?? "";
    if (char === '"') {
      // A string value — `path: "("` — is skipped whole, escapes included, so a bracket inside
      // it cannot shift the depth and hide the keys after it.
      for (index += 1; index < document.length && document[index] !== '"'; index += 1) {
        if (document[index] === "\\") {
          index += 1;
        }
      }
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      continue;
    }
    if (depth !== 1) {
      continue;
    }
    if (char === ",") {
      expectKey = true;
      key = "";
    } else if (char === ":" && expectKey) {
      keys.push(key.trim());
      expectKey = false;
    } else if (expectKey) {
      key += char;
    }
  }
  return keys;
}

/** What each allowed mutation's input may hold — exactly. */
const ALLOWED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  addPullRequestReview: ["pullRequestId", "commitOID"],
  addPullRequestReviewThread: [
    "pullRequestReviewId",
    "path",
    "line",
    "side",
    "startLine",
    "startSide",
    "body",
    "subjectType",
  ],
  deletePullRequestReviewComment: ["id"],
};
const ALLOWED_QUERY_FIELDS = new Set(["repository", "node", "nodes"]);

/** Why a document is not one of the allowed shapes, or nothing. */
function documentViolations(document: string): string[] {
  const { operation, fields } = topLevelFields(document);
  if (operation === "query") {
    return fields.filter((field) => !ALLOWED_QUERY_FIELDS.has(field)).map((f) => `query:${f}`);
  }
  if (operation !== "mutation") {
    return [`operation:${operation}`];
  }
  const [field, ...more] = fields;
  if (field === undefined || more.length > 0) {
    return [`fields:${fields.join(",")}`];
  }
  const allowed = ALLOWED_INPUTS[field];
  if (allowed === undefined) {
    return [`mutation:${field}`];
  }
  const keys = inputKeys(document) ?? [];
  const problems = keys.filter((key) => !allowed.includes(key)).map((key) => `input:${key}`);
  if (field === "addPullRequestReviewThread" && !keys.includes("pullRequestReviewId")) {
    problems.push("input:missing pullRequestReviewId");
  }
  if (field === "addPullRequestReview" && keys.toSorted().join() !== "commitOID,pullRequestId") {
    problems.push(`input:${keys.join(",")}`);
  }
  return [...new Set(problems)];
}

// --- the samples the earlier version let through ------------------------------------------

/** (A) A thread on the pull request rather than the pending review. */
const PLANT_A = GRAPHQL.ADD_PENDING_THREAD.replace("pullRequestReviewId:", "pullRequestId:");
/** (B) A body on the review itself. */
const PLANT_B = GRAPHQL.START_PENDING_REVIEW.replace(
  "commitOID: $commitOID",
  'commitOID: $commitOID, body: "LGTM"',
);
/** (C) A REST published review comment, in a new file under src/main/github. */
const PLANT_C = `import { apiPath, type GitHubClient } from "./client";
export function publish(client: GitHubClient, auth: never): unknown {
  return client.send({ path: apiPath("repos", "o", "r", "pulls", 1, "comments"), media: "json", auth, resource: "core", maxBytes: 1, json: { body: "hi", commit_id: "x", path: "a", line: 1 } } as never);
}`;
/** (D) An anonymous mutation posted by hand. */
const PLANT_D = `export function comment(client: { send: (call: unknown) => unknown }): unknown {
  return client.send({ path: "/graphql", json: { query: "mutation($id: ID!) { addComment(input: { subjectId: $id, body: \\"hi\\" }) { clientMutationId } }" } });
}`;
/** (E) An approval from outside src/main/github. */
const PLANT_E = `export async function approve(transport: (url: string, init: RequestInit) => Promise<Response>): Promise<void> {
  await transport("https://api.github.com/repos/o/r/pulls/1/reviews", { method: "POST", body: JSON.stringify({ event: "APPROVE" }) });
}`;

/** The second review's evasions (F–L), as the files that would carry them. */
const IN_GITHUB = join(GITHUB_DIR, "sample.ts");
const PLANT_F = `const doc = ("mut" + "ation($id: ID!) { addComment(input: { subjectId: $id }) { clientMutationId } }") as GraphqlDocument;
client.graphql(auth, doc, { id });`;
const PLANT_G =
  "const doc = `mut${w} { addComment(input: {}) { clientMutationId } }` as unknown as GraphqlDocument;";
const PLANT_H =
  "await globalThis.fetch(url, { method: m, headers: { Authorization: `Bearer ${auth.bearer()}` } });";
const PLANT_I_NET = `import { net as n } from "electron";
n.request({ url }).end();`;
const PLANT_I_HTTPS = `import https from "node:https";
https.request(url).end();`;
const PLANT_J = JSON.stringify({
  query: "mutation($id: ID!) { addComment(input: { subjectId: $id }) { x } }",
});
const PLANT_K = `export const q = "mut" + "ation { addComment(input: {}) { x } }"; // mutation via .mjs
export const body = { event: "APPROVE" };`;
const PLANT_L = GRAPHQL.ADD_PENDING_THREAD.replace(
  "path: $path,",
  'path: "(", pullRequestId: $reviewId,',
);

describe("never submit: the second review's evasions are caught", () => {
  it("(F) a concatenated document cast to GraphqlDocument", () => {
    expect(requestShapesIn(PLANT_F, IN_GITHUB)).toContain("launderedDocument");
    // …and at a .graphql( argument, wherever the file is.
    expect(requestShapesIn("client.graphql(auth, x as never, {});", "/elsewhere.ts")).toContain(
      "launderedDocument",
    );
  });

  it("(G) a templated document cast through unknown", () => {
    expect(requestShapesIn(PLANT_G, IN_GITHUB)).toContain("launderedDocument");
  });

  it("(H) globalThis.fetch signed with the token", () => {
    expect(requestShapesIn(PLANT_H)).toEqual(expect.arrayContaining(["bearerAccess", "fetchCall"]));
    expect(requestShapesIn("const { bearer } = auth;")).toEqual(["bearerAccess"]);
    expect(requestShapesIn('auth["bearer"]();')).toEqual(["bearerAccess"]);
  });

  it("(I) Electron's net under another name, and https", () => {
    expect(requestShapesIn(PLANT_I_NET)).toContain("electronNet");
    expect(requestShapesIn(PLANT_I_HTTPS)).toContain("networkModule");
    expect(requestShapesIn('const h = require("https");')).toContain("networkModule");
  });

  it("(J) a document kept in a .json file", () => {
    expect(dataViolations(PLANT_J)).toContain("graphqlMutation");
  });

  it("(K) an .mjs module", () => {
    expect(dataViolations(PLANT_K)).toEqual(
      expect.arrayContaining(["graphqlMutation", "eventKey", "eventValue"]),
    );
  });

  it("(L) a bracket in a string that would hide the keys after it", () => {
    expect(documentViolations(PLANT_L)).toContain("input:pullRequestId");
  });

  it("lets `satisfies` and the app's own reads through", () => {
    expect(requestShapesIn("const d = GRAPHQL.X satisfies GraphqlDocument;", IN_GITHUB)).toEqual(
      [],
    );
    expect(requestShapesIn("const x = y as string;", IN_GITHUB)).toEqual([]);
    expect(requestShapesIn("await net.fetch(url)")).toEqual(["netRequest"]);
  });
});

describe("never submit: the rules bite", () => {
  it("catches each way to submit a review by its words", () => {
    expect(forbiddenIn("mutation { submitPullRequestReview(input: { id: $id }) { x } }")).toContain(
      "submitMutation",
    );
    expect(
      forbiddenIn("addPullRequestReview(input: { pullRequestId: $id, event: APPROVE })"),
    ).toEqual(["eventValue"]);
    expect(forbiddenIn('client.send({ json: { "event": "x" } })')).toEqual(["eventField"]);
    expect(
      requestShapesIn(
        'const d = "addPullRequestReview(input: { pullRequestId: $id, event: $e })";',
      ),
    ).toEqual(["eventInString"]);
    expect(requestShapesIn("const body = { event : 'x' };")).toEqual(["eventKey"]);
    expect(requestShapesIn("const body = { event };")).toEqual(["eventKey"]);
    expect(forbiddenIn("const verdict = 'REQUEST_CHANGES';")).toEqual(["eventValue"]);
    expect(forbiddenIn("apiPath('repos', o, r, 'pulls', n, 'reviews', id) + '/events'")).toEqual([
      "eventsPath",
    ]);
  });

  it("lets the app's own words through", () => {
    for (const benign of [
      "IpcEvent.sessionsChanged",
      "signal.addEventListener('abort', stop)",
      "// carries no data: the event is a command",
      "PullRequestReviewComment { id state viewerDidAuthor }",
      "state: 'APPROVED'",
      "const prevent: boolean = true",
    ]) {
      expect(forbiddenIn(benign), benign).toEqual([]);
    }
    expect(
      requestShapesIn(
        "let json: unknown = JSON.parse(text); // a mutation, in prose\nfunction on(event: IpcEventName): void {}",
      ),
    ).toEqual([]);
  });

  it("reads every field an operation asks for, the second one too", () => {
    expect(
      topLevelFields(
        "mutation X($a: ID!) { addPullRequestReview(input: { pullRequestId: $a }) { pullRequestReview { id } } submitPullRequestReview(input: {}) { x } }",
      ),
    ).toEqual({
      operation: "mutation",
      fields: ["addPullRequestReview", "submitPullRequestReview"],
    });
    expect(topLevelFields("mutation { ok: mergePullRequest(input: {}) { x } }").fields).toEqual([
      "mergePullRequest",
    ]);
  });

  it("(A) refuses a thread on the pull request instead of the pending review", () => {
    expect(documentViolations(PLANT_A)).toEqual(
      expect.arrayContaining(["input:pullRequestId", "input:missing pullRequestReviewId"]),
    );
  });

  it("(B) refuses a body — or threads, comments, an event — on the review", () => {
    expect(documentViolations(PLANT_B)).toContain("input:body");
    for (const extra of ["threads: $t", "comments: $c", "event: $e"]) {
      const planted = GRAPHQL.START_PENDING_REVIEW.replace(
        "commitOID: $commitOID",
        `commitOID: $commitOID, ${extra}`,
      );
      expect(documentViolations(planted).length, extra).toBeGreaterThan(0);
    }
  });

  it("(C) refuses a REST write built anywhere but client.ts", () => {
    expect(requestShapesIn(PLANT_C)).toContain("jsonBody");
  });

  it("(D) refuses an anonymous mutation in any other file", () => {
    expect(requestShapesIn(PLANT_D)).toEqual(["graphqlMutation", "jsonBody"]);
    expect(requestShapesIn("const q = `mutation { addComment(input: {}) { x } }`;")).toEqual([
      "graphqlMutation",
    ]);
  });

  it("(E) refuses an approval from outside src/main/github", () => {
    expect(forbiddenIn(PLANT_E)).toEqual(["eventValue"]);
    expect(requestShapesIn(PLANT_E)).toEqual(["eventKey", "postMethod"]);
    // …and src/main/pull-request is scanned.
    expect(
      SCANNED.some((dir) => join(ROOT, "src/main/pull-request/approve.ts").startsWith(dir)),
    ).toBe(true);
  });

  it("tells a POST method from a sentence that starts with the word", () => {
    expect(requestShapesIn("const m = 'post';")).toEqual(["postMethod"]);
    expect(requestShapesIn("const reason = `post ${n} comments`;")).toEqual([]);
  });

  it("refuses the network reached around the client", () => {
    expect(requestShapesIn("await fetch('https://api.github.com/x')")).toEqual(["fetchCall"]);
    expect(requestShapesIn("net.request({ url })")).toEqual(["netRequest"]);
  });
});

describe("never submit: the source", () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(dir));

  it("names no way to submit anywhere under src/main, src/preload or src/shared", () => {
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((path) => {
      const rules = forbiddenIn(readFileSync(path, "utf8"));
      return rules.length === 0 ? [] : [`${relative(ROOT, path)}: ${rules.join(", ")}`];
    });
    expect(offenders).toEqual([]);
  });

  it("builds a request, reaches the network or holds a mutation only where allowed", () => {
    const offenders = files.flatMap((path) => {
      const allowed = allowedShapes(path);
      const shapes = requestShapesIn(readFileSync(path, "utf8"), path).filter(
        (shape) => !allowed.has(shape),
      );
      return shapes.length === 0 ? [] : [`${relative(ROOT, path)}: ${shapes.join(", ")}`];
    });
    expect(offenders).toEqual([]);
  });

  it("keeps GraphQL and events out of every .js, .mjs, .cjs and .json under src/main and src/shared", () => {
    const offenders = ["src/main", "src/shared"]
      .flatMap((dir) => dataFiles(join(ROOT, dir)))
      .flatMap((path) => {
        const rules = dataViolations(readFileSync(path, "utf8"));
        return rules.length === 0 ? [] : [`${relative(ROOT, path)}: ${rules.join(", ")}`];
      });
    expect(offenders).toEqual([]);
  });

  it("holds the three harmless mutations, each with exactly its inputs", () => {
    const documents = Object.values(GRAPHQL);
    const mutations = documents
      .filter((document) => topLevelFields(document).operation === "mutation")
      .flatMap((document) => topLevelFields(document).fields);
    expect(new Set(mutations)).toEqual(new Set(Object.keys(ALLOWED_INPUTS)));
    for (const document of documents) {
      expect(documentViolations(document), document.slice(0, 40)).toEqual([]);
    }
    // The file says "event" nowhere at all — not even the enum's name.
    expect(readFileSync(DOCUMENTS_FILE, "utf8")).not.toMatch(/event/iu);
  });
});
