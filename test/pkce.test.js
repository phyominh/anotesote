const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const p = require("../pb_hooks/lib/pkce.js");

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

test("RFC 7636 appendix B vector", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(p.hexToBase64Url(sha256hex(verifier)), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.ok(p.s256Matches(sha256hex(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
  assert.ok(!p.s256Matches(sha256hex(verifier + "x"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
  assert.ok(!p.s256Matches(sha256hex(verifier), ""));
});

test("base64url matches Node for every length remainder", () => {
  for (let n = 0; n < 40; n++) {
    const buf = crypto.randomBytes(n);
    assert.equal(p.hexToBase64Url(buf.toString("hex")), buf.toString("base64url"));
  }
});

test("verifier format", () => {
  assert.ok(p.validVerifier("a".repeat(43)));
  assert.ok(p.validVerifier("A-._~".repeat(20)));
  assert.ok(!p.validVerifier("a".repeat(42)));
  assert.ok(!p.validVerifier("a".repeat(129)));
  assert.ok(!p.validVerifier("a".repeat(42) + "+"));
  assert.ok(!p.validVerifier(undefined));
});

test("redirect allowlist is exact, loopback only when enabled", () => {
  const allow = ["https://claude.ai/api/mcp/auth_callback"];
  assert.ok(p.redirectAllowed("https://claude.ai/api/mcp/auth_callback", allow, false));
  assert.ok(!p.redirectAllowed("https://claude.ai/api/mcp/auth_callback/", allow, false));
  assert.ok(!p.redirectAllowed("https://claude.ai/api/mcp/auth_callback?x=1", allow, false));
  assert.ok(!p.redirectAllowed("https://evil.example/cb", allow, false));
  assert.ok(!p.redirectAllowed("http://localhost:6274/oauth/callback", allow, false));
  assert.ok(p.redirectAllowed("http://localhost:6274/oauth/callback", allow, true));
  assert.ok(p.redirectAllowed("http://127.0.0.1:33418/cb", allow, true));
  assert.ok(!p.redirectAllowed("http://localhost.evil.example/cb", allow, true));
  assert.ok(!p.redirectAllowed("http://127.0.0.1@evil.example/cb", allow, true));
});

test("httpsHost only accepts https URLs with DNS names", () => {
  assert.equal(p.httpsHost("https://Claude.ai/oauth/client.json"), "claude.ai");
  assert.equal(p.httpsHost("http://claude.ai/x"), "");
  assert.equal(p.httpsHost("https://127.0.0.1/x"), "");
  assert.equal(p.httpsHost("https://localhost/x"), "");
  assert.equal(p.httpsHost("https://user@claude.ai/x"), "");
  assert.equal(p.httpsHost("not a url"), "");
});
