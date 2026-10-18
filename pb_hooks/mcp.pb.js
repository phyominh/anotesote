/// <reference path="../pb_data/types.d.ts" />
// MCP endpoint for the study knowledge base: POST /mcp/{secret}.
//
// Handlers run in isolated VM contexts, so all logic lives in lib/ and is
// require()d inside each handler. skipSuccessActivityLog keeps these
// requests (whose URL contains the secret) out of the request log; the
// handlers always reply themselves and never throw, so nothing is logged.

routerAdd("POST", "/mcp/{secret}", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handlePost(e);
}, $apis.skipSuccessActivityLog());

routerAdd("GET", "/mcp/{secret}", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handleOther(e);
}, $apis.skipSuccessActivityLog());

routerAdd("DELETE", "/mcp/{secret}", (e) => {
  return require(`${__hooks}/lib/rpc.js`).handleOther(e);
}, $apis.skipSuccessActivityLog());
