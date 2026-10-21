/// <reference path="../pb_data/types.d.ts" />
// MCP endpoint for the study knowledge base.
//
//   POST /mcp            OAuth bearer token (see oauth.pb.js)
//   POST /mcp/{secret}   legacy secret-in-URL auth, off when MCP_SECRET is unset
//
// Handlers run in isolated VM contexts, so all logic lives in lib/ and is
// require()d inside each handler. skipSuccessActivityLog keeps these
// requests (whose URL may contain the secret) out of the request log; the
// handlers always reply themselves and never throw, so nothing is logged.

routerAdd("POST", "/mcp", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handleBearerPost(e);
}, $apis.skipSuccessActivityLog());

routerAdd("GET", "/mcp", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handleBearerOther(e);
}, $apis.skipSuccessActivityLog());

routerAdd("DELETE", "/mcp", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handleBearerOther(e);
}, $apis.skipSuccessActivityLog());

routerAdd("POST", "/mcp/{secret}", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handlePost(e);
}, $apis.skipSuccessActivityLog());

routerAdd("GET", "/mcp/{secret}", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handleOther(e);
}, $apis.skipSuccessActivityLog());

routerAdd("DELETE", "/mcp/{secret}", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handleOther(e);
}, $apis.skipSuccessActivityLog());
