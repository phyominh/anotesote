# Design: study-kb MCP (PocketBase)

Status: draft for review · 2026-10-18

`HANDOVER.md` is the base spec. This file records the decisions made in brainstorming and the points where the build deliberately deviates from or refines the handover. Where the two disagree, this file wins.

## Decisions (answers to handover §2)

| Question | Answer |
|---|---|
| Domain | `ans.mhetsu.com`. Endpoint: `https://ans.mhetsu.com/mcp/<SECRET>` |
| Caddy | Not present → **option B**: PocketBase serves `ans.mhetsu.com` directly with Let's Encrypt on ports 80/443 |
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

Everything else follows the handover as written: architecture, auth, transport, the 11 tools, schema, SM-2, mastery, graph output, logging, security notes and out-of-scope items.

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
