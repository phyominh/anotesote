// MCP tool definitions and handlers (HANDOVER §8.3).

var util = require(__hooks + "/lib/util.js");
var topics = require(__hooks + "/lib/topics.js");
var srs = require(__hooks + "/lib/srs.js");
var mastery = require(__hooks + "/lib/mastery.js");
var graph = require(__hooks + "/lib/graph.js");

var fail = util.fail;
var DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Definitions. Enums are read from the schema on every call.

function definitions(app) {
  var P = { type: "string", enum: util.projects(app), description: "Study project." };
  var LT = util.linkTypes(app);
  var topicPath = { type: "string", maxLength: 500, description: "Topic path like \"grammar/particles\" (segments are slugified)." };
  var topicId = { type: "string", description: "Topic record id (alternative to topic_path)." };
  var tags = { type: "array", maxItems: 50, items: { type: "string", maxLength: 100 } };
  var meta = { type: "object", description: "Free-form JSON for skills (readings, audio refs, difficulty, source)." };

  return [
    {
      name: "upsert_topic",
      description: "Create a topic path (with missing ancestors), update its description/order, move or rename it with new_path, or delete it if empty.",
      inputSchema: obj({
        project: P,
        path: topicPath,
        description: { type: "string", maxLength: 2000 },
        order: { type: "number" },
        new_path: { type: "string", maxLength: 500, description: "Move/rename target; descendants follow." },
        delete: { type: "boolean", description: "Delete the topic; fails unless it has no cards and no child topics." },
      }, ["project", "path"]),
    },
    {
      name: "list_topics",
      description: "List topics as a flat list with mastery, rolled-up mastery, card and due counts; sort mastery_asc to find weak topics.",
      inputSchema: obj({
        project: P,
        root_path: topicPath,
        depth: { type: "integer", minimum: 0, maximum: 50, description: "Levels below root_path (or below the top level) to include. Default unlimited." },
        sort: { type: "string", enum: ["path", "mastery_asc", "last_reviewed_asc"] },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      }, ["project"]),
    },
    {
      name: "save_cards",
      description: "Save 1-50 atomic cards (one retrievable idea per card; split long notes and connect them with link). Search first; duplicates by front fail - use update_card.",
      inputSchema: obj({
        project: P,
        topic_path: topicPath,
        topic_id: topicId,
        cards: {
          type: "array", minItems: 1, maxItems: 50,
          items: obj({
            front: { type: "string", minLength: 1, maxLength: 500, description: "Prompt side: word, question, concept name." },
            back: { type: "string", minLength: 1, maxLength: 10000, description: "Answer/explanation (Markdown)." },
            kind: { type: "string", minLength: 1, maxLength: 50, description: "vocab, phrase, grammar, concept, formula, pattern, mistake, problem, example, ..." },
            extra: { type: "string", maxLength: 10000, description: "Examples, mnemonics, context." },
            tags: tags,
            meta: meta,
            topic_path: topicPath,
            topic_id: topicId,
          }, ["front", "back", "kind"]),
        },
      }, ["project", "cards"]),
    },
    {
      name: "search_cards",
      description: "Search cards by text, topic (with subtopics), kind, tag or max mastery; returns compact cards with back truncated to 300 chars.",
      inputSchema: obj({
        project: P,
        topic_path: topicPath,
        topic_id: topicId,
        include_subtopics: { type: "boolean" },
        kind: { type: "string", maxLength: 50 },
        tag: { type: "string", maxLength: 100 },
        query: { type: "string", maxLength: 500, description: "Substring match on front, back and extra." },
        max_mastery: { type: "number", minimum: 0, maximum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        sort: { type: "string", enum: ["-updated", "mastery", "due", "-created"] },
      }, []),
    },
    {
      name: "get_cards",
      description: "Get full cards by id, including SRS state, topic path and the last 5 reviews of each.",
      inputSchema: obj({
        ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      }, ["ids"]),
    },
    {
      name: "update_card",
      description: "Edit a card's content, tags, topic or suspension (meta is shallow-merged; null deletes a key), reset its progress, or delete it.",
      inputSchema: obj({
        id: { type: "string" },
        front: { type: "string", minLength: 1, maxLength: 500 },
        back: { type: "string", minLength: 1, maxLength: 10000 },
        extra: { type: "string", maxLength: 10000 },
        kind: { type: "string", minLength: 1, maxLength: 50 },
        tags: tags,
        suspended: { type: "boolean" },
        topic_path: topicPath,
        topic_id: topicId,
        meta: meta,
        reset_progress: { type: "boolean", description: "Reset SRS state and mastery to defaults." },
        delete: { type: "boolean", description: "Delete the card with its reviews and links." },
      }, ["id"]),
    },
    {
      name: "get_due_cards",
      description: "Get cards due for review (oldest due first, weakest first) plus up to new_limit never-reviewed cards, for flashcard sessions.",
      inputSchema: obj({
        project: P,
        topic_path: topicPath,
        limit: { type: "integer", minimum: 1, maximum: 100 },
        new_limit: { type: "integer", minimum: 0, maximum: 100 },
        kind: { type: "string", maxLength: 50 },
      }, ["project"]),
    },
    {
      name: "record_reviews",
      description: "Record grades after every exercise or drill: per card (drives spaced repetition) and/or per topic. grade 1 again, 2 hard, 3 good, 4 easy; or give score 0-100.",
      inputSchema: obj({
        project: P,
        exercise: { type: "string", minLength: 1, maxLength: 50, description: "flashcard, drill, quiz, speaking, writing, problem, ..." },
        session: { type: "string", maxLength: 100, description: "Caller-chosen id grouping one exercise run." },
        items: {
          type: "array", minItems: 1, maxItems: 100,
          items: obj({
            card_id: { type: "string" },
            topic_path: topicPath,
            topic_id: topicId,
            grade: { type: "number", description: "1-4; clamped and rounded." },
            score: { type: "number", minimum: 0, maximum: 100, description: "Raw percentage; mapped to a grade when grade is absent." },
            comment: { type: "string", maxLength: 2000 },
          }, []),
        },
      }, ["project", "exercise", "items"]),
    },
    {
      name: "get_progress",
      description: "Progress report: reviews per day, average grade per exercise, weakest topics, most-lapsed cards, upcoming due counts, and one session's reviews.",
      inputSchema: obj({
        project: P,
        topic_path: topicPath,
        days: { type: "integer", minimum: 1, maximum: 3650 },
        session: { type: "string", maxLength: 100 },
      }, ["project"]),
    },
    {
      name: "link",
      description: "Create (or with remove, delete) a typed edge card->card or topic->topic: prerequisite, leads_to, example_of, part_of are directed; related, contrasts, confused_with are not.",
      inputSchema: obj({
        project: P,
        type: { type: "string", enum: LT },
        label: { type: "string", maxLength: 200 },
        from_card_id: { type: "string" },
        to_card_id: { type: "string" },
        from_topic: { type: "string", description: "Topic id or path." },
        to_topic: { type: "string", description: "Topic id or path." },
        remove: { type: "boolean" },
      }, ["project", "type"]),
    },
    {
      name: "get_graph",
      description: "Graph of knowledge coloured by mastery: mindmap (topic tree), flow (typed links) or full; as JSON and/or Mermaid to draw inline.",
      inputSchema: obj({
        project: P,
        root_path: topicPath,
        depth: { type: "integer", minimum: 0, maximum: 50 },
        include_cards: { type: "boolean" },
        link_types: { type: "array", items: { type: "string", enum: LT } },
        mode: { type: "string", enum: ["mindmap", "flow", "full"] },
        format: { type: "string", enum: ["json", "mermaid", "both"] },
        max_nodes: { type: "integer", minimum: 1, maximum: 400 },
      }, ["project"]),
    },
  ];
}

function obj(properties, required) {
  return { type: "object", properties: properties, required: required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Shared card helpers.

function topicPaths(app, ids) {
  var out = {};
  var uniq = {};
  ids.forEach(function (id) { if (id) uniq[id] = true; });
  var list = Object.keys(uniq);
  if (!list.length) return out;
  app.findRecordsByIds("topics", list).forEach(function (t) { out[t.id] = t.getString("path"); });
  return out;
}

function cardOut(c, path, compact) {
  var o = {
    id: c.id,
    project: c.getString("project"),
    topic: c.getString("topic"),
    topic_path: path || null,
    kind: c.getString("kind"),
    front: c.getString("front"),
    back: c.getString("back"),
    tags: util.parseJSONField(c, "tags", []),
    suspended: c.getBool("suspended"),
    due: util.isoDate(c.getString("due")),
    mastery: c.getFloat("mastery"),
  };
  if (compact) {
    if (o.back.length > 300) {
      o.back = o.back.slice(0, 300);
      o.truncated = true;
    }
    o.updated = util.isoDate(c.getString("updated"));
    return o;
  }
  o.extra = c.getString("extra");
  o.meta = util.parseJSONField(c, "meta", {});
  o.interval_days = c.getFloat("interval_days");
  o.ease = c.getFloat("ease");
  o.reps = c.getInt("reps");
  o.lapses = c.getInt("lapses");
  o.last_grade = c.getInt("last_grade");
  o.last_reviewed = util.isoDate(c.getString("last_reviewed"));
  o.created = util.isoDate(c.getString("created"));
  o.updated = util.isoDate(c.getString("updated"));
  return o;
}

function resetSrs(c) {
  var s = srs.initialState();
  c.set("due", "");
  c.set("interval_days", s.interval_days);
  c.set("ease", s.ease);
  c.set("reps", s.reps);
  c.set("lapses", s.lapses);
  c.set("last_grade", 0);
  c.set("last_reviewed", "");
  c.set("mastery", 0);
}

function findCard(app, id) {
  if (!util.isId(id)) fail("card not found: " + id);
  try {
    return app.findRecordById("cards", id);
  } catch (err) {
    fail("card not found: " + id);
  }
}

// Same project + topic + case-insensitive trimmed front.
function duplicateOf(app, topicId, front, excludeId) {
  var row = util.queryOne(app,
    "SELECT id FROM cards WHERE topic = {:topic} AND lower(trim(front)) = lower(trim({:front})) AND id != {:ex} LIMIT 1",
    { topic: topicId, front: front, ex: excludeId || "" }, { id: "" });
  return row ? row.id : null;
}

function idsInOrder(app, collection, ids) {
  if (!ids.length) return [];
  var map = {};
  app.findRecordsByIds(collection, ids).forEach(function (r) { map[r.id] = r; });
  return ids.map(function (id) { return map[id]; }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Handlers.

var handlers = {};

handlers.upsert_topic = function (app, a) {
  util.checkProject(app, a.project);
  return util.inTx(app, function (tx) { return topics.upsert(tx, a); });
};

handlers.list_topics = function (app, a) {
  util.checkProject(app, a.project);
  var where = "t.project = {:project}";
  var params = { project: a.project, now: util.dbDate(Date.now()) };
  var rootDepth = 0;
  if (a.root_path) {
    var root = util.parsePath(a.root_path).path;
    if (!topics.findByPath(app, a.project, root)) fail("topic not found: " + root);
    var sub = topics.subtreeClause("t.path", root);
    where += " AND " + sub.sql;
    Object.keys(sub.params).forEach(function (k) { params[k] = sub.params[k]; });
    rootDepth = root.split("/").length;
  }
  var rows = util.queryRows(app,
    "SELECT t.id AS id, t.path AS path, t.name AS name, t.parent AS parent, t.mastery AS mastery, " +
    "t.review_count AS review_count, t.last_reviewed AS last_reviewed FROM topics t WHERE " + where,
    params, { id: "", path: "", name: "", parent: "", mastery: 0.1, review_count: 0, last_reviewed: "" });

  var counts = {};
  util.queryRows(app,
    "SELECT c.topic AS topic, COUNT(*) AS n, " +
    "COALESCE(SUM(CASE WHEN c.suspended = 0 AND c.due != '' AND c.due <= {:now} THEN 1 ELSE 0 END), 0) AS due " +
    "FROM cards c JOIN topics t ON t.id = c.topic WHERE " + where + " GROUP BY c.topic",
    params, { topic: "", n: 0, due: 0 })
    .forEach(function (r) { counts[r.topic] = r; });

  var rolled = mastery.rollup(rows.map(function (r) {
    return { id: r.id, parent: r.parent, mastery: r.mastery, card_count: (counts[r.id] || {}).n || 0, reviewed: r.review_count > 0 };
  }));

  var items = rows.map(function (r) {
    return {
      id: r.id,
      path: r.path,
      name: r.name,
      parent: r.parent || null,
      mastery: r.mastery,
      rolled_mastery: rolled[r.id],
      card_count: (counts[r.id] || {}).n || 0,
      due_count: (counts[r.id] || {}).due || 0,
      review_count: r.review_count,
      last_reviewed: util.isoDate(r.last_reviewed),
    };
  });
  if (a.depth !== undefined) {
    var maxDepth = rootDepth ? rootDepth + a.depth : a.depth;
    items = items.filter(function (i) { return i.path.split("/").length <= Math.max(1, maxDepth); });
  }
  var sort = a.sort || "path";
  items.sort(function (x, y) {
    if (sort === "mastery_asc" && x.mastery !== y.mastery) return x.mastery - y.mastery;
    if (sort === "last_reviewed_asc" && x.last_reviewed !== y.last_reviewed) {
      if (!x.last_reviewed) return -1;
      if (!y.last_reviewed) return 1;
      return x.last_reviewed < y.last_reviewed ? -1 : 1;
    }
    return x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
  });
  var limit = a.limit || 200;
  return { items: items.slice(0, limit), total: items.length };
};

handlers.save_cards = function (app, a) {
  util.checkProject(app, a.project);
  var defaultRef = { topic_id: a.topic_id, topic_path: a.topic_path };
  return util.inTx(app, function (tx) {
    var coll = tx.findCollectionByNameOrId("cards");
    var defaultTopic = null;
    var out = [];
    a.cards.forEach(function (c, i) {
      try {
        var topic;
        if (c.topic_id || c.topic_path) {
          topic = topics.resolve(tx, a.project, { topic_id: c.topic_id, topic_path: c.topic_path }, true);
        } else {
          if (!defaultTopic) defaultTopic = topics.resolve(tx, a.project, defaultRef, true);
          topic = defaultTopic;
        }
        if (!topic) fail("no topic: give topic_path/topic_id on the call or the card");
        var dup = duplicateOf(tx, topic.id, c.front);
        if (dup) fail("duplicate: a card with this front already exists in " + topic.getString("path") + " (id " + dup + "); use update_card", { duplicate: dup });
        var rec = new Record(coll);
        rec.set("project", a.project);
        rec.set("topic", topic.id);
        rec.set("kind", c.kind.trim());
        rec.set("front", c.front.trim());
        rec.set("back", c.back);
        rec.set("extra", c.extra || "");
        rec.set("tags", util.normTags(c.tags));
        rec.set("meta", c.meta || {});
        rec.set("suspended", false);
        resetSrs(rec);
        tx.save(rec);
        out.push({ id: rec.id, front: rec.getString("front"), topic_path: topic.getString("path") });
      } catch (err) {
        util.itemFail(i, err);
      }
    });
    return { created: out, count: out.length };
  });
};

handlers.search_cards = function (app, a) {
  var where = ["1 = 1"];
  var params = {};
  if (a.project) {
    util.checkProject(app, a.project);
    where.push("c.project = {:project}");
    params.project = a.project;
  }
  if (a.topic_id || a.topic_path) {
    if (!a.project && a.topic_path) throw new util.ParamsError("arguments.project is required with topic_path");
    var topic = a.topic_id ? topics.findById(app, a.topic_id) : topics.resolve(app, a.project, { topic_path: a.topic_path }, false);
    if (!topic) fail("topic not found: " + a.topic_id);
    if (a.include_subtopics === false) {
      where.push("c.topic = {:topic}");
      params.topic = topic.id;
    } else {
      var sub = topics.subtreeClause("t.path", topic.getString("path"));
      where.push("t.project = {:tproject}", sub.sql);
      params.tproject = topic.getString("project");
      Object.keys(sub.params).forEach(function (k) { params[k] = sub.params[k]; });
    }
  }
  if (a.kind) {
    where.push("c.kind = {:kind}");
    params.kind = a.kind;
  }
  if (a.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END) WHERE value = {:tag})");
    params.tag = a.tag.trim().toLowerCase();
  }
  if (a.query) {
    where.push("(instr(lower(c.front), lower({:q})) > 0 OR instr(lower(c.back), lower({:q})) > 0 OR instr(lower(c.extra), lower({:q})) > 0)");
    params.q = a.query;
  }
  if (a.max_mastery !== undefined) {
    where.push("c.mastery <= {:maxm}");
    params.maxm = a.max_mastery;
  }
  var order = {
    "-updated": "c.updated DESC",
    mastery: "c.mastery ASC, c.updated DESC",
    due: "(c.due = '') ASC, c.due ASC",
    "-created": "c.created DESC",
  }[a.sort || "-updated"];
  var limit = a.limit || 20;
  var offset = a.offset || 0;
  var from = " FROM cards c JOIN topics t ON t.id = c.topic WHERE " + where.join(" AND ");
  var total = util.queryOne(app, "SELECT COUNT(*) AS n" + from, params, { n: 0 }).n;
  var ids = util.queryRows(app,
    "SELECT c.id AS id" + from + " ORDER BY " + order + ", c.id LIMIT {:limit} OFFSET {:offset}",
    Object.assign({ limit: limit, offset: offset }, params), { id: "" }).map(function (r) { return r.id; });
  var recs = idsInOrder(app, "cards", ids);
  var paths = topicPaths(app, recs.map(function (r) { return r.getString("topic"); }));
  return {
    items: recs.map(function (r) { return cardOut(r, paths[r.getString("topic")], true); }),
    total: total,
    limit: limit,
    offset: offset,
  };
};

handlers.get_cards = function (app, a) {
  var ids = a.ids.filter(util.isId);
  var recs = idsInOrder(app, "cards", ids);
  var found = {};
  recs.forEach(function (r) { found[r.id] = true; });
  var paths = topicPaths(app, recs.map(function (r) { return r.getString("topic"); }));
  return {
    items: recs.map(function (r) {
      var o = cardOut(r, paths[r.getString("topic")], false);
      o.reviews = app.findRecordsByFilter("reviews", "card = {:card}", "-created", 5, 0, { card: r.id }).map(reviewOut);
      return o;
    }),
    missing: a.ids.filter(function (id) { return !found[id]; }),
  };
};

function reviewOut(r) {
  return {
    id: r.id,
    exercise: r.getString("exercise"),
    session: r.getString("session") || null,
    grade: r.getInt("grade"),
    score: r.getFloat("score") || null,
    comment: r.getString("comment") || null,
    created: util.isoDate(r.getString("created")),
  };
}

handlers.update_card = function (app, a) {
  return util.inTx(app, function (tx) {
    var c = findCard(tx, a.id);
    var project = c.getString("project");
    var oldTopic = c.getString("topic");

    if (a.delete) {
      tx.delete(c);
      topics.recompute(tx, oldTopic);
      return { deleted: true, id: a.id };
    }

    var topicId = oldTopic;
    if (a.topic_id || a.topic_path) {
      topicId = topics.resolve(tx, project, { topic_id: a.topic_id, topic_path: a.topic_path }, true).id;
      c.set("topic", topicId);
    }
    if (a.front !== undefined) c.set("front", a.front.trim());
    if (a.front !== undefined || topicId !== oldTopic) {
      var dup = duplicateOf(tx, topicId, c.getString("front"), c.id);
      if (dup) fail("duplicate: card " + dup + " in the target topic has the same front", { duplicate: dup });
    }
    if (a.back !== undefined) c.set("back", a.back);
    if (a.extra !== undefined) c.set("extra", a.extra);
    if (a.kind !== undefined) c.set("kind", a.kind.trim());
    if (a.tags !== undefined) c.set("tags", util.normTags(a.tags));
    if (a.suspended !== undefined) c.set("suspended", a.suspended);
    if (a.meta !== undefined) {
      var merged = util.parseJSONField(c, "meta", {});
      if (!merged || typeof merged !== "object" || Array.isArray(merged)) merged = {};
      Object.keys(a.meta).forEach(function (k) {
        if (a.meta[k] === null) delete merged[k];
        else merged[k] = a.meta[k];
      });
      c.set("meta", merged);
    }
    if (a.reset_progress) resetSrs(c);
    tx.save(c);
    if (topicId !== oldTopic) topics.recompute(tx, oldTopic);
    if (topicId !== oldTopic || a.reset_progress) topics.recompute(tx, topicId);
    var paths = topicPaths(tx, [topicId]);
    return cardOut(c, paths[topicId], false);
  });
};

handlers.get_due_cards = function (app, a) {
  util.checkProject(app, a.project);
  var where = ["c.project = {:project}", "c.suspended = 0"];
  var params = { project: a.project, now: util.dbDate(Date.now()) };
  if (a.topic_path) {
    var t = topics.resolve(app, a.project, { topic_path: a.topic_path }, false);
    var sub = topics.subtreeClause("t.path", t.getString("path"));
    where.push("t.project = {:project}", sub.sql);
    Object.keys(sub.params).forEach(function (k) { params[k] = sub.params[k]; });
  }
  if (a.kind) {
    where.push("c.kind = {:kind}");
    params.kind = a.kind;
  }
  var from = " FROM cards c JOIN topics t ON t.id = c.topic WHERE " + where.join(" AND ");
  var limit = a.limit || 20;
  var newLimit = a.new_limit === undefined ? 10 : a.new_limit;
  var dueSql = from + " AND c.due != '' AND c.due <= {:now}";
  var newSql = from + " AND c.due = ''";
  var dueIds = util.queryRows(app, "SELECT c.id AS id" + dueSql + " ORDER BY c.due ASC, c.mastery ASC LIMIT {:limit}",
    Object.assign({ limit: limit }, params), { id: "" }).map(function (r) { return r.id; });
  var newIds = newLimit ? util.queryRows(app, "SELECT c.id AS id" + newSql + " ORDER BY c.created ASC, c.id LIMIT {:limit}",
    Object.assign({ limit: newLimit }, params), { id: "" }).map(function (r) { return r.id; }) : [];
  var dueRecs = idsInOrder(app, "cards", dueIds);
  var newRecs = idsInOrder(app, "cards", newIds);
  var paths = topicPaths(app, dueRecs.concat(newRecs).map(function (r) { return r.getString("topic"); }));
  function item(r) {
    return {
      id: r.id,
      kind: r.getString("kind"),
      front: r.getString("front"),
      back: r.getString("back"),
      extra: r.getString("extra"),
      topic_path: paths[r.getString("topic")],
      meta: util.parseJSONField(r, "meta", {}),
      tags: util.parseJSONField(r, "tags", []),
      due: util.isoDate(r.getString("due")),
      mastery: r.getFloat("mastery"),
      reps: r.getInt("reps"),
      lapses: r.getInt("lapses"),
    };
  }
  return {
    due: dueRecs.map(item),
    new: newRecs.map(item),
    counts: {
      due_total: util.queryOne(app, "SELECT COUNT(*) AS n" + dueSql, params, { n: 0 }).n,
      new_total: util.queryOne(app, "SELECT COUNT(*) AS n" + newSql, params, { n: 0 }).n,
    },
  };
};

handlers.record_reviews = function (app, a) {
  util.checkProject(app, a.project);
  var now = Date.now();
  return util.inTx(app, function (tx) {
    var reviewsColl = tx.findCollectionByNameOrId("reviews");
    var dirty = {};
    var cardsOut = [];
    var gradeSum = 0;
    a.items.forEach(function (it, i) {
      try {
        var grade = it.grade !== undefined ? srs.clampGrade(it.grade) : it.score !== undefined ? srs.gradeFromScore(it.score) : null;
        if (grade === null) fail("each item needs a grade or a score");
        if (!it.card_id && !it.topic_id && !it.topic_path) fail("each item needs card_id, topic_path or topic_id");
        var card = null;
        var topic;
        if (it.card_id) {
          card = findCard(tx, it.card_id);
          if (card.getString("project") !== a.project) fail("card " + it.card_id + " is not in project " + a.project);
          topic = topics.findById(tx, card.getString("topic"));
        } else {
          topic = topics.resolve(tx, a.project, { topic_id: it.topic_id, topic_path: it.topic_path }, false);
        }

        if (card) {
          var firstEver = !card.getString("last_reviewed");
          var next = srs.schedule({
            interval_days: card.getFloat("interval_days"),
            ease: card.getFloat("ease"),
            reps: card.getInt("reps"),
            lapses: card.getInt("lapses"),
            due: util.isoDate(card.getString("due")),
            last_reviewed: util.isoDate(card.getString("last_reviewed")),
          }, grade, now);
          var m = mastery.ema(card.getFloat("mastery"), grade, firstEver ? 0 : 1);
          card.set("interval_days", next.interval_days);
          card.set("ease", next.ease);
          card.set("reps", next.reps);
          card.set("lapses", next.lapses);
          card.set("due", next.due || "");
          card.set("last_reviewed", next.last_reviewed);
          card.set("last_grade", grade);
          card.set("mastery", m);
          tx.save(card);
          cardsOut.push({ card_id: card.id, grade: grade, next_due: next.due, interval_days: next.interval_days, mastery: m });
        } else {
          var prior = util.queryOne(tx, "SELECT COUNT(*) AS n FROM reviews WHERE topic = {:t} AND card = ''", { t: topic.id }, { n: 0 }).n;
          topic.set("self_mastery", mastery.ema(topic.getFloat("self_mastery"), grade, prior));
          tx.save(topic);
        }

        var rev = new Record(reviewsColl);
        rev.set("project", a.project);
        rev.set("topic", topic.id);
        rev.set("card", card ? card.id : "");
        rev.set("exercise", a.exercise);
        rev.set("session", a.session || "");
        rev.set("grade", grade);
        if (it.score !== undefined) rev.set("score", it.score);
        rev.set("comment", it.comment || "");
        tx.save(rev);

        dirty[topic.id] = true;
        gradeSum += grade;
      } catch (err) {
        util.itemFail(i, err);
      }
    });
    var topicsOut = Object.keys(dirty).map(function (id) {
      var t = topics.recompute(tx, id);
      return { topic_path: t.getString("path"), mastery: t.getFloat("mastery"), self_mastery: t.getFloat("self_mastery") };
    });
    return {
      cards: cardsOut,
      topics: topicsOut,
      session: { id: a.session || null, count: a.items.length, avg_grade: Math.round((gradeSum / a.items.length) * 100) / 100 },
    };
  });
};

handlers.get_progress = function (app, a) {
  util.checkProject(app, a.project);
  var now = Date.now();
  var days = a.days || 30;
  var params = { project: a.project, since: util.dbDate(now - days * DAY_MS) };
  var topicWhere = "";
  if (a.topic_path) {
    var t = topics.resolve(app, a.project, { topic_path: a.topic_path }, false);
    var sub = topics.subtreeClause("t.path", t.getString("path"));
    topicWhere = " AND " + sub.sql;
    Object.keys(sub.params).forEach(function (k) { params[k] = sub.params[k]; });
  }
  var revFrom = " FROM reviews r JOIN topics t ON t.id = r.topic WHERE r.project = {:project}" + topicWhere;

  var perDay = util.queryRows(app,
    "SELECT date(r.created, '+9 hours') AS day, COUNT(*) AS n, AVG(r.grade) AS avg" + revFrom +
    " AND r.created >= {:since} GROUP BY day ORDER BY day",
    params, { day: "", n: 0, avg: 0.1 })
    .map(function (r) { return { day: r.day, count: r.n, avg_grade: round2(r.avg) }; });

  var perExercise = util.queryRows(app,
    "SELECT r.exercise AS exercise, COUNT(*) AS n, AVG(r.grade) AS avg" + revFrom +
    " AND r.created >= {:since} GROUP BY r.exercise ORDER BY n DESC",
    params, { exercise: "", n: 0, avg: 0.1 })
    .map(function (r) { return { exercise: r.exercise, count: r.n, avg_grade: round2(r.avg) }; });

  var weakest = util.queryRows(app,
    "SELECT t.path AS path, t.mastery AS mastery, t.review_count AS reviews, t.last_reviewed AS last FROM topics t " +
    "WHERE t.project = {:project} AND t.review_count > 0" + topicWhere + " ORDER BY t.mastery ASC, t.path LIMIT 10",
    params, { path: "", mastery: 0.1, reviews: 0, last: "" })
    .map(function (r) { return { topic_path: r.path, mastery: r.mastery, review_count: r.reviews, last_reviewed: util.isoDate(r.last) }; });

  var lapsed = util.queryRows(app,
    "SELECT c.id AS id, c.front AS front, c.lapses AS lapses, c.mastery AS mastery, t.path AS path " +
    "FROM cards c JOIN topics t ON t.id = c.topic WHERE c.project = {:project} AND c.lapses > 0" + topicWhere +
    " ORDER BY c.lapses DESC, c.mastery ASC LIMIT 10",
    params, { id: "", front: "", lapses: 0, mastery: 0.1, path: "" })
    .map(function (r) { return { id: r.id, front: r.front, lapses: r.lapses, mastery: r.mastery, topic_path: r.path }; });

  var endOfToday = srs.startOfDay(now) + DAY_MS;
  var dueCounts = util.queryOne(app,
    "SELECT " +
    "COALESCE(SUM(CASE WHEN c.due <= {:today} THEN 1 ELSE 0 END), 0) AS today, " +
    "COALESCE(SUM(CASE WHEN c.due <= {:d7} THEN 1 ELSE 0 END), 0) AS d7, " +
    "COALESCE(SUM(CASE WHEN c.due <= {:d30} THEN 1 ELSE 0 END), 0) AS d30 " +
    "FROM cards c JOIN topics t ON t.id = c.topic WHERE c.project = {:project} AND c.suspended = 0 AND c.due != ''" + topicWhere,
    Object.assign({ today: util.dbDate(endOfToday), d7: util.dbDate(now + 7 * DAY_MS), d30: util.dbDate(now + 30 * DAY_MS) }, params),
    { today: 0, d7: 0, d30: 0 });

  var result = {
    days: days,
    reviews_per_day: perDay,
    by_exercise: perExercise,
    weakest_topics: weakest,
    most_lapsed_cards: lapsed,
    due: { today: dueCounts.today, next_7_days: dueCounts.d7, next_30_days: dueCounts.d30 },
  };
  if (a.session) {
    var recs = app.findRecordsByFilter("reviews", "project = {:project} && session = {:session}", "created", 500, 0,
      { project: a.project, session: a.session });
    var cardIds = recs.map(function (r) { return r.getString("card"); }).filter(Boolean);
    var fronts = {};
    if (cardIds.length) app.findRecordsByIds("cards", cardIds).forEach(function (c) { fronts[c.id] = c.getString("front"); });
    var paths = topicPaths(app, recs.map(function (r) { return r.getString("topic"); }));
    result.session = recs.map(function (r) {
      var o = reviewOut(r);
      o.card_id = r.getString("card") || null;
      o.front = fronts[o.card_id] || null;
      o.topic_path = paths[r.getString("topic")];
      return o;
    });
  }
  return result;
};

function round2(x) {
  return Math.round(x * 100) / 100;
}

handlers.link = function (app, a) {
  util.checkProject(app, a.project);
  var cardPair = a.from_card_id !== undefined || a.to_card_id !== undefined;
  var topicPair = a.from_topic !== undefined || a.to_topic !== undefined;
  if (cardPair === topicPair) fail("give exactly one pair: from_card_id + to_card_id, or from_topic + to_topic");
  var fromF, toF, from, to;
  if (cardPair) {
    if (!a.from_card_id || !a.to_card_id) fail("card links need both from_card_id and to_card_id");
    from = findCard(app, a.from_card_id);
    to = findCard(app, a.to_card_id);
    fromF = "from_card";
    toF = "to_card";
  } else {
    if (!a.from_topic || !a.to_topic) fail("topic links need both from_topic and to_topic");
    from = topics.resolveLoose(app, a.project, a.from_topic);
    to = topics.resolveLoose(app, a.project, a.to_topic);
    fromF = "from_topic";
    toF = "to_topic";
  }
  if (from.id === to.id) fail("self-links are not allowed");
  if (from.getString("project") !== a.project || to.getString("project") !== a.project) {
    fail("both ends must be in project " + a.project);
  }

  var filter = "type = {:type} && ((" + fromF + " = {:a} && " + toF + " = {:b})";
  if (!graph.DIRECTED[a.type]) filter += " || (" + fromF + " = {:b} && " + toF + " = {:a})";
  filter += ")";
  var existing = null;
  try {
    existing = app.findFirstRecordByFilter("links", filter, { type: a.type, a: from.id, b: to.id });
  } catch (err) {
    existing = null;
  }

  if (a.remove) {
    if (!existing) fail("no matching " + a.type + " link to remove");
    app.delete(existing);
    return { removed: true, id: existing.id };
  }
  if (existing) return Object.assign({ existed: true }, linkOut(existing));

  var rec = new Record(app.findCollectionByNameOrId("links"));
  rec.set("project", a.project);
  rec.set("type", a.type);
  rec.set(fromF, from.id);
  rec.set(toF, to.id);
  rec.set("label", a.label || "");
  app.save(rec);
  return Object.assign({ existed: false }, linkOut(rec));
};

function linkOut(l) {
  var o = { id: l.id, type: l.getString("type"), label: l.getString("label") || null };
  ["from_card", "to_card", "from_topic", "to_topic"].forEach(function (f) {
    if (l.getString(f)) o[f] = l.getString(f);
  });
  return o;
}

handlers.get_graph = function (app, a) {
  util.checkProject(app, a.project);
  var mode = a.mode || "full";
  var format = a.format || "both";
  var depth = a.depth === undefined ? 3 : a.depth;
  var maxNodes = a.max_nodes || 150;
  var params = { project: a.project, now: util.dbDate(Date.now()) };
  var where = "t.project = {:project}";
  var rootPath = null;
  if (a.root_path) {
    rootPath = util.parsePath(a.root_path).path;
    if (!topics.findByPath(app, a.project, rootPath)) fail("topic not found: " + rootPath);
    var sub = topics.subtreeClause("t.path", rootPath);
    where += " AND " + sub.sql;
    Object.keys(sub.params).forEach(function (k) { params[k] = sub.params[k]; });
  }

  var all = util.queryRows(app,
    "SELECT t.id AS id, t.name AS name, t.path AS path, t.parent AS parent, t.\"order\" AS ord, t.mastery AS mastery, " +
    "t.review_count AS reviews, (SELECT COUNT(*) FROM cards c WHERE c.topic = t.id) AS cards, " +
    "(SELECT COUNT(*) FROM cards c WHERE c.topic = t.id AND c.suspended = 0 AND c.due != '' AND c.due <= {:now}) AS due " +
    "FROM topics t WHERE " + where,
    params, { id: "", name: "", path: "", parent: "", ord: 0.1, mastery: 0.1, reviews: 0, cards: 0, due: 0 });

  // Rollup over the whole subtree, before the depth cut.
  var rolled = mastery.rollup(all.map(function (t) {
    return { id: t.id, parent: t.parent, mastery: t.mastery, card_count: t.cards, reviewed: t.reviews > 0 };
  }));
  var reviewedPaths = {};
  all.forEach(function (t) {
    if (t.reviews > 0) {
      var segs = t.path.split("/");
      for (var i = 1; i <= segs.length; i++) reviewedPaths[segs.slice(0, i).join("/")] = true;
    }
  });
  var baseDepth = rootPath ? rootPath.split("/").length : 0;
  var maxDepth = rootPath ? baseDepth + depth : Math.max(1, depth);
  var inScope = all.filter(function (t) { return t.path.split("/").length <= maxDepth; });
  var topicNodes = inScope.map(function (t) {
    return {
      id: t.id, name: t.name, path: t.path, parent: t.parent, order: t.ord,
      mastery: rolled[t.id], reviewed: !!reviewedPaths[t.path], due_count: t.due,
    };
  });

  var cardNodes = [];
  if (a.include_cards && inScope.length) {
    var scopeIds = {};
    inScope.forEach(function (t) { scopeIds[t.id] = true; });
    cardNodes = util.queryRows(app,
      "SELECT c.id AS id, c.topic AS topic, c.front AS front, c.mastery AS mastery, c.last_reviewed AS lr " +
      "FROM cards c JOIN topics t ON t.id = c.topic WHERE " + where + " ORDER BY c.created LIMIT 5000",
      params, { id: "", topic: "", front: "", mastery: 0.1, lr: "" })
      .filter(function (c) { return scopeIds[c.topic]; })
      .map(function (c) { return { id: c.id, topic: c.topic, front: c.front, mastery: c.mastery, reviewed: !!c.lr }; });
  }

  var links = [];
  if (mode !== "mindmap") {
    var types = a.link_types && a.link_types.length ? a.link_types : util.linkTypes(app);
    links = app.findRecordsByFilter("links", "project = {:project}", "created", 10000, 0, { project: a.project })
      .filter(function (l) { return types.indexOf(l.getString("type")) >= 0; })
      .map(function (l) {
        return {
          type: l.getString("type"),
          label: l.getString("label"),
          from: l.getString("from_card") || l.getString("from_topic"),
          to: l.getString("to_card") || l.getString("to_topic"),
        };
      });
  }

  var g = graph.buildGraph({ topics: topicNodes, cards: cardNodes, links: links, mode: mode, maxNodes: maxNodes });
  var result = { mode: mode, truncated: g.truncated, stats: g.stats };
  if (format === "json" || format === "both") {
    result.nodes = g.nodes;
    result.edges = g.edges;
  }
  if (format === "mermaid" || format === "both") result.mermaid = graph.renderMermaid(g, mode, a.project);
  return result;
};

// Number of items a call touched, for the log line.
function itemCount(name, args, result) {
  if (name === "save_cards") return (args.cards || []).length;
  if (name === "record_reviews") return (args.items || []).length;
  if (name === "get_cards") return (args.ids || []).length;
  if (result && Array.isArray(result.items)) return result.items.length;
  if (result && Array.isArray(result.nodes)) return result.nodes.length;
  return 1;
}

module.exports = {
  definitions: definitions,
  handlers: handlers,
  itemCount: itemCount,
};
