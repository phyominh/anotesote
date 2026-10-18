// Shared helpers for the hook: errors, slugs, enums, date and record formatting.
// Runs only inside the PocketBase JSVM (uses $app / Record APIs).

// A tool-level failure: reported to Claude as {isError: true}, never as a
// JSON-RPC error.
function ToolError(message, data) {
  this.name = "ToolError";
  this.message = message;
  this.data = data;
}
ToolError.prototype = Object.create(Error.prototype);

// Malformed params: reported as JSON-RPC -32602.
function ParamsError(message) {
  this.name = "ParamsError";
  this.message = message;
}
ParamsError.prototype = Object.create(Error.prototype);

function fail(message, data) {
  throw new ToolError(message, data);
}

// Lowercase, whitespace → "-", "/" stripped. Non-ASCII is kept.
function slugify(segment) {
  return String(segment)
    .trim()
    .toLowerCase()
    .replace(/\//g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// "DSA/Graphs/Shortest Path" → {names: [...], slugs: [...], path: "dsa/graphs/shortest-path"}
function parsePath(input) {
  if (typeof input !== "string" || !input.trim()) fail("topic path must be a non-empty string");
  var names = input.split("/").map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
  var slugs = names.map(slugify);
  if (!names.length || slugs.some(function (s) { return !s; })) fail("invalid topic path: " + input);
  var path = slugs.join("/");
  if (path.length > 500) fail("topic path too long (max 500)");
  return { names: names, slugs: slugs, path: path };
}

function selectValues(app, collection, field) {
  var f = app.findCollectionByNameOrId(collection).fields.getByName(field);
  var out = [];
  for (var i = 0; i < f.values.length; i++) out.push(String(f.values[i]));
  return out;
}

function projects(app) {
  return selectValues(app, "topics", "project");
}

function linkTypes(app) {
  return selectValues(app, "links", "type");
}

function checkProject(app, project) {
  var list = projects(app);
  if (list.indexOf(project) < 0) fail("unknown project '" + project + "'. Allowed: " + list.join(", "));
  return project;
}

// PocketBase stores "2026-10-01 00:00:00.000Z"; return ISO or null.
function isoDate(value) {
  var s = value === null || value === undefined ? "" : String(value);
  if (!s) return null;
  return s.replace(" ", "T");
}

// ISO / Date / ms → PocketBase storage format (comparable as text in SQL).
function dbDate(value) {
  var d = value instanceof Date ? value : new Date(value);
  return d.toISOString().replace("T", " ");
}

function parseJSONField(record, name, fallback) {
  var raw = record.getString(name);
  if (!raw || raw === "null") return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function normTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) fail("tags must be an array of strings");
  var seen = {};
  var out = [];
  tags.forEach(function (t) {
    var v = String(t).trim().toLowerCase();
    if (v && !seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  });
  return out;
}

// Raw SQL helpers. Values are always bound, never concatenated.
// DynamicModel infers column types from the shape: use "" for text, 0 for
// integers and a non-integer such as 0.1 for floats (0 would scan as int64).
// Wrap nullable aggregates in COALESCE.
function queryRows(app, sql, params, shape) {
  var rows = arrayOf(new DynamicModel(shape));
  app.db().newQuery(sql).bind(params || {}).all(rows);
  return rows.map(function (r) {
    var o = {};
    Object.keys(shape).forEach(function (k) { o[k] = r[k]; });
    return o;
  });
}

function queryOne(app, sql, params, shape) {
  var rows = queryRows(app, sql, params, shape);
  return rows.length ? rows[0] : null;
}

// Run fn inside a transaction. A ToolError thrown inside rolls back and is
// re-thrown intact (Go wraps JS errors, so the original is kept aside).
function inTx(app, fn) {
  var toolErr = null;
  var result;
  try {
    app.runInTransaction(function (txApp) {
      try {
        result = fn(txApp);
      } catch (err) {
        if (err instanceof ToolError || err instanceof ParamsError) toolErr = err;
        throw err;
      }
    });
  } catch (err) {
    if (toolErr) throw toolErr;
    throw err;
  }
  return result;
}

// Item-indexed failure inside batch tools.
function itemFail(index, err) {
  if (err instanceof ToolError) {
    var data = err.data || {};
    data.index = index;
    throw new ToolError("item " + index + ": " + err.message, data);
  }
  throw err;
}

function isId(v) {
  return typeof v === "string" && /^[a-z0-9]{15}$/.test(v);
}

module.exports = {
  ToolError: ToolError,
  ParamsError: ParamsError,
  fail: fail,
  slugify: slugify,
  parsePath: parsePath,
  projects: projects,
  linkTypes: linkTypes,
  checkProject: checkProject,
  isoDate: isoDate,
  dbDate: dbDate,
  parseJSONField: parseJSONField,
  normTags: normTags,
  queryRows: queryRows,
  queryOne: queryOne,
  inTx: inTx,
  itemFail: itemFail,
  isId: isId,
};
