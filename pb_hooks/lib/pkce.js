// PKCE (RFC 7636) and redirect-URI helpers. Pure and goja-compatible:
// the caller supplies the SHA-256 digest as hex ($security.sha256 in the hook).

var B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Hex string → unpadded base64url.
function hexToBase64Url(hex) {
  var bytes = [];
  for (var i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  var out = "";
  for (var j = 0; j < bytes.length; j += 3) {
    var b0 = bytes[j];
    var b1 = j + 1 < bytes.length ? bytes[j + 1] : 0;
    var b2 = j + 2 < bytes.length ? bytes[j + 2] : 0;
    var n = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (j + 1 < bytes.length) out += B64URL[(n >> 6) & 63];
    if (j + 2 < bytes.length) out += B64URL[n & 63];
  }
  return out;
}

// code_verifier: 43-128 chars of [A-Z a-z 0-9 - . _ ~].
function validVerifier(v) {
  return typeof v === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

// S256 challenge: base64url(sha256(verifier)), digest given as hex.
function s256Matches(verifierSha256Hex, challenge) {
  return typeof challenge === "string" && challenge.length > 0 && hexToBase64Url(verifierSha256Hex) === challenge;
}

// Exact-match redirect allowlist, with optional loopback (any port, http)
// for local tools such as the MCP Inspector.
function redirectAllowed(uri, allowlist, allowLoopback) {
  if (typeof uri !== "string" || !uri) return false;
  if (allowlist.indexOf(uri) >= 0) return true;
  if (allowLoopback && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s#]*)?$/.test(uri)) return true;
  return false;
}

// Host of an https URL, or "" when it is not a plain https URL with a DNS name.
function httpsHost(url) {
  var m = /^https:\/\/([a-z0-9.-]+)(:\d{1,5})?(\/[^\s#]*)?$/i.exec(String(url || ""));
  if (!m) return "";
  var host = m[1].toLowerCase();
  if (/^[0-9.]+$/.test(host) || host === "localhost") return "";
  return host;
}

module.exports = {
  hexToBase64Url: hexToBase64Url,
  validVerifier: validVerifier,
  s256Matches: s256Matches,
  redirectAllowed: redirectAllowed,
  httpsHost: httpsHost,
};
