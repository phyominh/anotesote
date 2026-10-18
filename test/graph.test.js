const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../pb_hooks/lib/graph.js");

const topics = [
  { id: "aaaaaaaaaaaaaa1", name: "Graphs", path: "dsa/graphs", parent: "root00000000000", order: 0, mastery: 0.5, reviewed: true },
  { id: "root00000000000", name: "DSA", path: "dsa", parent: "", order: 0, mastery: 0, reviewed: false },
  { id: "bfs000000000000", name: "BFS", path: "dsa/graphs/bfs", parent: "aaaaaaaaaaaaaa1", order: 1, mastery: 0.9, reviewed: true },
  { id: "sp0000000000000", name: "Shortest \"Path\" [x]", path: "dsa/graphs/shortest-path", parent: "aaaaaaaaaaaaaa1", order: 2, mastery: 0.2, reviewed: true },
];
const links = [
  { type: "prerequisite", from: "bfs000000000000", to: "sp0000000000000", label: "" },
  { type: "contrasts", from: "bfs000000000000", to: "missing00000000", label: "x" },
];

test("full mode: tree edges plus link edges inside the node set", () => {
  const out = g.buildGraph({ topics, links, mode: "full" });
  assert.equal(out.nodes.length, 4);
  assert.equal(out.nodes[0].id, "root00000000000");
  assert.equal(out.edges.filter((e) => e.type === "child").length, 3);
  assert.deepEqual(out.edges.filter((e) => e.type === "prerequisite").map((e) => e.to), ["sp0000000000000"]);
  assert.equal(out.truncated, false);
});

test("truncation is breadth-first from the root", () => {
  const out = g.buildGraph({ topics, links, mode: "full", maxNodes: 2 });
  assert.deepEqual(out.nodes.map((n) => n.id), ["root00000000000", "aaaaaaaaaaaaaa1"]);
  assert.equal(out.truncated, true);
  assert.equal(out.edges.some((e) => e.type === "prerequisite"), false);
});

test("flow mode keeps only linked nodes and link edges", () => {
  const out = g.buildGraph({ topics, links, mode: "flow" });
  assert.deepEqual(out.nodes.map((n) => n.id).sort(), ["bfs000000000000", "sp0000000000000"]);
  assert.deepEqual(out.edges.map((e) => e.type), ["prerequisite"]);
});

test("cards hang off their topic with contains edges", () => {
  const cards = [{ id: "card00000000001", topic: "bfs000000000000", front: "Queue-based traversal", mastery: 0, reviewed: false }];
  const out = g.buildGraph({ topics, cards, mode: "full" });
  assert.ok(out.edges.some((e) => e.type === "contains" && e.from === "bfs000000000000" && e.to === "card00000000001"));
  assert.equal(out.nodes.find((n) => n.id === "card00000000001").kind, "card");
});

test("mastery classes", () => {
  assert.equal(g.masteryClass({ reviewed: false, mastery: 0 }), "new");
  assert.equal(g.masteryClass({ reviewed: true, mastery: 0.39 }), "weak");
  assert.equal(g.masteryClass({ reviewed: true, mastery: 0.4 }), "ok");
  assert.equal(g.masteryClass({ reviewed: true, mastery: 0.74 }), "ok");
  assert.equal(g.masteryClass({ reviewed: true, mastery: 0.75 }), "strong");
});

test("flowchart: escaping, edge styles and class assignment", () => {
  const out = g.buildGraph({ topics, links, mode: "full" });
  const m = g.renderMermaid(out, "full");
  assert.ok(m.startsWith("flowchart LR\n"));
  assert.ok(m.includes("classDef weak"));
  assert.ok(m.includes('t_sp0000000000000["Shortest #quot;Path#quot; [x] (20%)"]'));
  assert.ok(m.includes('t_bfs000000000000 -->|"prerequisite"| t_sp0000000000000'));
  assert.ok(m.includes("t_root00000000000 --- t_aaaaaaaaaaaaaa1"));
  assert.ok(m.includes("class t_root00000000000 new"));
  assert.ok(m.includes("class t_sp0000000000000 weak"));
  assert.ok(m.includes("class t_bfs000000000000 strong"));
  assert.ok(/class t_aaaaaaaaaaaaaa1 ok/.test(m));
});

test("flowchart: undirected styles and labels", () => {
  const graph = {
    nodes: [
      { id: "a", kind: "card", label: "は", mastery: 0, reviewed: false },
      { id: "b", kind: "card", label: "が", mastery: 0, reviewed: false },
    ],
    edges: [
      { from: "a", to: "b", type: "related" },
      { from: "a", to: "b", type: "confused_with", label: "topic vs <subject>" },
    ],
  };
  const m = g.renderMermaid(graph, "flow");
  assert.ok(m.includes("c_a -.- c_b"));
  assert.ok(m.includes('c_a -.-|"topic vs #lt;subject#gt;"| c_b'));
});

test("Japanese text survives in both renderers", () => {
  const jp = [
    { id: "j1", name: "文法", path: "文法", parent: "", mastery: 0.62, reviewed: true },
    { id: "j2", name: "助詞「は」と\"が\"", path: "文法/助詞", parent: "j1", mastery: 0, reviewed: false },
  ];
  const out = g.buildGraph({ topics: jp, mode: "mindmap" });
  const mm = g.renderMermaid(out, "mindmap", "japanese");
  assert.ok(mm.startsWith("mindmap\n"));
  assert.ok(mm.includes('root(("文法 (62%)"))'));
  assert.ok(mm.includes("t_j2[\"助詞「は」と'が'\"]"));
  const fc = g.renderMermaid(g.buildGraph({ topics: jp, mode: "full" }), "full");
  assert.ok(fc.includes('t_j2["助詞「は」と#quot;が#quot;"]'));
});

test("mindmap with several roots gets a synthetic project root", () => {
  const out = g.buildGraph({
    topics: [
      { id: "x", name: "A", path: "a", parent: "" },
      { id: "y", name: "B", path: "b", parent: "" },
    ],
    mode: "mindmap",
  });
  const mm = g.renderMermaid(out, "mindmap", "dsa");
  assert.equal(mm, 'mindmap\n  root(("dsa"))\n    t_x["A"]\n    t_y["B"]');
});
