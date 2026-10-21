/// <reference path="../pb_data/types.d.ts" />
// OAuth 2.1 for the MCP connector: discovery, registration, sign-in, tokens.
// The logic lives in lib/oauth.js; each route goes through lib/oauth_route.js,
// which turns an unexpected exception into a plain 500 instead of throwing.

routerAdd("GET", "/.well-known/oauth-protected-resource", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "protectedResourceMetadata");
});

routerAdd("GET", "/.well-known/oauth-protected-resource/mcp", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "protectedResourceMetadata");
});

routerAdd("GET", "/.well-known/oauth-authorization-server", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "authorizationServerMetadata");
});

routerAdd("POST", "/oauth/register", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "register");
}, $apis.skipSuccessActivityLog());

routerAdd("GET", "/oauth/authorize", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "authorizeGet");
}, $apis.skipSuccessActivityLog());

routerAdd("POST", "/oauth/authorize", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "authorizePost");
}, $apis.skipSuccessActivityLog());

routerAdd("POST", "/oauth/token", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "token");
}, $apis.skipSuccessActivityLog());

routerAdd("POST", "/oauth/revoke", (e) => {
  return require(`${__hooks}/lib/oauth_route.js`).run(e, "revoke");
}, $apis.skipSuccessActivityLog());
