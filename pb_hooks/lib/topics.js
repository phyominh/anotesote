// Topic paths: resolution, upsert, move/rename, delete and mastery recompute.

var util = require(__hooks + "/lib/util.js");
var mastery = require(__hooks + "/lib/mastery.js");
var fail = util.fail;

function findByPath(app, project, path) {
  try {
    return app.findFirstRecordByFilter("topics", "project = {:project} && path = {:path}", { project: project, path: path });
  } catch (err) {
    return null;
  }
}

function findById(app, id) {
  if (!util.isId(id)) return null;
  try {
    return app.findRecordById("topics", id);
  } catch (err) {
    return null;
  }
}

// Ensure every topic along `parsed` exists; returns the last one.
function ensurePath(app, project, parsed) {
  var coll = app.findCollectionByNameOrId("topics");
  var parent = null;
  var rec = null;
  for (var i = 0; i < parsed.slugs.length; i++) {
    var path = parsed.slugs.slice(0, i + 1).join("/");
    rec = findByPath(app, project, path);
    if (!rec) {
      rec = new Record(coll);
      rec.set("project", project);
      rec.set("name", parsed.names[i].slice(0, 120));
      rec.set("path", path);
      rec.set("parent", parent ? parent.id : "");
      rec.set("mastery", 0);
      rec.set("self_mastery", 0);
      rec.set("review_count", 0);
      app.save(rec);
    }
    parent = rec;
  }
  return rec;
}

// Resolve {topic_id | topic_path} within a project. With create=true a missing
// path is auto-created. Returns the record, or fails.
function resolve(app, project, ref, create) {
  ref = ref || {};
  if (ref.topic_id) {
    var byId = findById(app, ref.topic_id);
    if (!byId) fail("topic not found: " + ref.topic_id);
    if (byId.getString("project") !== project) fail("topic " + ref.topic_id + " is not in project " + project);
    return byId;
  }
  if (ref.topic_path) {
    var parsed = util.parsePath(ref.topic_path);
    if (create) return ensurePath(app, project, parsed);
    var rec = findByPath(app, project, parsed.path);
    if (!rec) fail("topic not found: " + parsed.path);
    return rec;
  }
  return null;
}

// Accept either an id or a path in one string (used by `link`).
function resolveLoose(app, project, value) {
  if (util.isId(value)) {
    var byId = findById(app, value);
    if (byId) {
      if (byId.getString("project") !== project) fail("topic " + value + " is not in project " + project);
      return byId;
    }
  }
  return resolve(app, project, { topic_path: value }, false);
}

// SQL fragment + params matching a path and everything below it. Uses substr
// rather than LIKE so "_" and "%" in slugs are never wildcards.
function subtreeClause(column, path, key) {
  key = key || "sub";
  var params = {};
  params[key + "_path"] = path;
  params[key + "_prefix"] = path + "/";
  params[key + "_len"] = path.length + 1;
  return {
    sql: "(" + column + " = {:" + key + "_path} OR substr(" + column + ", 1, {:" + key + "_len}) = {:" + key + "_prefix})",
    params: params,
  };
}

function descendants(app, project, path) {
  var prefix = path + "/";
  var rows = util.queryRows(app,
    "SELECT id FROM topics WHERE project = {:project} AND substr(path, 1, {:n}) = {:prefix}",
    { project: project, n: prefix.length, prefix: prefix }, { id: "" });
  return rows.map(function (r) { return app.findRecordById("topics", r.id); });
}

function countChildren(app, topicId) {
  return util.queryOne(app, "SELECT COUNT(*) AS n FROM topics WHERE parent = {:id}", { id: topicId }, { n: 0 }).n;
}

function countCards(app, topicId) {
  return util.queryOne(app, "SELECT COUNT(*) AS n FROM cards WHERE topic = {:id}", { id: topicId }, { n: 0 }).n;
}

// Recompute stored mastery / review_count / last_reviewed for one topic from
// its direct cards and its own topic-level reviews (HANDOVER §8.5).
function recompute(app, topicId) {
  var t = findById(app, topicId);
  if (!t) return null;
  var cards = util.queryOne(app,
    "SELECT COUNT(*) AS n, COALESCE(AVG(mastery), 0) AS avg FROM cards WHERE topic = {:id} AND last_reviewed != ''",
    { id: topicId }, { n: 0, avg: 0.1 });
  var revs = util.queryOne(app,
    "SELECT COUNT(*) AS n, COALESCE(MAX(created), '') AS last, " +
    "COALESCE(SUM(CASE WHEN card = '' THEN 1 ELSE 0 END), 0) AS selfn FROM reviews WHERE topic = {:id}",
    { id: topicId }, { n: 0, last: "", selfn: 0 });
  var cardAvg = cards.n > 0 ? cards.avg : null;
  var self = revs.selfn > 0 ? t.getFloat("self_mastery") : null;
  t.set("mastery", mastery.blendTopic(cardAvg, self));
  t.set("review_count", revs.n);
  t.set("last_reviewed", revs.last);
  app.save(t);
  return t;
}

function out(t) {
  return {
    id: t.id,
    project: t.getString("project"),
    path: t.getString("path"),
    name: t.getString("name"),
    parent: t.getString("parent") || null,
    description: t.getString("description"),
    order: t.getFloat("order"),
    mastery: t.getFloat("mastery"),
    self_mastery: t.getFloat("self_mastery"),
    review_count: t.getInt("review_count"),
    last_reviewed: util.isoDate(t.getString("last_reviewed")),
  };
}

// upsert_topic: create (with ancestors), update fields, move/rename, delete.
function upsert(app, args) {
  var project = args.project;
  var parsed = util.parsePath(args.path);

  if (args.delete) {
    if (args.new_path) fail("delete and new_path cannot be combined");
    var victim = findByPath(app, project, parsed.path);
    if (!victim) fail("topic not found: " + parsed.path);
    var nCards = countCards(app, victim.id);
    var nChildren = countChildren(app, victim.id);
    if (nCards || nChildren) {
      fail("topic " + parsed.path + " is not empty: " + nCards + " cards, " + nChildren + " child topics",
        { cards: nCards, children: nChildren });
    }
    app.delete(victim);
    return { deleted: true, path: parsed.path };
  }

  var created = !findByPath(app, project, parsed.path);
  var topic = ensurePath(app, project, parsed);

  if (args.new_path) {
    var target = util.parsePath(args.new_path);
    if (target.path === parsed.path) fail("new_path is the same as path");
    if (target.path.indexOf(parsed.path + "/") === 0) fail("cannot move a topic under itself");
    if (findByPath(app, project, target.path)) fail("target path already exists: " + target.path);
    var parent = null;
    if (target.slugs.length > 1) {
      parent = ensurePath(app, project, {
        names: target.names.slice(0, -1),
        slugs: target.slugs.slice(0, -1),
      });
    }
    var oldPrefix = parsed.path + "/";
    var kids = descendants(app, project, parsed.path);
    topic.set("path", target.path);
    topic.set("name", target.names[target.names.length - 1].slice(0, 120));
    topic.set("parent", parent ? parent.id : "");
    app.save(topic);
    kids.forEach(function (k) {
      k.set("path", target.path + "/" + k.getString("path").slice(oldPrefix.length));
      app.save(k);
    });
  }

  var dirty = false;
  if (args.description !== undefined) {
    topic.set("description", String(args.description));
    dirty = true;
  }
  if (args.order !== undefined) {
    topic.set("order", Number(args.order));
    dirty = true;
  }
  if (dirty) app.save(topic);

  var result = out(topic);
  result.created = created;
  return result;
}

module.exports = {
  findByPath: findByPath,
  findById: findById,
  ensurePath: ensurePath,
  resolve: resolve,
  resolveLoose: resolveLoose,
  subtreeClause: subtreeClause,
  descendants: descendants,
  countCards: countCards,
  recompute: recompute,
  upsert: upsert,
  out: out,
};
