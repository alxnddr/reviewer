import { describe, expect, it } from "vitest";
import {
  layoutFlow,
  rankFlow,
  type FlowLayout,
  type FlowLayoutInput,
  type FlowLayoutOptions,
} from "./flow-layout";

// Round numbers so every coordinate below can be checked by hand: a box is `20 + 10 × label
// length` wide and 30 tall, the stub past a column is 20, and the least column gap is 40.
const OPTIONS: Partial<FlowLayoutOptions> = {
  charWidth: 10,
  labelCharWidth: 10,
  paddingX: 10,
  boxHeight: 30,
  rankGap: 40,
  nodeGap: 10,
  rowGap: 40,
  margin: 20,
  labelPadding: 5,
  maxWidth: 1000,
};

function flow(labels: string[], edges: FlowLayoutInput["edges"]): FlowLayoutInput {
  return { nodes: labels.map((label) => ({ id: label, label })), edges };
}

function box(layout: FlowLayout, id: string) {
  const found = layout.boxes.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no box ${id}`);
  }
  return found;
}

/** Every route leaves its source's outgoing side (right, or bottom top to bottom) at its middle,
 * enters its target's incoming side (left, or top) at its middle, turns only at right angles, and
 * never repeats a point. */
function expectWellRouted(layout: FlowLayout): void {
  const lr = layout.orientation === "lr";
  for (const route of layout.routes) {
    const source = box(layout, route.from);
    const target = box(layout, route.to);
    expect(route.points[0]).toEqual(
      lr
        ? { x: source.x + source.width, y: source.y + source.height / 2 }
        : { x: source.x + source.width / 2, y: source.y + source.height },
    );
    expect(route.points.at(-1)).toEqual(
      lr
        ? { x: target.x, y: target.y + target.height / 2 }
        : { x: target.x + target.width / 2, y: target.y },
    );
    for (const [index, point] of route.points.slice(1).entries()) {
      const previous = route.points[index]!;
      expect(point.x === previous.x || point.y === previous.y).toBe(true);
      expect(point).not.toEqual(previous);
    }
  }
}

type Rect = { left: number; right: number; top: number; bottom: number };

const rectOf = (current: FlowLayout["boxes"][number]): Rect => ({
  left: current.x,
  right: current.x + current.width,
  top: current.y,
  bottom: current.y + current.height,
});

function overlaps(one: Rect, two: Rect): boolean {
  return (
    Math.min(one.right, two.right) > Math.max(one.left, two.left) &&
    Math.min(one.bottom, two.bottom) > Math.max(one.top, two.top)
  );
}

/** What "reads cleanly" means, checked: no line runs through a box (ports sit on a box's edge,
 * so touching one is allowed), and no label overlaps a box or another label. */
function expectClear(layout: FlowLayout, labelCharWidth: number, labelHeight: number): void {
  const boxes = layout.boxes.map(rectOf);
  for (const route of layout.routes) {
    for (const [index, point] of route.points.slice(1).entries()) {
      const previous = route.points[index]!;
      const segment: Rect = {
        left: Math.min(point.x, previous.x),
        right: Math.max(point.x, previous.x),
        top: Math.min(point.y, previous.y),
        bottom: Math.max(point.y, previous.y),
      };
      for (const [at, rect] of boxes.entries()) {
        const through =
          segment.top === segment.bottom
            ? segment.top > rect.top &&
              segment.top < rect.bottom &&
              Math.min(segment.right, rect.right) > Math.max(segment.left, rect.left)
            : segment.left > rect.left &&
              segment.left < rect.right &&
              Math.min(segment.bottom, rect.bottom) > Math.max(segment.top, rect.top);
        expect(through, `${route.from}->${route.to} through ${layout.boxes[at]!.id}`).toBe(false);
      }
    }
  }
  const labels = layout.routes.flatMap((route): { name: string; rect: Rect }[] => {
    if (route.label === null) {
      return [];
    }
    const half = (route.label.text.length * labelCharWidth) / 2;
    return [
      {
        name: route.label.text,
        rect: {
          left: route.label.x - half,
          right: route.label.x + half,
          top: route.label.y - labelHeight,
          bottom: route.label.y,
        },
      },
    ];
  });
  for (const [index, label] of labels.entries()) {
    for (const [at, rect] of boxes.entries()) {
      expect(overlaps(label.rect, rect), `${label.name} on ${layout.boxes[at]!.id}`).toBe(false);
    }
    for (const other of labels.slice(index + 1)) {
      expect(overlaps(label.rect, other.rect), `${label.name} on ${other.name}`).toBe(false);
    }
  }
}

/** The real sample's flow — `editor:open` growing a `repo` arm — at the guide's metrics: two
 * callers into one store, then a chain that fans out twice. The flow that drew crossed lines,
 * a box run through and a label on a line before the layout was rebuilt. */
const SAMPLE: FlowLayoutInput = {
  nodes: [
    { id: "menu", label: "File ▸ Open Repository in Editor", extraWidth: 46 },
    { id: "hook", label: "useOpenRepoInEditorCommand()", extraWidth: 46 },
    { id: "button", label: "OpenRepoInEditorButton", extraWidth: 46 },
    { id: "store", label: "useEditorStore.open()", extraWidth: 14 },
    { id: "request", label: "EditorOpenRequest", extraWidth: 46 },
    { id: "open", label: "openInEditor()", extraWidth: 46 },
    { id: "locate", label: "locate()", extraWidth: 46 },
    { id: "file", label: "checkEditorFile()", extraWidth: 14 },
    { id: "root", label: "checkEditorRoot()", extraWidth: 46 },
    { id: "shell", label: "shell.openExternal()", extraWidth: 14 },
  ],
  edges: [
    { from: "menu", to: "hook", label: "menu event" },
    { from: "hook", to: "store", label: "repo" },
    { from: "button", to: "store", label: "repo" },
    { from: "store", to: "request", label: "editor:open" },
    { from: "request", to: "open" },
    { from: "open", to: "locate" },
    { from: "locate", to: "file", label: "file" },
    { from: "locate", to: "root", label: "repo" },
    { from: "open", to: "shell", label: "editor URL" },
  ],
};

/** `flowOptions(false, width)` in `lib/guide.ts`, restated so this file does not import it. */
const GUIDE: Partial<FlowLayoutOptions> = {
  charWidth: 7.8,
  labelCharWidth: 6.6,
  labelHeight: 13,
  boxHeight: 32,
  margin: 12,
  rankGap: 36,
  nodeGap: 14,
  rowGap: 40,
};

describe("layoutFlow", () => {
  it("lays a chain out left to right on one line, joined by straight arrows", () => {
    const layout = layoutFlow(
      flow(
        ["aa", "bbb", "c"],
        [
          { from: "aa", to: "bbb" },
          { from: "bbb", to: "c" },
        ],
      ),
      OPTIONS,
    );
    expect(
      layout.boxes.map((current) => [current.id, current.x, current.y, current.width]),
    ).toEqual([
      ["aa", 20, 20, 40],
      ["bbb", 100, 20, 50],
      ["c", 190, 20, 30],
    ]);
    expect(layout.routes.map((route) => [route.kind, route.points])).toEqual([
      [
        "adjacent",
        [
          { x: 60, y: 35 },
          { x: 100, y: 35 },
        ],
      ],
      [
        "adjacent",
        [
          { x: 150, y: 35 },
          { x: 190, y: 35 },
        ],
      ],
    ]);
    expect(layout).toMatchObject({ orientation: "lr", width: 240, height: 70 });
    expectWellRouted(layout);
  });

  it("stacks a fan-out in one column, bends the second branch, and widens the gap for labels", () => {
    // Capy's `useShareSend() → sendMessage | native.upload()`, labelled `thread` and `files`.
    const layout = layoutFlow(
      {
        nodes: [
          { id: "send", label: "useShareSend()" },
          { id: "message", label: "sendMessage" },
          { id: "upload", label: "native.upload()" },
        ],
        edges: [
          { from: "send", to: "message", label: "thread" },
          { from: "send", to: "upload", label: "files" },
        ],
      },
      OPTIONS,
    );
    // Gap: stub 20 + "thread" 60 + padding 2 × 5 = 90.
    expect(box(layout, "message")).toMatchObject({ x: 270, y: 20, rank: 1, order: 0 });
    expect(box(layout, "upload")).toMatchObject({ x: 270, y: 60, rank: 1, order: 1 });
    expect(layout.routes).toEqual([
      {
        from: "send",
        to: "message",
        kind: "adjacent",
        points: [
          { x: 180, y: 35 },
          { x: 270, y: 35 },
        ],
        // Set against the target: 270 − padding 5 − half of "thread"'s 60.
        label: { text: "thread", x: 235, y: 35 },
      },
      {
        from: "send",
        to: "upload",
        kind: "adjacent",
        points: [
          { x: 180, y: 35 },
          { x: 200, y: 35 },
          { x: 200, y: 75 },
          { x: 270, y: 75 },
        ],
        label: { text: "files", x: 240, y: 75 },
      },
    ]);
    expectWellRouted(layout);
  });

  it("breaks a cycle at the edge that closes it, in input order, and routes it back under the row", () => {
    const input = flow(
      ["a", "b", "c"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    );
    expect(rankFlow(input)).toEqual({
      ranks: new Map([
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ]),
      backEdges: [{ from: "c", to: "a" }],
    });
    const layout = layoutFlow(input, OPTIONS);
    const back = layout.routes[2]!;
    expect(back.kind).toBe("back");
    // Down to the lane a quarter of the row gap under the row (20 + 30 + 10), back left, and in.
    expect(back.points.map((point) => point.y)).toEqual([35, 35, 60, 60, 35, 35]);
    expect(back.points[3]?.x).toBe(box(layout, "a").x - 20);
    expectWellRouted(layout);
  });

  it("wraps a chain wider than the limit onto further rows, with a connector between them", () => {
    const labels = ["node0", "node1", "node2", "node3", "node4"];
    const layout = layoutFlow(
      flow(
        labels,
        labels.slice(1).map((label, index) => ({ from: labels[index]!, to: label })),
      ),
      { ...OPTIONS, maxWidth: 300 },
    );
    expect(layout.boxes.map((current) => [current.row, current.x, current.y])).toEqual([
      [0, 20, 20],
      [0, 130, 20],
      [1, 20, 90],
      [1, 130, 90],
      [2, 20, 160],
    ]);
    for (const current of layout.boxes) {
      expect(current.x + current.width + 20).toBeLessThanOrEqual(300);
    }
    const wrap = layout.routes[1]!;
    expect(wrap).toMatchObject({ from: "node1", to: "node2", kind: "wrap" });
    // Out past node1, down to halfway through the row gap, back to the left margin, down, in.
    expect(wrap.points).toEqual([
      { x: 200, y: 35 },
      { x: 220, y: 35 },
      { x: 220, y: 70 },
      { x: 0, y: 70 },
      { x: 0, y: 105 },
      { x: 20, y: 105 },
    ]);
    expect(layout.routes.map((route) => route.kind)).toEqual([
      "adjacent",
      "wrap",
      "adjacent",
      "wrap",
    ]);
    expect(layout.width).toBeLessThanOrEqual(300);
    expectWellRouted(layout);
  });

  it("gives an edge that skips a rank its own slot in it, never running through a box", () => {
    const layout = layoutFlow(
      flow(
        ["a", "b", "c"],
        [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "a", to: "c", label: "x" },
        ],
      ),
      OPTIONS,
    );
    const long = layout.routes[2]!;
    expect(long.kind).toBe("long");
    // The dummy's slot sits under `b` (20 + 30 + gap 10, centred in its 8 px): the edge fans
    // out of `a` with `a → b`, passes under `b` at 64, and merges into `c`'s fan-in.
    expect(long.points).toEqual([
      { x: 50, y: 35 },
      { x: 70, y: 35 },
      { x: 70, y: 64 },
      { x: 140, y: 64 },
      { x: 140, y: 35 },
      { x: 160, y: 35 },
    ]);
    // A fan-in's label rides its own branch, set against the source side (`b` ends at 120).
    expect(long.label).toEqual({ text: "x", x: 130, y: 64 });
    expectWellRouted(layout);
    expectClear(layout, 10, 10);
  });

  it("orders a column toward its neighbours, uncrossing an awkwardly authored fan", () => {
    const layout = layoutFlow(
      flow(
        ["a", "b", "c", "d"],
        [
          { from: "a", to: "d" },
          { from: "b", to: "c" },
        ],
      ),
      OPTIONS,
    );
    expect(box(layout, "d").order).toBe(0);
    expect(box(layout, "c").order).toBe(1);
    expectWellRouted(layout);
  });

  it("lays out nothing as an empty margin, and one node as one box with no route", () => {
    // The Deps tab and an authored flow are never handed fewer than two nodes today; the layout
    // must still answer finitely if one is, rather than divide by an empty rank.
    const empty = layoutFlow({ nodes: [], edges: [] }, OPTIONS);
    expect([empty.width, empty.height, empty.boxes, empty.routes]).toEqual([20, 20, [], []]);
    const one = layoutFlow(flow(["a"], []), OPTIONS);
    expect(one.boxes.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [20, 20, 30, 30],
    ]);
    expect([one.width, one.height, one.routes]).toEqual([70, 70, []]);
  });

  it("ignores an edge to an unknown node, a self-loop, and a repeated id", () => {
    const layout = layoutFlow(
      {
        nodes: [
          { id: "a", label: "a" },
          { id: "b", label: "b" },
          { id: "a", label: "again" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "ghost" },
          { from: "b", to: "b" },
        ],
      },
      OPTIONS,
    );
    expect(layout.boxes.map((current) => current.label)).toEqual(["a", "b"]);
    expect(layout.routes.map((route) => `${route.from}->${route.to}`)).toEqual(["a->b"]);
  });

  it("is deterministic, and counts a box's extra width", () => {
    const input: FlowLayoutInput = {
      nodes: [
        { id: "a", label: "load()", extraWidth: 24 },
        { id: "b", label: "fetch()" },
        { id: "c", label: "cache" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "c", to: "a" },
      ],
    };
    expect(layoutFlow(input, OPTIONS)).toEqual(layoutFlow(input, OPTIONS));
    expect(box(layoutFlow(input, OPTIONS), "a").width).toBe(20 + 60 + 24);
    expect(layoutFlow({ nodes: [], edges: [] }, OPTIONS)).toEqual({
      orientation: "lr",
      width: 20,
      height: 20,
      boxes: [],
      routes: [],
    });
  });
  it("pulls a second caller forward beside the first, rather than leaving it at rank 0", () => {
    const { ranks } = rankFlow(SAMPLE);
    expect(ranks.get("hook")).toBe(1);
    expect(ranks.get("button")).toBe(1);
    expect(ranks.get("store")).toBe(2);
  });

  it("merges a fan-in into one trunk and labels each branch on its own stretch", () => {
    const layout = layoutFlow(
      flow(
        ["aa", "bb", "c"],
        [
          { from: "aa", to: "c", label: "one" },
          { from: "bb", to: "c", label: "two" },
        ],
      ),
      OPTIONS,
    );
    const [first, second] = layout.routes;
    // `aa` is level with `c`, so its branch is straight; `bb`'s turns a stub before `c` and
    // joins it, arriving on the same line.
    expect(first!.points).toEqual([
      { x: 60, y: 35 },
      { x: 120, y: 35 },
    ]);
    expect(second!.points).toEqual([
      { x: 60, y: 75 },
      { x: 100, y: 75 },
      { x: 100, y: 35 },
      { x: 120, y: 35 },
    ]);
    // Each label sits on its source's segment, before the merge, at its source's height.
    expect(first!.label?.y).toBe(box(layout, "aa").y + 15);
    expect(second!.label?.y).toBe(box(layout, "bb").y + 15);
    expectWellRouted(layout);
    expectClear(layout, 10, 10);
  });

  it("lays the real sample out on two rows joined by one connector at the guide's width", () => {
    const layout = layoutFlow(SAMPLE, { ...GUIDE, maxWidth: 1040 });
    expect(layout.orientation).toBe("lr");
    expect(new Set(layout.boxes.map((current) => current.row))).toEqual(new Set([0, 1]));
    expect(layout.routes.filter((route) => route.kind === "wrap")).toHaveLength(1);
    expect(layout.routes.find((route) => route.kind === "wrap")).toMatchObject({
      from: "store",
      to: "request",
    });
    expect(layout.width).toBeLessThanOrEqual(1040);
    expectWellRouted(layout);
    expectClear(layout, 6.6, 13);
  });

  it("turns a branching flow that would wrap more than once top to bottom when that fits", () => {
    const layout = layoutFlow(SAMPLE, { ...GUIDE, maxWidth: 700 });
    expect(layout.orientation).toBe("tb");
    expect(layout.width).toBeLessThanOrEqual(700);
    // Ranks are rows: everything a rank lower sits lower.
    const y = (id: string): number => box(layout, id).y;
    expect(y("menu")).toBeLessThan(y("hook"));
    expect(y("hook")).toBe(y("button"));
    expect(y("locate")).toBeLessThan(y("root"));
    expectWellRouted(layout);
    expectClear(layout, 6.6, 13);
  });

  it("keeps a branching flow wrapping when top to bottom would not fit either", () => {
    const layout = layoutFlow(SAMPLE, { ...GUIDE, maxWidth: 520 });
    expect(layout.orientation).toBe("lr");
    expectWellRouted(layout);
    // Two callers merge across a wrap into one store: one `repo`, not two on one line.
    const intoStore = layout.routes.filter((route) => route.to === "store");
    expect(intoStore.map((route) => route.kind)).toEqual(["wrap", "wrap"]);
    expect(intoStore.filter((route) => route.label !== null)).toHaveLength(1);
    expectClear(layout, 6.6, 13);
  });

  it("wraps a chain, however long, rather than standing it on end", () => {
    const labels = ["node0", "node1", "node2", "node3", "node4"];
    const layout = layoutFlow(
      flow(
        labels,
        labels.slice(1).map((label, index) => ({ from: labels[index]!, to: label })),
      ),
      { ...OPTIONS, maxWidth: 200 },
    );
    expect(layout.orientation).toBe("lr");
    expect(Math.max(...layout.boxes.map((current) => current.row))).toBe(4);
  });

  it("chooses the cheapest boundary to wrap at, not just the one where the row ran out", () => {
    // a → b → {c, d} → e: breaking after b carries one edge, after {c, d} two.
    const layout = layoutFlow(
      flow(
        ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"],
        [
          { from: "aaaaaaaa", to: "bbbbbbbb" },
          { from: "bbbbbbbb", to: "cccccccc" },
          { from: "bbbbbbbb", to: "dddddddd" },
          { from: "cccccccc", to: "eeeeeeee" },
          { from: "dddddddd", to: "eeeeeeee" },
        ],
      ),
      { ...OPTIONS, orientation: "lr", maxWidth: 400 },
    );
    expect(layout.boxes.map((current) => current.row)).toEqual([0, 0, 1, 1, 1]);
    expect(layout.routes.filter((route) => route.kind === "wrap")).toHaveLength(2);
    expectWellRouted(layout);
    expectClear(layout, 10, 10);
  });

  it("routes top to bottom on request: out of the bottom, into the top, labels beside the line", () => {
    const layout = layoutFlow(
      flow(
        ["send", "message", "upload"],
        [
          { from: "send", to: "message", label: "thread" },
          { from: "send", to: "upload", label: "files" },
        ],
      ),
      { ...OPTIONS, orientation: "tb" },
    );
    expect(layout.orientation).toBe("tb");
    expect(box(layout, "message").y).toBe(box(layout, "upload").y);
    const thread = layout.routes[0]!;
    const into = thread.points.at(-1)!;
    // Right of the line that enters `message`, its bottom just above the box.
    expect(thread.label!.x).toBeGreaterThan(into.x);
    expect(thread.label!.y).toBeLessThanOrEqual(into.y);
    expectWellRouted(layout);
    expectClear(layout, 10, 10);
  });
});
