// MCP Streamable HTTP transport, stateless JSON mode (HANDOVER §8.1-8.2).

var SERVER_INFO = { name: "study-kb", version: "2.0.0" };

// Newest first. initialize returns the client's version when it is listed
// here, otherwise the newest one (MCP version negotiation).
var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

var INSTRUCTIONS =
  "Personal study knowledge base. Store knowledge as atomic cards (one idea per card) filed under topic paths like " +
  "\"grammar/particles\". Search before saving to avoid duplicates; prefer update_card. After every exercise or drill, " +
  "call record_reviews with a grade per card and/or per topic. Use links to capture prerequisites, sequences and " +
  "confusions. Use get_graph to draw mind maps (tree) or flow graphs (links).";

var MAX_BODY_BYTES = 2 * 1024 * 1024;

// Constant-time comparison; an unset secret rejects everything.
function secretOk(e) {
  var expected = $os.getenv("MCP_SECRET") || "";
  var got = e.request.pathValue("secret") || "";
  if (!expected) return false;
  var diff = expected.length ^ got.length;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ (i < got.length ? got.charCodeAt(i) : 0);
  }
  return diff === 0;
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code: code, message: message } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id, result: result };
}

function callTool(app, params, id) {
  var tools = require(__hooks + "/lib/tools.js");
  var util = require(__hooks + "/lib/util.js");
  var schema = require(__hooks + "/lib/schema.js");

  if (!params || typeof params !== "object" || typeof params.name !== "string") {
    return rpcError(id, -32602, "params.name is required");
  }
  var name = params.name;
  var args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  var def = null;
  var defs = tools.definitions(app);
  for (var i = 0; i < defs.length; i++) if (defs[i].name === name) def = defs[i];
  if (!def || !tools.handlers[name]) return rpcError(id, -32601, "Unknown tool: " + name);

  var started = Date.now();
  var ok = false;
  var count = 0;
  try {
    var invalid = schema.validate(def.inputSchema, args);
    if (invalid) return rpcError(id, -32602, invalid);
    var result = tools.handlers[name](app, args);
    ok = true;
    count = tools.itemCount(name, args, result);
    return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (err) {
    if (err instanceof util.ParamsError) return rpcError(id, -32602, err.message);
    var msg = err instanceof util.ToolError ? err.message : "internal error: " + ((err && err.message) || String(err));
    return rpcResult(id, { content: [{ type: "text", text: msg }], isError: true });
  } finally {
    // Never log the secret, the URL path or any card content.
    app.logger().info("mcp tools/call", "tool", name, "ok", ok, "items", count, "ms", Date.now() - started);
  }
}

// Returns a response object, or null for notifications / client responses.
function handleMessage(app, msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "Invalid Request");
  var hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  if (typeof msg.method !== "string") {
    // A response from the client (result/error) needs no reply.
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) return null;
    return rpcError(hasId ? msg.id : null, -32600, "Invalid Request");
  }
  if (msg.jsonrpc !== "2.0") return hasId ? rpcError(msg.id, -32600, "Invalid Request: jsonrpc must be \"2.0\"") : null;
  if (!hasId) return null; // notification (e.g. notifications/initialized)

  var id = msg.id;
  var params = msg.params || {};
  switch (msg.method) {
    case "initialize": {
      var asked = params.protocolVersion;
      var version = PROTOCOL_VERSIONS.indexOf(asked) >= 0 ? asked : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list": {
      var tools = require(__hooks + "/lib/tools.js");
      return rpcResult(id, { tools: tools.definitions(app) });
    }
    case "tools/call":
      return callTool(app, params, id);
    default:
      return rpcError(id, -32601, "Method not found: " + msg.method);
  }
}

// POST /mcp/{secret}: legacy secret-in-URL auth (disabled when MCP_SECRET is unset).
function handlePost(e) {
  if (!secretOk(e)) return e.noContent(404);
  return dispatch(e);
}

// POST /mcp: OAuth bearer token auth.
function handleBearerPost(e) {
  var oauth = require(__hooks + "/lib/oauth.js");
  if (!oauth.enabled()) return e.noContent(404);
  var auth = oauth.verifyBearer(e);
  if (!auth.ok) return oauth.challenge(e, auth.error);
  return dispatch(e);
}

function handleBearerOther(e) {
  var oauth = require(__hooks + "/lib/oauth.js");
  if (!oauth.enabled()) return e.noContent(404);
  e.response.header().set("Allow", "POST");
  return e.noContent(405);
}

function dispatch(e) {
  var app = e.app || $app;
  var body;
  try {
    var raw = toString(e.request.body, MAX_BODY_BYTES + 1);
    if (raw.length > MAX_BODY_BYTES) return e.json(413, rpcError(null, -32600, "Request too large"));
    body = JSON.parse(raw);
  } catch (err) {
    return e.json(200, rpcError(null, -32700, "Parse error"));
  }

  var responses;
  if (Array.isArray(body)) {
    if (!body.length) return e.json(200, rpcError(null, -32600, "Invalid Request: empty batch"));
    responses = body.map(function (m) { return safeHandle(app, m); }).filter(function (r) { return r !== null; });
    if (!responses.length) return e.noContent(202);
    return e.json(200, responses);
  }
  var single = safeHandle(app, body);
  if (single === null) return e.noContent(202);
  return e.json(200, single);
}

function safeHandle(app, msg) {
  try {
    return handleMessage(app, msg);
  } catch (err) {
    var id = msg && typeof msg === "object" && msg.id !== undefined ? msg.id : null;
    return rpcError(id, -32603, "Internal error");
  }
}

function handleOther(e) {
  if (!secretOk(e)) return e.noContent(404);
  e.response.header().set("Allow", "POST");
  return e.noContent(405);
}

module.exports = {
  handlePost: handlePost,
  handleOther: handleOther,
  handleBearerPost: handleBearerPost,
  handleBearerOther: handleBearerOther,
  PROTOCOL_VERSIONS: PROTOCOL_VERSIONS,
};
