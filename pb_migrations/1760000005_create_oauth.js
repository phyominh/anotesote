/// <reference path="../pb_data/types.d.ts" />
// OAuth 2.1 state for the MCP connector: registered clients, one-time
// authorization codes and issued tokens. Codes and tokens are stored only as
// SHA-256 hashes. All collections are superuser-only; revoke access by
// deleting (or flagging) rows in oauth_tokens from the admin UI.
migrate((app) => {
  const base = {
    type: "base",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  };
  const stamps = [
    { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
  ];

  app.save(new Collection(Object.assign({}, base, {
    name: "oauth_clients",
    fields: [
      { type: "text", name: "client_id", required: true, max: 100 },
      { type: "text", name: "client_name", max: 200 },
      { type: "json", name: "redirect_uris", maxSize: 5000 },
    ].concat(stamps),
    indexes: ["CREATE UNIQUE INDEX idx_oauth_clients_client_id ON oauth_clients (client_id)"],
  })));

  app.save(new Collection(Object.assign({}, base, {
    name: "oauth_codes",
    fields: [
      { type: "text", name: "code_hash", required: true, max: 64 },
      { type: "text", name: "client_id", required: true, max: 500 },
      { type: "text", name: "client_name", max: 200 },
      { type: "text", name: "redirect_uri", required: true, max: 500 },
      { type: "text", name: "code_challenge", required: true, max: 128 },
      { type: "text", name: "resource", max: 500 },
      { type: "text", name: "scope", max: 200 },
      { type: "date", name: "expires", required: true },
    ].concat(stamps),
    indexes: ["CREATE UNIQUE INDEX idx_oauth_codes_hash ON oauth_codes (code_hash)"],
  })));

  app.save(new Collection(Object.assign({}, base, {
    name: "oauth_tokens",
    fields: [
      { type: "text", name: "access_hash", required: true, max: 64 },
      { type: "text", name: "refresh_hash", required: true, max: 64 },
      { type: "text", name: "family", required: true, max: 40 },
      { type: "text", name: "client_id", required: true, max: 500 },
      { type: "text", name: "client_name", max: 200 },
      { type: "text", name: "resource", max: 500 },
      { type: "text", name: "scope", max: 200 },
      { type: "date", name: "access_expires", required: true },
      { type: "date", name: "refresh_expires", required: true },
      { type: "date", name: "last_used" },
      { type: "bool", name: "revoked" },
    ].concat(stamps),
    indexes: [
      "CREATE UNIQUE INDEX idx_oauth_tokens_access ON oauth_tokens (access_hash)",
      "CREATE UNIQUE INDEX idx_oauth_tokens_refresh ON oauth_tokens (refresh_hash)",
      "CREATE INDEX idx_oauth_tokens_family ON oauth_tokens (family)",
    ],
  })));

  // Throttle the sign-in form (password guessing), registration and the
  // other OAuth endpoints. Rules match on method + path prefix.
  const settings = app.settings();
  const labels = ["POST /oauth/authorize", "POST /oauth/register", "/oauth/"];
  const rules = JSON.parse(JSON.stringify(settings.rateLimits.rules || []))
    .filter((r) => labels.indexOf(r.label) < 0);
  rules.push({ label: "POST /oauth/authorize", audience: "", duration: 300, maxRequests: 10 });
  rules.push({ label: "POST /oauth/register", audience: "", duration: 3600, maxRequests: 20 });
  rules.push({ label: "/oauth/", audience: "", duration: 60, maxRequests: 60 });
  unmarshal({ rateLimits: { enabled: true, rules: rules } }, settings);
  app.save(settings);
}, (app) => {
  ["oauth_tokens", "oauth_codes", "oauth_clients"].forEach((name) => {
    app.delete(app.findCollectionByNameOrId(name));
  });
  const settings = app.settings();
  const labels = ["POST /oauth/authorize", "POST /oauth/register", "/oauth/"];
  const rules = JSON.parse(JSON.stringify(settings.rateLimits.rules || []))
    .filter((r) => labels.indexOf(r.label) < 0);
  unmarshal({ rateLimits: { rules: rules } }, settings);
  app.save(settings);
});
