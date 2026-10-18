/// <reference path="../pb_data/types.d.ts" />
// Nightly local backups (03:00 server time, keep 7) and built-in rate limiting.
// S3 credentials are configured in the admin UI only, never here.
migrate((app) => {
  const settings = app.settings();
  settings.backups.cron = "0 3 * * *";
  settings.backups.cronMaxKeep = 7;
  settings.rateLimits.enabled = true;
  app.save(settings);
}, (app) => {
  const settings = app.settings();
  settings.backups.cron = "";
  app.save(settings);
});
