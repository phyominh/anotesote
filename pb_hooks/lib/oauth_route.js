// Runs an oauth.js handler; an unexpected exception becomes a 500 JSON reply
// rather than propagating (and being logged with the request).
function run(e, name) {
  try {
    return require(__hooks + "/lib/oauth.js")[name](e);
  } catch (err) {
    (e.app || $app).logger().error("oauth handler failed", "handler", name, "error", String((err && err.message) || err));
    e.response.header().set("Cache-Control", "no-store");
    return e.json(500, { error: "server_error", error_description: "internal error" });
  }
}

module.exports = { run: run };
