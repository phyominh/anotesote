# study-kb-mcp

A personal study knowledge base that Claude uses through a custom MCP connector. Everything runs inside one PocketBase binary: the MCP endpoint is a JS hook, and there is no separate server process, Docker or Node runtime on the server.

Claude uses it to:

- save knowledge as atomic flashcard-style **cards** filed under **topic** paths;
- **grade** every exercise or drill, which drives SM-2 spaced repetition and mastery scores;
- fetch **due cards**, weak topics and progress for flashcard and speaking skills;
- draw **mind maps and flow graphs** (Mermaid or JSON), coloured by mastery.

The full spec is [`HANDOVER.md`](HANDOVER.md). [`docs/design.md`](docs/design.md) records the decisions made on top of it.

| | |
|---|---|
| PocketBase | **v0.40.5** (pinned in `scripts/install.sh`) |
| Endpoint | `https://ans.mhetsu.com/mcp/<SECRET>` |
| Admin UI | `https://ans.mhetsu.com/_/` |
| Projects | `english`, `japanese`, `maths`, `dsa` |

## Layout

```
pb_hooks/mcp.pb.js        routes: POST/GET/DELETE /mcp/{secret}
pb_hooks/lib/rpc.js       JSON-RPC / MCP transport (stateless JSON mode)
pb_hooks/lib/tools.js     the 11 tools: definitions + handlers
pb_hooks/lib/topics.js    topic paths, upsert, move/rename, mastery recompute
pb_hooks/lib/srs.js       SM-2 scheduling (pure)
pb_hooks/lib/mastery.js   EMA, topic blend, read-time rollup (pure)
pb_hooks/lib/graph.js     graph assembly + Mermaid rendering (pure)
pb_hooks/lib/schema.js    tool input validation (pure)
pb_hooks/lib/util.js      shared helpers
pb_migrations/            topics, cards, reviews, links, backup + rate-limit settings
deploy/                   systemd unit, nginx site template, env example, Caddy snippet
scripts/install.sh        install / upgrade on the VPS
scripts/smoke-test.sh     live acceptance test (curl + jq)
test/                     Node unit tests for the pure modules
```

## Install on the VPS

On the Debian VPS, as root, from a checkout of this repo:

```sh
git clone https://github.com/phyominh/anotesote.git && cd anotesote
sudo scripts/install.sh --nginx     # nginx already handles HTTPS on this VPS
```

Before running it, point a DNS `A` record for `ans.mhetsu.com` at the VPS so the certificate can be issued. The script:

1. checks that the ports it needs are free (in standalone mode it refuses to run if anything already holds 80/443);
2. creates the `pocketbase` system user and `/opt/pocketbase`;
3. downloads the official v0.40.5 release and verifies its checksum;
4. copies `pb_hooks/` and `pb_migrations/`;
5. creates `/etc/pocketbase/env` (root, mode 600) with a random `MCP_SECRET`, or keeps the existing one;
6. installs and starts the systemd unit, with PocketBase listening only on `127.0.0.1:8090`;
7. with `--nginx`: writes `/etc/nginx/sites-available/ans.mhetsu.com.conf` from [`deploy/nginx.conf`](deploy/nginx.conf) (it keeps an existing file), enables it, runs `nginx -t` and reloads nginx, then runs `certbot --nginx -d ans.mhetsu.com` if certbot is installed.

The nginx site turns off the access and error logs for `/mcp/`, because the URL contains the secret. If you write your own proxy config, do the same.

| Mode | Use when |
|---|---|
| `--nginx` | nginx already serves HTTPS on the VPS (this setup) |
| `--proxy` | another reverse proxy (Caddy, Traefik…) that you configure yourself: proxy `ans.mhetsu.com` to `127.0.0.1:8090` |
| no flag | nothing else uses ports 80/443: PocketBase gets its own Let's Encrypt certificate (opens 80/443 in `ufw` if active) |

Behind a proxy, set the admin UI's **Settings → Application → User IP proxy headers** to `X-Real-IP`, so rate limiting and logs see real client IPs rather than `127.0.0.1`.

Migrations run automatically when the service starts. Then create the superuser. Either open the one-time installer link PocketBase prints on start while no superuser exists: `sudo journalctl -u pocketbase --no-pager | grep pbinstall | tail -1`. It expires after about 30 minutes (run `sudo systemctl restart pocketbase` for a new one). Behind nginx it starts with `http://127.0.0.1:8090`, so open it as `https://ans.mhetsu.com/_/#/pbinstall/...`. Or run:

```sh
 sudo -u pocketbase /opt/pocketbase/pocketbase superuser upsert <email> <password> --dir=/opt/pocketbase/pb_data
```

(The leading space keeps the password out of shell history.) Sign in at `/_/` and **enable MFA** for the superuser.

## Connect Claude

1. Get the URL: `https://ans.mhetsu.com/mcp/` followed by the value in `sudo cat /etc/pocketbase/env`. Treat it like a password: keep it out of git, chats, screenshots and shell history.
2. In Claude, go to **Settings → Connectors → Add custom connector**. Paste the URL and leave OAuth empty.
3. Enable the connector in the relevant chats and projects.
4. Add this to each study project's instructions, changing the project name:

   > Use the study-kb connector with project=`japanese`. Save new knowledge as atomic cards under sensible topic paths. After every exercise or drill, call record_reviews with grades. When I ask for a map of what I know, call get_graph and draw it.

## Tools

| Tool | Purpose |
|---|---|
| `upsert_topic` | Create a topic path (and its ancestors), update description/order, move or rename with `new_path`, or `delete` if empty |
| `list_topics` | Flat topic list with `mastery`, `rolled_mastery`, card and due counts. `sort: mastery_asc` finds weak topics |
| `save_cards` | 1-50 atomic cards in one transaction. A duplicate front in the same topic fails the whole batch |
| `search_cards` | Text, topic (with subtopics), kind, tag and mastery filters, paginated |
| `get_cards` | Full cards with SRS state and their last 5 reviews |
| `update_card` | Edit content, tags, topic or suspension; merge `meta`; `reset_progress`; `delete` |
| `get_due_cards` | Due queue (oldest due first) plus up to `new_limit` never-reviewed cards |
| `record_reviews` | 1-100 grades per card and/or topic (grade 1-4, or a score 0-100) |
| `get_progress` | Reviews per day, grades per exercise, weakest topics, most-lapsed cards, due forecast, one session |
| `link` | Typed card→card or topic→topic edge; `remove: true` deletes it |
| `get_graph` | `mindmap`, `flow` or `full` graph as JSON and/or Mermaid |

## Development

The pure modules (`srs`, `mastery`, `graph`, `schema`) have Node unit tests with no dependencies:

```sh
npm test
```

To run the live test against a local server:

```sh
go install github.com/pocketbase/pocketbase/examples/base@v0.40.5   # or download the release binary
export MCP_SECRET=$(openssl rand -hex 32)
~/go/bin/base serve --http=127.0.0.1:8090 --dir=./pb_data   # from the repo root
BASE=http://127.0.0.1:8090 SECRET=$MCP_SECRET scripts/smoke-test.sh
```

The smoke test works under a random root topic (`smoke-xxxxxx`) in the `dsa` and `japanese` projects and deletes everything it created, so it is also safe to run against production. You can also explore the endpoint with `npx @modelcontextprotocol/inspector`.

## Operations

**Upgrading PocketBase.** Read the [changelog](https://github.com/pocketbase/pocketbase/blob/master/CHANGELOG.md) for JSVM changes, then `git pull && sudo scripts/install.sh --version <new>`, then run the smoke test. Update `PB_VERSION` in `scripts/install.sh` once it passes.

**Deploying hook changes.** Run `git pull && sudo scripts/install.sh` again. It is idempotent and keeps the data and the secret.

**Rotating the secret.** Edit `/etc/pocketbase/env` (for example `MCP_SECRET=$(openssl rand -hex 32)`), run `sudo systemctl restart pocketbase`, then update the connector URL in Claude.

**Adding a project.** Add the new value to the `project` select field in **all four** collections, `topics`, `cards`, `reviews` and `links`, either in the admin UI or with a new migration. The tool enums are read from the `topics` field on every request, so no hook change or restart is needed.

**Browsing and editing data.** Use `https://ans.mhetsu.com/_/`. All collections are superuser-only and the public REST API exposes nothing.

**Backups.** A local backup runs nightly at 03:00 server time and the last 7 are kept, in `pb_data/backups`. Add S3 storage in the admin UI (Settings → Backups) when you want off-box copies. **Restore** from the admin UI → Backups.

**Logs.** `journalctl -u pocketbase -f`. The hook logs one line per tool call (tool, ok, item count, duration) and never logs the secret, the URL or card content.

**Rate limiting.** PocketBase's built-in limiter is on, with an extra rule of 300 requests per 10 seconds for `/mcp/` (the same as its default for `/api/`).

## Security

- Auth is a bearer secret in the URL path. If the secret is unset, every request is rejected. A wrong secret gets an empty 404.
- The MCP route skips PocketBase's request log, so the secret never reaches the logs database.
- Every collection's API rules are `null` (superuser only). The hook uses `$app` directly.
- Protect the admin UI with a strong password and MFA.

## License

MIT. See [`LICENSE`](LICENSE).
