// Graph assembly and Mermaid rendering (HANDOVER §8.3 get_graph). Pure and
// goja-compatible: the caller fetches records and passes plain objects.

var DIRECTED = { prerequisite: true, leads_to: true, example_of: true, part_of: true };

function byOrderThenPath(a, b) {
  var oa = Number(a.order) || 0;
  var ob = Number(b.order) || 0;
  if (oa !== ob) return oa - ob;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// opts: {
//   topics: [{id, name, path, parent, order, mastery, reviewed, due_count}],
//   cards:  [{id, topic, front, mastery, reviewed}],      // only when include_cards
//   links:  [{type, label, from, to}],                    // from/to are topic or card ids
//   mode: "mindmap" | "flow" | "full", maxNodes
// }
// Returns {nodes, edges, truncated, stats}.
function buildGraph(opts) {
  var mode = opts.mode || "full";
  var maxNodes = opts.maxNodes || 150;
  var topics = (opts.topics || []).slice().sort(byOrderThenPath);
  var cards = opts.cards || [];
  var topicIds = {};
  topics.forEach(function (t) { topicIds[t.id] = t; });

  var childTopics = {};
  var roots = [];
  topics.forEach(function (t) {
    if (t.parent && topicIds[t.parent]) (childTopics[t.parent] = childTopics[t.parent] || []).push(t);
    else roots.push(t);
  });
  var cardsByTopic = {};
  cards.forEach(function (c) {
    if (topicIds[c.topic]) (cardsByTopic[c.topic] = cardsByTopic[c.topic] || []).push(c);
  });

  // Breadth-first from the roots; cut at maxNodes.
  var nodes = [];
  var included = {};
  var treeEdges = [];
  var queue = roots.map(function (t) { return { kind: "topic", item: t, parent: null }; });
  var truncated = false;
  var total = topics.length + cards.length;
  while (queue.length) {
    var q = queue.shift();
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }
    var it = q.item;
    if (q.kind === "topic") {
      nodes.push({
        id: it.id, kind: "topic", label: it.name, path: it.path,
        mastery: Number(it.mastery) || 0, reviewed: !!it.reviewed, due_count: Number(it.due_count) || 0,
      });
      (childTopics[it.id] || []).forEach(function (c) { queue.push({ kind: "topic", item: c, parent: it.id }); });
      (cardsByTopic[it.id] || []).forEach(function (c) { queue.push({ kind: "card", item: c, parent: it.id }); });
    } else {
      nodes.push({
        id: it.id, kind: "card", label: it.front, path: topicIds[it.topic].path,
        mastery: Number(it.mastery) || 0, reviewed: !!it.reviewed,
      });
    }
    included[it.id] = true;
    if (q.parent) treeEdges.push({ from: q.parent, to: it.id, type: q.kind === "topic" ? "child" : "contains" });
  }
  if (nodes.length < total) truncated = true;

  var linkEdges = [];
  (opts.links || []).forEach(function (l) {
    if (included[l.from] && included[l.to]) {
      var e = { from: l.from, to: l.to, type: l.type };
      if (l.label) e.label = l.label;
      linkEdges.push(e);
    }
  });

  var edges;
  if (mode === "mindmap") {
    edges = treeEdges;
  } else if (mode === "flow") {
    edges = linkEdges;
    var linked = {};
    linkEdges.forEach(function (e) { linked[e.from] = true; linked[e.to] = true; });
    nodes = nodes.filter(function (n) { return linked[n.id]; });
  } else {
    edges = treeEdges.concat(linkEdges);
  }

  return {
    nodes: nodes,
    edges: edges,
    truncated: truncated,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      topics: nodes.filter(function (n) { return n.kind === "topic"; }).length,
      cards: nodes.filter(function (n) { return n.kind === "card"; }).length,
      links: linkEdges.length,
      available_nodes: total,
    },
  };
}

function masteryClass(n) {
  if (!n.reviewed) return "new";
  if (n.mastery < 0.4) return "weak";
  if (n.mastery < 0.75) return "ok";
  return "strong";
}

function nodeLabel(n) {
  var text = n.label === undefined || n.label === null ? "" : String(n.label);
  text = text.replace(/\s+/g, " ").trim();
  if (n.kind === "card" && text.length > 60) text = text.slice(0, 57) + "...";
  if (n.reviewed) text += " (" + Math.round(n.mastery * 100) + "%)";
  return text;
}

// Text inside a flowchart "quoted" label or edge label.
function escFlow(s) {
  return String(s)
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\|/g, "#124;");
}

// Text inside a mindmap ["quoted"] node: the mindmap parser ends a quoted
// string at the next double quote and has no entity escapes, so swap it out.
function escMindmap(s) {
  return String(s).replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

function mermaidId(n) {
  return (n.kind === "card" ? "c_" : "t_") + String(n.id).replace(/[^A-Za-z0-9_]/g, "_");
}

var CLASS_DEFS = [
  "  classDef weak fill:#fde2e1,stroke:#c0392b,color:#1a1a1a",
  "  classDef ok fill:#fff3cd,stroke:#b7950b,color:#1a1a1a",
  "  classDef strong fill:#d4efdf,stroke:#1e8449,color:#1a1a1a",
  "  classDef new fill:#eeeeee,stroke:#888888,color:#1a1a1a,stroke-dasharray:4 3",
];

function renderFlowchart(graph) {
  var lines = ["flowchart LR"];
  var ids = {};
  graph.nodes.forEach(function (n) {
    ids[n.id] = mermaidId(n);
    lines.push("  " + ids[n.id] + "[\"" + escFlow(nodeLabel(n)) + "\"]");
  });
  graph.edges.forEach(function (e) {
    var a = ids[e.from];
    var b = ids[e.to];
    if (!a || !b) return;
    var label = e.label || e.type;
    if (e.type === "child" || e.type === "contains") {
      lines.push("  " + a + " --- " + b);
    } else if (e.type === "prerequisite" || e.type === "leads_to") {
      lines.push("  " + a + " -->|\"" + escFlow(label) + "\"| " + b);
    } else if (e.type === "related") {
      lines.push("  " + a + (e.label ? " -.-|\"" + escFlow(e.label) + "\"| " : " -.- ") + b);
    } else if (e.type === "contrasts" || e.type === "confused_with") {
      lines.push("  " + a + " -.-|\"" + escFlow(label) + "\"| " + b);
    } else {
      // example_of, part_of and any future directed type
      lines.push("  " + a + " -->|\"" + escFlow(label) + "\"| " + b);
    }
  });
  var groups = { weak: [], ok: [], strong: [], new: [] };
  graph.nodes.forEach(function (n) { groups[masteryClass(n)].push(ids[n.id]); });
  lines = lines.concat(CLASS_DEFS);
  Object.keys(groups).forEach(function (k) {
    if (groups[k].length) lines.push("  class " + groups[k].join(",") + " " + k);
  });
  return lines.join("\n");
}

// Mindmap needs a single root: use the lone root topic, or a synthetic root
// titled `title` (the project name).
function renderMindmap(graph, title) {
  var children = {};
  var hasParent = {};
  graph.edges.forEach(function (e) {
    if (e.type !== "child" && e.type !== "contains") return;
    (children[e.from] = children[e.from] || []).push(e.to);
    hasParent[e.to] = true;
  });
  var byId = {};
  graph.nodes.forEach(function (n) { byId[n.id] = n; });
  var roots = graph.nodes.filter(function (n) { return !hasParent[n.id]; });

  var lines = ["mindmap"];
  function walk(n, depth) {
    var pad = new Array(depth + 1).join("  ");
    lines.push(pad + mermaidId(n) + "[\"" + escMindmap(nodeLabel(n)) + "\"]");
    (children[n.id] || []).forEach(function (cid) {
      if (byId[cid]) walk(byId[cid], depth + 1);
    });
  }
  if (roots.length === 1) {
    var r = roots[0];
    lines.push("  root((\"" + escMindmap(nodeLabel(r)) + "\"))");
    (children[r.id] || []).forEach(function (cid) {
      if (byId[cid]) walk(byId[cid], 2);
    });
  } else {
    lines.push("  root((\"" + escMindmap(title || "topics") + "\"))");
    roots.forEach(function (n) { walk(n, 2); });
  }
  return lines.join("\n");
}

function renderMermaid(graph, mode, title) {
  return mode === "mindmap" ? renderMindmap(graph, title) : renderFlowchart(graph);
}

module.exports = {
  buildGraph: buildGraph,
  renderMermaid: renderMermaid,
  masteryClass: masteryClass,
  escFlow: escFlow,
  escMindmap: escMindmap,
  DIRECTED: DIRECTED,
};
