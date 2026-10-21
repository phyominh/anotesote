// OAuth 2.1 authorization server + protected-resource metadata for the MCP
// endpoint (MCP authorization spec): discovery documents, dynamic client
// registration, client ID metadata documents, a sign-in/consent page backed
// by PocketBase superuser credentials, PKCE-only authorization codes,
// rotating refresh tokens and revocation.
//
// Every handler replies itself and never throws, so PocketBase's request log
// only sees successes (the routes use skipSuccessActivityLog).

var pkce = require(__hooks + "/lib/pkce.js");

var SCOPE = "mcp";
var CODE_TTL_MS = 5 * 60 * 1000;
var ACCESS_TTL_S = 60 * 60;
var REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
var TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
var DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

// ---------------------------------------------------------------------------
// Configuration

// Public base URL, e.g. https://ans.mhetsu.com. Set PUBLIC_URL in the env
// file; otherwise derive it from the proxy headers.
function publicUrl(e) {
  var env = ($os.getenv("PUBLIC_URL") || "").replace(/\/+$/, "");
  if (env) return env;
  var proto = e.request.header.get("X-Forwarded-Proto") || (e.request.tls ? "https" : "http");
  return proto + "://" + e.request.host;
}

function resourceUrl(e) {
  return publicUrl(e) + "/mcp";
}

function redirectAllowlist() {
  var extra = ($os.getenv("OAUTH_REDIRECT_URIS") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return DEFAULT_REDIRECTS.concat(extra);
}

function allowLoopback() {
  return $os.getenv("OAUTH_ALLOW_LOOPBACK") === "1";
}

// Client ID metadata documents may only be fetched from the hosts of the
// allowed redirect URIs (plus OAUTH_CIMD_HOSTS), so the server cannot be used
// to fetch arbitrary URLs.
function cimdHostAllowed(host) {
  if (!host) return false;
  var hosts = redirectAllowlist().map(pkce.httpsHost).filter(Boolean);
  ($os.getenv("OAUTH_CIMD_HOSTS") || "").split(",").forEach(function (h) {
    h = h.trim().toLowerCase();
    if (h) hosts.push(h);
  });
  return hosts.indexOf(host) >= 0;
}

function enabled() {
  return $os.getenv("OAUTH_DISABLED") !== "1";
}

// ---------------------------------------------------------------------------
// Small helpers

function sha(s) {
  return $security.sha256(String(s));
}

function newToken(prefix) {
  return prefix + $security.randomStringWithAlphabet(48, TOKEN_ALPHABET);
}

function dbDate(ms) {
  return new Date(ms).toISOString().replace("T", " ");
}

function msOf(dateStr) {
  var s = String(dateStr || "");
  if (!s) return 0;
  var ms = Date.parse(s.replace(" ", "T"));
  return isNaN(ms) ? 0 : ms;
}

function noStore(e) {
  e.response.header().set("Cache-Control", "no-store");
  e.response.header().set("Pragma", "no-cache");
}

function oauthError(e, status, code, description) {
  noStore(e);
  return e.json(status, { error: code, error_description: description });
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appendQuery(url, params) {
  var parts = [];
  Object.keys(params).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== "") {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
  });
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
}

function findOne(app, collection, filter, params) {
  try {
    return app.findFirstRecordByFilter(collection, filter, params);
  } catch (err) {
    return null;
  }
}

// Form or JSON body as a plain object.
function bodyOf(e) {
  try {
    var b = e.requestInfo().body || {};
    var o = {};
    Object.keys(b).forEach(function (k) {
      var v = b[k];
      o[k] = Array.isArray(v) ? v[0] : v;
    });
    return o;
  } catch (err) {
    return {};
  }
}

function queryOf(e) {
  var q = e.request.url.query();
  var o = {};
  ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
    .forEach(function (k) { o[k] = q.get(k) || ""; });
  return o;
}

// ---------------------------------------------------------------------------
// Discovery

function protectedResourceMetadata(e) {
  if (!enabled()) return e.noContent(404);
  return e.json(200, {
    resource: resourceUrl(e),
    authorization_servers: [publicUrl(e)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "study-kb",
  });
}

function authorizationServerMetadata(e) {
  if (!enabled()) return e.noContent(404);
  var base = publicUrl(e);
  return e.json(200, {
    issuer: base,
    authorization_endpoint: base + "/oauth/authorize",
    token_endpoint: base + "/oauth/token",
    registration_endpoint: base + "/oauth/register",
    revocation_endpoint: base + "/oauth/revoke",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
}

// ---------------------------------------------------------------------------
// Clients

// Dynamic client registration (RFC 7591). Public clients only.
function register(e) {
  if (!enabled()) return e.noContent(404);
  var app = e.app || $app;
  var b;
  try {
    b = JSON.parse(toString(e.request.body, 64 * 1024));
  } catch (err) {
    return oauthError(e, 400, "invalid_client_metadata", "body must be JSON");
  }
  var uris = b && b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) {
    return oauthError(e, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty array");
  }
  for (var i = 0; i < uris.length; i++) {
    if (!pkce.redirectAllowed(uris[i], redirectAllowlist(), allowLoopback())) {
      return oauthError(e, 400, "invalid_redirect_uri", "redirect_uri not allowed on this server: " + uris[i]);
    }
  }
  var method = b.token_endpoint_auth_method || "none";
  if (method !== "none") {
    return oauthError(e, 400, "invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported");
  }
  var name = String(b.client_name || "MCP client").slice(0, 200);
  var rec = new Record(app.findCollectionByNameOrId("oauth_clients"));
  var clientId = "skb_client_" + $security.randomStringWithAlphabet(24, TOKEN_ALPHABET);
  rec.set("client_id", clientId);
  rec.set("client_name", name);
  rec.set("redirect_uris", uris);
  app.save(rec);
  noStore(e);
  return e.json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  });
}

// {client_id, client_name, redirect_uris} or null. client_id is either one we
// issued, or an https URL to a client ID metadata document.
function resolveClient(app, clientId) {
  if (!clientId) return null;
  if (clientId.indexOf("https://") === 0) {
    var host = pkce.httpsHost(clientId);
    if (!cimdHostAllowed(host)) return null;
    try {
      var res = $http.send({ url: clientId, method: "GET", timeout: 5, headers: { Accept: "application/json" } });
      if (res.statusCode !== 200 || !res.json || res.json.client_id !== clientId) return null;
      var uris = res.json.redirect_uris;
      if (!Array.isArray(uris)) return null;
      return { client_id: clientId, client_name: String(res.json.client_name || host).slice(0, 200), redirect_uris: uris };
    } catch (err) {
      return null;
    }
  }
  var rec = findOne(app, "oauth_clients", "client_id = {:id}", { id: clientId });
  if (!rec) return null;
  var list = [];
  try {
    list = JSON.parse(rec.getString("redirect_uris") || "[]");
  } catch (err) {
    list = [];
  }
  return { client_id: clientId, client_name: rec.getString("client_name"), redirect_uris: list };
}

// ---------------------------------------------------------------------------
// Authorization endpoint

// Validates an authorization request. Errors that make the redirect target
// untrustworthy are shown on a page; the rest are redirected to the client.
function checkRequest(e, app, p) {
  var client = resolveClient(app, p.client_id);
  if (!client) return { page: "Unknown client. Remove the connector in Claude and add it again." };
  if (!p.redirect_uri || client.redirect_uris.indexOf(p.redirect_uri) < 0 ||
    !pkce.redirectAllowed(p.redirect_uri, redirectAllowlist(), allowLoopback())) {
    return { page: "This redirect address is not allowed for this client." };
  }
  if (p.response_type !== "code") return { client: client, redirect: "unsupported_response_type" };
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9\-_]{43}$/.test(p.code_challenge)) {
    return { client: client, redirect: "invalid_request", description: "PKCE with S256 is required" };
  }
  if (p.resource && p.resource.replace(/\/+$/, "") !== resourceUrl(e)) {
    return { client: client, redirect: "invalid_target", description: "unknown resource" };
  }
  if (p.scope && p.scope.split(" ").some(function (s) { return s && s !== SCOPE; })) {
    return { client: client, redirect: "invalid_scope", description: "only the mcp scope is available" };
  }
  return { client: client };
}

function redirectError(e, p, code, description) {
  return e.redirect(302, appendQuery(p.redirect_uri, {
    error: code,
    error_description: description || "",
    state: p.state,
    iss: publicUrl(e),
  }));
}

function pageHeaders(e, redirectUri) {
  var origin = "";
  var m = /^(https?:\/\/[^/]+)/.exec(redirectUri || "");
  if (m) origin = " " + m[1];
  e.response.header().set("Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" + origin + "; frame-ancestors 'none'; base-uri 'none'");
  e.response.header().set("X-Frame-Options", "DENY");
  e.response.header().set("Referrer-Policy", "no-referrer");
  noStore(e);
}

function renderPage(e, status, opts) {
  pageHeaders(e, opts.redirect_uri);
  var hidden = "";
  if (opts.params) {
    Object.keys(opts.params).forEach(function (k) {
      hidden += '<input type="hidden" name="' + escapeHtml(k) + '" value="' + escapeHtml(opts.params[k]) + '">';
    });
  }
  var body;
  if (opts.fatal) {
    body = '<h1>Can\'t connect</h1><p class="err">' + escapeHtml(opts.fatal) + "</p>";
  } else {
    var host = (/^https?:\/\/([^/]+)/.exec(opts.redirect_uri || "") || [])[1] || "";
    body =
      "<h1>Connect to study-kb</h1>" +
      "<p><strong>" + escapeHtml(opts.client_name) + "</strong> wants to read and update your study knowledge base." +
      (host ? ' You will be returned to <span class="host">' + escapeHtml(host) + "</span>." : "") + "</p>" +
      (opts.error ? '<p class="err">' + escapeHtml(opts.error) + "</p>" : "") +
      '<form method="post" action="/oauth/authorize">' + hidden +
      '<label>Admin email<input type="email" name="email" autocomplete="username" required value="' + escapeHtml(opts.email || "") + '"></label>' +
      '<label>Password<input type="password" name="password" autocomplete="current-password" required></label>' +
      '<div class="row"><button type="submit" name="decision" value="allow">Sign in and allow</button>' +
      '<button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Deny</button></div>' +
      "</form>" +
      '<p class="small">Uses your PocketBase admin account. Revoke access any time by deleting the token in the admin UI (oauth_tokens).</p>';
  }
  var html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>study-kb sign-in</title><style>" +
    ":root{--bg:#f6f6f4;--card:#fff;--fg:#1b1b1b;--muted:#5f6368;--line:#d9d9d6;--accent:#1f6f50;--on-accent:#fff;--err:#b3261e}" +
    "@media (prefers-color-scheme:dark){:root{--bg:#161616;--card:#1f1f1f;--fg:#ececec;--muted:#a3a3a3;--line:#3a3a3a;--accent:#5fbf95;--on-accent:#0d2419;--err:#f2b8b5}}" +
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);" +
    "font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}" +
    "main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}" +
    "h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 16px}.small{font-size:.85rem;color:var(--muted);margin:16px 0 0}" +
    ".host{font-family:ui-monospace,monospace}.err{color:var(--err)}" +
    "label{display:block;font-size:.9rem;color:var(--muted);margin-bottom:12px}" +
    "input{display:block;width:100%;margin-top:4px;padding:10px;font:inherit;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:8px}" +
    ".row{display:flex;gap:8px;margin-top:8px}button{flex:1;padding:10px;font:inherit;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);cursor:pointer}" +
    "button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}" +
    "</style></head><body><main>" + body + "</main></body></html>";
  return e.html(status, html);
}

function authorizeGet(e) {
  if (!enabled()) return e.noContent(404);
  var app = e.app || $app;
  var p = queryOf(e);
  var chk = checkRequest(e, app, p);
  if (chk.page) return renderPage(e, 400, { fatal: chk.page });
  if (chk.redirect) return redirectError(e, p, chk.redirect, chk.description);
  return renderPage(e, 200, { params: p, client_name: chk.client.client_name, redirect_uri: p.redirect_uri });
}

function authorizePost(e) {
  if (!enabled()) return e.noContent(404);
  var app = e.app || $app;
  var b = bodyOf(e);
  var p = {};
  ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
    .forEach(function (k) { p[k] = b[k] ? String(b[k]) : ""; });
  var chk = checkRequest(e, app, p);
  if (chk.page) return renderPage(e, 400, { fatal: chk.page });
  if (chk.redirect) return redirectError(e, p, chk.redirect, chk.description);
  if (b.decision === "deny") return redirectError(e, p, "access_denied", "the user denied access");

  var email = String(b.email || "").trim();
  var ok = false;
  try {
    var su = app.findAuthRecordByEmail("_superusers", email);
    ok = !!su && su.validatePassword(String(b.password || ""));
  } catch (err) {
    ok = false;
  }
  if (!ok) {
    app.logger().warn("oauth sign-in failed", "ip", e.realIP());
    return renderPage(e, 401, {
      params: p, client_name: chk.client.client_name, redirect_uri: p.redirect_uri,
      email: email, error: "Wrong email or password.",
    });
  }

  var code = newToken("skb_code_");
  var rec = new Record(app.findCollectionByNameOrId("oauth_codes"));
  rec.set("code_hash", sha(code));
  rec.set("client_id", p.client_id);
  rec.set("client_name", chk.client.client_name);
  rec.set("redirect_uri", p.redirect_uri);
  rec.set("code_challenge", p.code_challenge);
  rec.set("resource", resourceUrl(e));
  rec.set("scope", SCOPE);
  rec.set("expires", dbDate(Date.now() + CODE_TTL_MS));
  app.save(rec);
  app.logger().info("oauth authorized", "client", chk.client.client_name);
  return e.redirect(302, appendQuery(p.redirect_uri, { code: code, state: p.state, iss: publicUrl(e) }));
}

// ---------------------------------------------------------------------------
// Token endpoint

// Drop rows that can no longer matter: tokens past their refresh expiry
// (rotated-out ones are kept until then for reuse detection) and expired
// codes. Runs on each issue instead of a cron job.
function prune(app) {
  var now = dbDate(Date.now());
  try {
    app.db().newQuery("DELETE FROM oauth_tokens WHERE refresh_expires < {:now}").bind({ now: now }).execute();
    app.db().newQuery("DELETE FROM oauth_codes WHERE expires < {:now}").bind({ now: now }).execute();
  } catch (err) {
    // non-fatal
  }
}

function issueTokens(app, family, client, resource) {
  prune(app);
  var access = newToken("skb_at_");
  var refresh = newToken("skb_rt_");
  var now = Date.now();
  var rec = new Record(app.findCollectionByNameOrId("oauth_tokens"));
  rec.set("access_hash", sha(access));
  rec.set("refresh_hash", sha(refresh));
  rec.set("family", family);
  rec.set("client_id", client.client_id);
  rec.set("client_name", client.client_name || "");
  rec.set("resource", resource);
  rec.set("scope", SCOPE);
  rec.set("access_expires", dbDate(now + ACCESS_TTL_S * 1000));
  rec.set("refresh_expires", dbDate(now + REFRESH_TTL_MS));
  rec.set("revoked", false);
  app.save(rec);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

function revokeFamily(app, family) {
  app.findRecordsByFilter("oauth_tokens", "family = {:f} && revoked = false", "", 1000, 0, { f: family })
    .forEach(function (t) {
      t.set("revoked", true);
      app.save(t);
    });
}

function token(e) {
  if (!enabled()) return e.noContent(404);
  var app = e.app || $app;
  var b = bodyOf(e);
  var grant = String(b.grant_type || "");

  if (grant === "authorization_code") {
    var code = String(b.code || "");
    var rec = code ? findOne(app, "oauth_codes", "code_hash = {:h}", { h: sha(code) }) : null;
    if (!rec) return oauthError(e, 400, "invalid_grant", "unknown or used authorization code");
    // One-time use: delete before any other check.
    app.delete(rec);
    if (msOf(rec.getString("expires")) < Date.now()) return oauthError(e, 400, "invalid_grant", "authorization code expired");
    if (String(b.client_id || "") !== rec.getString("client_id")) return oauthError(e, 400, "invalid_grant", "client_id mismatch");
    if (String(b.redirect_uri || "") !== rec.getString("redirect_uri")) return oauthError(e, 400, "invalid_grant", "redirect_uri mismatch");
    var verifier = String(b.code_verifier || "");
    if (!pkce.validVerifier(verifier) || !pkce.s256Matches(sha(verifier), rec.getString("code_challenge"))) {
      return oauthError(e, 400, "invalid_grant", "PKCE verification failed");
    }
    if (b.resource && String(b.resource).replace(/\/+$/, "") !== rec.getString("resource")) {
      return oauthError(e, 400, "invalid_target", "resource mismatch");
    }
    var family = $security.randomStringWithAlphabet(32, TOKEN_ALPHABET);
    var out = issueTokens(app, family, { client_id: rec.getString("client_id"), client_name: rec.getString("client_name") }, rec.getString("resource"));
    noStore(e);
    return e.json(200, out);
  }

  if (grant === "refresh_token") {
    var rt = String(b.refresh_token || "");
    var old = rt ? findOne(app, "oauth_tokens", "refresh_hash = {:h}", { h: sha(rt) }) : null;
    if (!old) return oauthError(e, 400, "invalid_grant", "unknown refresh token");
    if (old.getBool("revoked")) {
      // A rotated-out refresh token came back: assume it was stolen.
      revokeFamily(app, old.getString("family"));
      app.logger().warn("oauth refresh token reuse; family revoked", "client", old.getString("client_name"));
      return oauthError(e, 400, "invalid_grant", "refresh token already used");
    }
    if (msOf(old.getString("refresh_expires")) < Date.now()) return oauthError(e, 400, "invalid_grant", "refresh token expired");
    if (b.client_id && String(b.client_id) !== old.getString("client_id")) return oauthError(e, 400, "invalid_grant", "client_id mismatch");
    old.set("revoked", true);
    app.save(old);
    var next = issueTokens(app, old.getString("family"),
      { client_id: old.getString("client_id"), client_name: old.getString("client_name") }, old.getString("resource"));
    noStore(e);
    return e.json(200, next);
  }

  return oauthError(e, 400, "unsupported_grant_type", "use authorization_code or refresh_token");
}

// Revocation (RFC 7009): always 200; revokes the whole token family.
function revoke(e) {
  if (!enabled()) return e.noContent(404);
  var app = e.app || $app;
  var t = String(bodyOf(e).token || "");
  if (t) {
    var h = sha(t);
    var rec = findOne(app, "oauth_tokens", "access_hash = {:h} || refresh_hash = {:h}", { h: h });
    if (rec) revokeFamily(app, rec.getString("family"));
  }
  noStore(e);
  return e.noContent(200);
}

// ---------------------------------------------------------------------------
// Resource server side

// Returns {ok: true} for a valid bearer token, or {ok: false, error} (error is
// "" when no token was sent at all).
function verifyBearer(e) {
  var app = e.app || $app;
  var h = e.request.header.get("Authorization") || "";
  var m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return { ok: false, error: "" };
  var rec = findOne(app, "oauth_tokens", "access_hash = {:h}", { h: sha(m[1]) });
  if (!rec || rec.getBool("revoked")) return { ok: false, error: "invalid_token" };
  if (msOf(rec.getString("access_expires")) < Date.now()) return { ok: false, error: "invalid_token" };
  if (rec.getString("resource") !== resourceUrl(e)) return { ok: false, error: "invalid_token" };
  // Touch last_used at most every 5 minutes to keep writes rare.
  if (Date.now() - msOf(rec.getString("last_used")) > 5 * 60 * 1000) {
    rec.set("last_used", dbDate(Date.now()));
    try {
      app.save(rec);
    } catch (err) {
      // non-fatal
    }
  }
  return { ok: true };
}

function challenge(e, error) {
  var v = 'Bearer resource_metadata="' + publicUrl(e) + '/.well-known/oauth-protected-resource/mcp", scope="' + SCOPE + '"';
  if (error) v += ', error="' + error + '"';
  e.response.header().set("WWW-Authenticate", v);
  return e.json(401, { error: error || "unauthorized", error_description: "sign in via OAuth to use this endpoint" });
}

module.exports = {
  enabled: enabled,
  protectedResourceMetadata: protectedResourceMetadata,
  authorizationServerMetadata: authorizationServerMetadata,
  register: register,
  authorizeGet: authorizeGet,
  authorizePost: authorizePost,
  token: token,
  revoke: revoke,
  verifyBearer: verifyBearer,
  challenge: challenge,
};
