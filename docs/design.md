# Design: study-kb MCP (PocketBase)

Status: implemented · 2026-10-18

`HANDOVER.md` is the base spec. This file records the decisions made in brainstorming and the points where the build deliberately deviates from or refines the handover. Where the two disagree, this file wins.

## Decisions (answers to handover §2)

| Question | Answer |
|---|---|
| Domain | `ans.mhetsu.com`. Endpoint: `https://ans.mhetsu.com/mcp/<SECRET>` |
| Caddy | Not present. **nginx already serves HTTPS on the VPS**, so PocketBase listens on `127.0.0.1:8090` behind it (`install.sh --nginx`, site template in `deploy/nginx.conf`, certificate via certbot). This is option A with nginx in place of Caddy. The nginx site disables the access and error logs for `/mcp/`, because the URL carries the secret. The standalone option B remains as the script's default and refuses to run when 80/443 are taken |
| SSH / deploy | Out of scope for this build session. The repo ships `scripts/install.sh`, which the owner runs on the VPS |
| Projects | `english, japanese, maths, dsa` |
| Backups | Local only: cron `0 3 * * *`, keep 7. S3 can be added later in the admin UI with no code change |
| v1 data | None. The §7.6 migration is **not** built |

## Pinned version

- **PocketBase v0.40.5** (released 2026-10-08), the latest stable release according to the Go module proxy.
- The build container can't reach GitHub release assets or pocketbase.io, so for local testing the binary is built from source (`go install github.com/pocketbase/pocketbase/examples/base@v0.40.5`).
- The hook API is checked against the JSVM `types.d.ts` that ships in that module version. That file is the source of truth for the API, ahead of the handover's indicative JS.
- `install.sh` downloads the official release zip for v0.40.5 on the VPS and verifies its checksum.

## Refinements to the handover

1. **Subtopic prefix matching.** Use SQL `path = {:p} OR substr(path, 1, {:n}) = {:prefix}`, where `prefix = p + "/"`. Don't use the filter `~`, because PocketBase wraps `~` in `%…%` and LIKE treats `_` and `%` inside slugs as wildcards. All values are still bound parameters.
2. **`initialize` protocolVersion.** If the client asks for a supported version, return it. Otherwise return the latest supported version (this is the MCP version-negotiation rule). The supported list is kept in one constant.
3. **The `project` select is in all four collections**, `links` included. The handover's §10 already says this; §7 omitted it. The README lists all four as the places to edit when adding a project.
4. **Same-day SRS rule.** Start of day = UTC+9 fixed offset. Japan has no DST, so goja needs no timezone database.
5. **Smoke test portability.** `scripts/smoke-test.sh` needs only `bash`, `curl` and `jq`, and reads `BASE` and `SECRET`. It runs against a local throwaway PocketBase (temporary `pb_data`, random secret) during the build, and against the VPS after install.
6. **Unit tests.** Plain Node `node:test`. The `lib/` modules use CommonJS `module.exports` with no Node-only APIs, so both goja's `require` and Node can load them unchanged.

7. **Code layout.** `mcp.pb.js` only registers routes. The JSON-RPC dispatch lives in `lib/rpc.js`, and two small helpers were added: `lib/schema.js` (tool input validation, so bad arguments map to `-32602`) and `lib/util.js`.
8. **Secret never logged.** The MCP routes use `$apis.skipSuccessActivityLog()`, and the handlers always reply themselves (they never throw). As a result PocketBase's request log, which records URLs, never stores the secret. Verified against the logs DB.
9. **Rate limiting.** The built-in limiter is enabled, with an extra `/mcp/` rule of 300 requests per 10 seconds (the same as the `/api/` default), since the default rules only cover `/api/`.
10. **Mermaid edge labels** use the pipe form (`A -.-|"label"| B`, `A -->|"label"| B`) instead of `A -. label .- B`. They render the same, and the quoted pipe form escapes safely. Output was validated with the real `mermaid@11` parser, using labels that contain quotes, brackets, pipes and Japanese text.
11. **Graph nodes.** A topic node's `mastery` is its rolled-up mastery (card-weighted over its subtree). Nodes carry a `reviewed` flag, which drives the `new` class. Flow mode drops nodes that have no link edges.
12. **Smoke test isolation.** Tests run under a random root topic (`smoke-xxxxxx/graphs/shortest-path` instead of `dsa/graphs/shortest-path`), so running against production never touches or deletes real data.
13. **Small additions.** `reviews` has an `updated` autodate like the other collections. `list_topics` returns `{items, total}`. `link` returns `existed: true` for a no-op. `record_reviews` returns `self_mastery` for each affected topic.

14. **OAuth 2.1 (added after the handover, which listed OAuth as out of scope).** `POST /mcp` takes a bearer token. The hook is its own authorization server, all in `lib/oauth.js` and `oauth.pb.js`:
    - Discovery: RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource[/mcp]` and RFC 8414 metadata at `/.well-known/oauth-authorization-server`.
    - Clients: RFC 7591 dynamic registration (public clients only), plus client ID metadata documents fetched only from allowlisted hosts.
    - Sign-in: a sign-in and consent page that checks PocketBase superuser credentials.
    - Codes: authorization codes require PKCE S256, last 5 minutes and work once.
    - Tokens: `resource` (RFC 8707) is checked and bound to each token. Access tokens last 1 hour. Refresh tokens last 90 days and rotate on use, and reusing one revokes the whole token family. RFC 7009 revocation is supported.
    - Storage: tokens and codes are stored only as SHA-256 hashes, in `oauth_clients`, `oauth_codes` and `oauth_tokens`.
    - Redirects: the redirect URI allowlist defaults to Claude's two callbacks.
    - The legacy `/mcp/{secret}` route remains until `MCP_SECRET` is removed. `PUBLIC_URL` (written by `install.sh`) fixes the issuer and resource URLs.
    - nginx needs an exact `location = /mcp` block: otherwise the `/mcp/` prefix block makes nginx answer `POST /mcp` with a 301. `install.sh` adds that block to sites written by older versions.

Everything else follows the handover as written: architecture, auth, transport, the 11 tools, schema, SM-2, mastery, graph output, logging, security notes and out-of-scope items.

## Verification (in the build container)

- `npm test`: 28 unit tests (SM-2, mastery, graph/Mermaid, schema validator, PKCE including the RFC 7636 vector, redirect allowlist).
- OAuth: the smoke test's step 16 (20 checks: discovery, registration, sign-in, PKCE, single-use codes, refresh rotation, reuse detection, revocation) passes directly and through nginx. The official MCP SDK 1.32.1 client completes its own OAuth discovery, registration, sign-in and token flow and calls tools, also through nginx. The sign-in page was checked in Chromium in light and dark mode at desktop and phone widths.
- `scripts/smoke-test.sh` against a locally built PocketBase v0.40.5: 71 checks, all §9.2 steps plus move/rename.
- The official `@modelcontextprotocol/sdk` 1.32.1 client connects, lists tools and calls them over Streamable HTTP.
- Migrations go up and down cleanly. With `MCP_SECRET` unset, every request gets 404.
- `install.sh --nginx --port 8091` runs end to end in the build container, with stand-ins only for `systemctl`, `certbot` and the GitHub download (served from the locally built v0.40.5 zip with a real checksum). Fresh install and re-run both succeed. Afterwards PocketBase runs as `pocketbase` on 127.0.0.1:8091, the documented `superuser upsert` works, the smoke test passes through nginx (71/71), and the secret appears in neither nginx log. Not covered: real systemd, real certbot, IPv6 (the container has none). It passes `shellcheck`.

## Build order

Each step is committed once its tests pass.

1. `lib/srs.js` and `lib/mastery.js`, plus Node unit tests (§9.1).
2. Migrations for topics, cards, reviews and links, plus backup settings.
3. `mcp.pb.js` transport (secret check, 405/404/202, batch, errors), plus the topic tools.
4. The card tools, `record_reviews`, `get_due_cards` and `get_progress`.
5. `link`, `lib/graph.js` and `get_graph` (JSON and Mermaid), plus Mermaid unit tests.
6. `scripts/smoke-test.sh` passing all §9.2 steps against a local PocketBase.
7. The deploy files (systemd unit for option B, `env.example`, `install.sh`) and the README (§10 hand-off and operations).

## Risks

- **JSVM API drift.** The handover's JS is pre-v0.40. Mitigation: code against the `types.d.ts` for v0.40.5 and run the live smoke test locally before handing over.
- **The JSVM proves unworkable.** Per the handover, stop and report before switching to an SDK-based server.
