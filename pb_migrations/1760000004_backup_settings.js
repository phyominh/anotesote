/// <reference path="../pb_data/types.d.ts" />
// Nightly local backups (03:00 server time, keep 7) and built-in rate limiting,
// with an extra rule for the MCP endpoint (the defaults only cover /api/).
// S3 credentials are configured in the admin UI only, never here.
migrate((app) => {
  const settings = app.settings();
  settings.backups.cron = "0 3 * * *";
  settings.backups.cronMaxKeep = 7;

  const rules = JSON.parse(JSON.stringify(settings.rateLimits.rules || []))
    .filter((r) => r.label !== "/mcp/");
  rules.push({ label: "/mcp/", audience: "", duration: 10, maxRequests: 300 });
  unmarshal({ rateLimits: { enabled: true, rules: rules } }, settings);
  app.save(settings);
}, (app) => {
  const settings = app.settings();
  settings.backups.cron = "";
  const rules = JSON.parse(JSON.stringify(settings.rateLimits.rules || []))
    .filter((r) => r.label !== "/mcp/");
  unmarshal({ rateLimits: { rules: rules } }, settings);
  app.save(settings);
});
