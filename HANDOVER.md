# Handover: Study Knowledge Base MCP (PocketBase + custom Claude connector) — v2

> **v2 changes from v1.** A single `notes` collection is replaced by four collections:
> - **cards** are modular, flashcard-style notes.
> - **topics** form a hierarchy that drives the mind map.
> - **reviews** is a grading log, with spaced repetition and mastery tracked per card and per topic.
> - **links** are typed edges between cards or topics, used for flow graphs.
>
> A `get_graph` tool returns graph JSON or Mermaid. Everything else from v1 stays the same: the architecture, auth, deployment and the constraint of fewest moving parts.

## 1. Goal

Run a single PocketBase instance on Marcus's existing VPS (Debian, 2 vCPU / 4 GB). Expose an **MCP endpoint** that Marcus adds to Claude (claude.ai) as a custom connector.

Marcus has several study projects in Claude (English, Japanese, Maths, DSA, …). Claude will use the connector to:

1. **Save knowledge as atomic cards.** Each card holds one fact, word, concept, pattern or mistake, filed under a topic.
2. **Grade after every exercise or drill**, at card level, topic level, or both. Gradings drive spaced repetition and mastery scores.
3. **Fetch** due cards, weak topics and history, to feed skills such as flashcards and speaking practice. The skills themselves are out of scope.
4. **Build mind maps and flow graphs** of the knowledge, coloured by mastery.

### Guiding constraint: fewest moving parts

- The server is one binary (PocketBase) with one systemd unit, one hook file (plus one `require`d helper module if needed) and versioned migrations.
- There is no Docker, no separate MCP server process and no Node or Python runtime on the server.
- The MCP endpoint lives **inside PocketBase** as a JS hook. It speaks MCP Streamable HTTP in stateless JSON mode.
- All derived values (SRS scheduling, mastery, topic paths) are computed **in the hook at write time**. No cron jobs, no background workers.
- If the PocketBase JSVM proves unworkable for this, stop and tell Marcus before switching to a separate SDK-based server.

## 2. Ask Marcus before starting

Ask these up front, in one batch:

1. **Domain:** which domain or subdomain the endpoint should use, and whether DNS already points at the VPS.
2. **Caddy:** is Caddy already running on this VPS? If so, use option A in §6; if not, use option B.
3. **SSH access:** how to connect, and whether you should run commands directly or give him a script to run.
4. **Projects:** the initial list for the `project` select field. The default is `english, japanese, maths, dsa`.
5. **Backups:** should off-box backups go to S3-compatible storage now, or stay local-only for the time being?
6. **Existing v1 data:** has v1 (the `notes` collection) already been deployed with data in it? If so, include the migration in §7.6.

## 3. Architecture

```
Claude (Anthropic cloud) ──HTTPS POST──► https://<domain>/mcp/<SECRET>
                                              │
                               PocketBase (systemd, user `pocketbase`)
                                ├── pb_hooks/mcp.pb.js     ← MCP JSON-RPC router
                                ├── pb_hooks/lib/*.js      ← helpers (srs, mastery, graph) via require()
                                ├── pb_migrations/*.js     ← schema (topics, cards, reviews, links)
                                ├── /_/                    ← admin UI (superuser only)
                                └── pb_data/               ← SQLite + backups
```

- **The endpoint must be reachable from the public internet.** Claude's connector calls originate from Anthropic's servers, so a Tailscale-only address will not work.
- **All collection API rules stay locked to superusers.** The public REST API exposes nothing. The hook uses `$app` directly, which bypasses collection rules.

### Data model at a glance

```
project (select value, not a collection)
   └── topics (tree via parent, unique path per project)  ← mind-map backbone, mastery rollup
         └── cards (atomic notes, SRS state, mastery)      ← flashcard units
reviews  → card? + topic   (append-only grading log)       ← history, drills, analytics
links    → card↔card or topic↔topic (typed edges)          ← flow / prerequisite / related graphs
```

## 4. Repo layout

```
study-kb-mcp/
├── HANDOVER.md
├── README.md
├── pb_hooks/
│   ├── mcp.pb.js                 # routes + JSON-RPC dispatch
│   └── lib/
│       ├── tools.js              # tool definitions + handlers
│       ├── topics.js             # path resolution, upsert, move/rename
│       ├── srs.js                # SM-2 scheduling (pure functions)
│       ├── mastery.js            # EMA + topic recompute
│       └── graph.js              # node/edge assembly + Mermaid rendering
├── pb_migrations/
│   ├── 1760000000_create_topics.js
│   ├── 1760000001_create_cards.js
│   ├── 1760000002_create_reviews.js
│   ├── 1760000003_create_links.js
│   └── 1760000004_backup_settings.js   # optional, see §7.5
├── deploy/
│   ├── pocketbase.service
│   ├── env.example
│   └── Caddyfile.snippet
└── scripts/
    ├── install.sh
    └── smoke-test.sh
```

On the server, the layout is `/opt/pocketbase/{pocketbase,pb_hooks/,pb_migrations/,pb_data/}`, owned by the `pocketbase` user.

Keep `srs.js` and `mastery.js` as **pure functions** (input state → output state). Then they can be unit-tested locally with plain Node before deployment. They must stay goja-compatible: no Node-only APIs.

## 5. PocketBase version and API caveat

- **Pin the latest stable release.** Record its version in `install.sh` and in the README.
- **The JS in this document is indicative only.** Before writing any code, read the JSVM docs for the pinned version, starting at https://pocketbase.io/docs/js-overview/. Read the pages on routing, records, collections, migrations, database queries and settings. Trust the docs over this file.
- **Known gotchas:**
  - **Handlers run in isolated contexts.** Top-level helpers in a hook file may not be visible inside `routerAdd` callbacks. Put helpers in `pb_hooks/lib/` and `require()` them *inside* the handler. Use `__hooks` for the path if the docs say so.
  - **The JSVM is goja, not Node.** There is no npm and no `fetch`.
  - **Secrets come from the environment.** Use `$os.getenv("MCP_SECRET")`.
  - **Wrap multi-record writes in a transaction.** Use `$app.runInTransaction(txApp => …)` (check the exact name in the docs) and do all reads and writes through `txApp` inside it.

## 6. Server setup (unchanged from v1)

### 6.1 Install steps

1. Create a system user:
   ```
   useradd --system --home /opt/pocketbase --shell /usr/sbin/nologin pocketbase
   ```
2. Download the pinned release zip and unzip the binary to `/opt/pocketbase/pocketbase`.
3. Copy `pb_hooks/` and `pb_migrations/` into `/opt/pocketbase/`.
4. Create `/etc/pocketbase/env`, mode 600 and root-owned, containing `MCP_SECRET=<openssl rand -hex 32>`. **Never commit this file.**
5. Create the superuser:
   ```
   sudo -u pocketbase /opt/pocketbase/pocketbase superuser upsert <email> <password>
   ```
   Marcus sets the password himself.
6. Install and enable the systemd unit.

### 6.2 systemd unit

```ini
[Unit]
Description=PocketBase (study KB + MCP)
After=network-online.target
Wants=network-online.target

[Service]
User=pocketbase
Group=pocketbase
WorkingDirectory=/opt/pocketbase
EnvironmentFile=/etc/pocketbase/env
ExecStart=/opt/pocketbase/pocketbase serve <SERVE_ARGS>
Restart=on-failure
RestartSec=5
LimitNOFILE=4096
# Option B only:
# AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

### 6.3 TLS: pick one

- **Option A (Caddy already present).**
  - Set `SERVE_ARGS` to `--http=127.0.0.1:8090`.
  - Add `<domain> { reverse_proxy 127.0.0.1:8090 }` to the Caddyfile.
- **Option B (no Caddy).**
  - Set `SERVE_ARGS` to `<domain>`. PocketBase then handles Let's Encrypt itself on ports 80 and 443.
  - Uncomment the `AmbientCapabilities` line in the unit.
  - Open ports 80 and 443 in the firewall.

Do not install Caddy just for this.

## 7. Schema (migrations)

**Rules that apply to all collections:**

- Each collection is a **base** collection with every API rule set to `null`, so only superusers can access it.
- Each has `created` and `updated` autodate fields.
- **Write one migration per collection,** in the order listed, and give each a down migration that deletes its collection.
- **Use the same `project` select values** in `topics`, `cards` and `reviews`. They come from §2 Q4.
  - The hook reads the allowed values from the `topics.project` field at request time.
  - When Marcus adds a project, he should add it in all three collections (admin UI or a new migration). The README must say this.

### 7.1 `topics`: hierarchy and mind-map nodes

| Field | Type | Notes |
|---|---|---|
| `project` | select | required |
| `name` | text | required, max 120. Display name, e.g. "Particles" |
| `path` | text | required, max 500. Lowercase slug path maintained by hook, e.g. `grammar/particles` |
| `parent` | relation → topics (single) | optional; **cascadeDelete: false** (hook blocks deleting non-empty topics) |
| `description` | text | optional, max 2000 |
| `order` | number | optional; sibling ordering for maps |
| `mastery` | number | 0–1, computed by hook; default 0 |
| `self_mastery` | number | 0–1, EMA of topic-level grades only; default 0 |
| `review_count` | number | computed |
| `last_reviewed` | date | computed |

**Indexes:**
- **Unique** on `(project, path)`.
- Plain index on `(project, parent)`.

**How paths work.** The `path` is derived from the slugified names, joined with `/`, from the root down to the topic. The slug is lowercase, with spaces turned into `-`. Non-ASCII characters are kept, so Japanese topic names are fine. Callers refer to topics by `topic_path`, so Claude rarely needs IDs.

### 7.2 `cards`: atomic notes and flashcard units

| Field | Type | Notes |
|---|---|---|
| `project` | select | required; must equal the topic's project (hook enforces) |
| `topic` | relation → topics (single) | required; **cascadeDelete: false** |
| `kind` | text | required, max 50: `vocab`, `phrase`, `grammar`, `concept`, `formula`, `pattern`, `mistake`, `problem`, `example`, … |
| `front` | text | required, max 500 — prompt side (word, question, concept name) |
| `back` | text | required, max 10000 — answer/explanation (Markdown) |
| `extra` | text | optional, max 10000 — examples, mnemonics, context |
| `tags` | json | optional array of lowercase strings, ~5 KB |
| `meta` | json | optional free-form for skills (readings, audio refs, difficulty, source), ~50 KB |
| `suspended` | bool | default false; excluded from due queues |
| **SRS state** (hook-managed) | | |
| `due` | date | when next due; null = new (never reviewed) |
| `interval_days` | number | default 0 |
| `ease` | number | default 2.5 |
| `reps` | number | consecutive successful reviews, default 0 |
| `lapses` | number | default 0 |
| `last_grade` | number | 1–4, default 0 |
| `last_reviewed` | date | |
| `mastery` | number | 0–1 EMA of normalised grades, default 0 |

**Indexes:**
- `(project, due)`
- `(topic)`
- `(project, kind)`
- `(project, mastery)`

**Atomicity rule.** Put this in the `save_cards` tool description and in the server `instructions`: *one card = one retrievable idea*. A long note should be split into several cards under the same topic, connected by `links` where the order or relationship matters.

### 7.3 `reviews`: append-only grading log

| Field | Type | Notes |
|---|---|---|
| `project` | select | required |
| `topic` | relation → topics | required; for card reviews, the hook sets it to the card's topic |
| `card` | relation → cards | optional; empty = topic-level grade (e.g. a speaking drill on a topic) |
| `exercise` | text | required, max 50: `flashcard`, `drill`, `quiz`, `speaking`, `writing`, `problem`, … |
| `session` | text | optional, max 100; caller-supplied ID grouping one exercise run |
| `grade` | number | required, integer 1–4: 1 again/fail, 2 hard, 3 good, 4 easy |
| `score` | number | optional raw score 0–100 (e.g. 7/10 → 70), stored for analytics only |
| `comment` | text | optional, max 2000; what went wrong or right |
| `created` | autodate | |

Set the `card` and `topic` relations to **cascadeDelete: true**, so deleting a card removes its history.

**Indexes:**
- `(topic, created)`
- `(card, created)`
- `(project, created)`
- `(session)`

**Grade semantics.** The normalised grade is `g = (grade - 1) / 3`, mapping 1→0, 2→0.33, 3→0.67, 4→1. Drills that produce a percentage should map it to a grade:

| Score | Grade |
|---|---|
| below 50 | 1 |
| 50–69 | 2 |
| 70–89 | 3 |
| 90 and above | 4 |

The hook does this mapping when only `score` is given.

### 7.4 `links`: typed graph edges

| Field | Type | Notes |
|---|---|---|
| `project` | select | required |
| `type` | select | required: `related`, `prerequisite`, `leads_to`, `example_of`, `contrasts`, `part_of`, `confused_with` |
| `from_card` / `to_card` | relation → cards | optional, **cascadeDelete: true** |
| `from_topic` / `to_topic` | relation → topics | optional, **cascadeDelete: true** |
| `label` | text | optional, max 200; edge label for flow graphs (e.g. "use when sorted") |

**Validation (hook-enforced).** Exactly one pair must be set: card→card **or** topic→topic. Self-links are rejected. Both ends must be in the same project.

**Indexes:**
- `(from_card)`
- `(to_card)`
- `(from_topic)`
- `(to_topic)`

**Directed vs undirected types.**
- These are **directed**, since they express an order or dependency: `prerequisite` (from must be learned before to), `leads_to` (sequence or flow step), `example_of` and `part_of`.
- These are **undirected**: `related`, `contrasts` and `confused_with`. Store a single row for each. Treat the edge as symmetric when querying, and dedupe in `link` by checking both directions.

### 7.5 Backups (optional migration)

Enable scheduled backups through app settings: cron `0 3 * * *`, keep the last 7. Verify the settings API for the pinned version first. S3 credentials are set in the admin UI only, never in a migration.

### 7.6 v1 data migration (only if §2 Q6 says yes)

Run this as a migration:

1. For each distinct `notes.project`, create the root topic `inbox`.
2. Under it, create one child topic per distinct `kind`.
3. Convert each note into a card:

| v1 field | v2 field |
|---|---|
| `title` | `front` |
| `body` | `back` |
| `tags`, `meta` | copied as-is |
| (none) | SRS fields left at their defaults |

Keep the `notes` collection; Marcus deletes it manually after checking the result.

## 8. MCP endpoint

### 8.1 Transport (unchanged from v1)

**Routes and responses**
- `POST /mcp/{secret}` is the only working route.
- GET and DELETE return **405**.
- A wrong secret returns **404** with an empty body.

**Secret check.** Compare against `$os.getenv("MCP_SECRET")`. If the variable is empty, reject everything (fail closed).

**Request body.** Accept a single JSON-RPC 2.0 message or a batch array.

**Responses.** Reply with `Content-Type: application/json`.
- Do no session handling. Never send `Mcp-Session-Id`, and ignore it if received.
- A notification (no `id`) gets **HTTP 202** with an empty body.
- A parse error returns `-32700` with `id: null`.

### 8.2 Methods

- **`initialize`** echoes the client's `protocolVersion`. Check the current spec at https://modelcontextprotocol.io/specification to see whether a fixed supported version should be returned instead. The other fields are:
  - `capabilities: { tools: {} }`
  - `serverInfo: { name: "study-kb", version: "2.0.0" }`
  - `instructions`, which should say:
    > Personal study knowledge base. Store knowledge as atomic cards (one idea per card) filed under topic paths like "grammar/particles". Search before saving to avoid duplicates; prefer update_card. After every exercise or drill, call record_reviews with a grade per card and/or per topic. Use links to capture prerequisites, sequences and confusions. Use get_graph to draw mind maps (tree) or flow graphs (links).
- **`ping`** returns `{}`.
- **`tools/list`** returns the tools in §8.3.
- **`tools/call`** dispatches to the named tool.
- **Any other method** returns `-32601`.

### 8.3 Tools (11)

**General rules**
- **Enums are built at request time** from the schema.
  - `project` comes from the `topics.project` select values.
  - `link type` comes from the `links.type` values.
- **Every `inputSchema`** uses `additionalProperties: false`, and every tool has a one-line description aimed at Claude.
- **Filters always use bound `{:param}` placeholders.** Never concatenate input into a filter string.
- **Topic references.** Wherever a topic is referenced, accept either `topic_id` or `topic_path`, plus `project`. A `topic_path` is resolved by slugifying each segment.

**Return shapes**
- Successful tool calls return:
  ```json
  { "content": [ { "type": "text", "text": "<JSON.stringify(result)>" } ] }
  ```
- Tool-level failures (validation, not found, conflicts) return:
  ```json
  { "content": [ { "type": "text", "text": "<clear message>" } ], "isError": true }
  ```
- Protocol problems return JSON-RPC errors:

| Problem | Code |
|---|---|
| Unknown tool | `-32601` |
| Malformed params | `-32602` |

- **Every batch tool runs in one transaction.** If any item fails, nothing is written. The error reports the failing item's index and reason.

**Topics**

1. **`upsert_topic`**
   - **Inputs:**
     - `project`
     - `path` (e.g. `"DSA/Graphs/Shortest Path"`)
     - `description?`
     - `order?`
     - `new_path?` (rename or move)
   - **Behaviour:** creates any missing ancestors, with display names taken from the original casing of each segment. With `new_path`, it moves or renames the topic and rewrites `path` for the topic and all its descendants. If the target path already exists, the call fails.
   - **Returns:** the topic.
2. **`list_topics`**
   - **Inputs:**
     - `project`
     - `root_path?`
     - `depth?` (default unlimited)
     - `sort?` (`path` default | `mastery_asc` | `last_reviewed_asc`)
     - `limit?` (default 200)
   - **Returns:** a flat list. Each item is `{id, path, name, parent, mastery, rolled_mastery, card_count, due_count, review_count, last_reviewed}`.
   - **`rolled_mastery`** is the card-count-weighted mean over the topic and its descendants, computed at read time.
   - **`mastery_asc`** sorting is how skills find weak topics.

**Cards**

3. **`save_cards`** (batch, 1–50)
   - **Inputs:** `project`, plus default `topic_path`/`topic_id`, plus `cards: [{front, back, kind, extra?, tags?, meta?, topic_path?}]`. Each card may override the default topic. A missing topic path is auto-created.
   - **Duplicate check:** if a card with the same `project` + `topic` + case-insensitive trimmed `front` exists, that item fails with `duplicate` and the existing id. The caller should use `update_card` instead.
   - **Returns:** the created cards (ids and fronts).
4. **`search_cards`**
   - **Inputs:**
     - `project?`
     - `topic_path?`/`topic_id?`
     - `include_subtopics?` (default true)
     - `kind?`
     - `tag?`
     - `query?` (matches `front ~ q || back ~ q || extra ~ q`)
     - `max_mastery?`
     - `limit?` (20, max 100)
     - `offset?`
     - `sort?` (`-updated` | `mastery` | `due` | `-created`)
   - **Returns:** `{items, total, limit, offset}`. Each item is a compact card: `back` is truncated to 300 chars and `extra` is omitted. `truncated` is set to true when cut.
   - **Subtopics** are matched by path prefix: `topic.path = p || topic.path ~ 'p/%'`. Use a proper prefix match; check how PocketBase filter `~` handles wildcards.
5. **`get_cards`**
   - **Inputs:** `ids` (1–50).
   - **Returns:** full cards, including SRS state, the topic path, and the last 5 reviews for each card.
6. **`update_card`**
   - **Inputs:** `id`, plus any of:
     - `front`
     - `back`
     - `extra`
     - `kind`
     - `tags`
     - `suspended`
     - `topic_path`/`topic_id` (moves the card)
     - `meta`
   - **`meta` is shallow-merged.** A key set to `null` deletes that key.
   - **Not editable:** the SRS fields.
   - **`reset_progress: true`** resets the SRS fields and mastery to their defaults.

**Grading and practice**

7. **`get_due_cards`**
   - **Inputs:**
     - `project`
     - `topic_path?` (includes subtopics)
     - `limit?` (20, max 100)
     - `new_limit?` (default 10)
     - `kind?`
   - **Returns:** due cards (`due <= now`, not suspended), sorted by `due` ascending, then `mastery` ascending. After those come up to `new_limit` new cards (`due` empty), oldest first.
   - **Response shape:** `{due: [...], new: [...], counts: {due_total, new_total}}`. Each item includes `front`, `back`, `extra`, `kind`, `topic path` and `meta`.
8. **`record_reviews`** (batch, 1–100): the grading entry point after every exercise or drill.
   - **Inputs:**
     - `project`
     - `exercise`
     - `session?`
     - `items: [{card_id? | topic_path? | topic_id?, grade?, score?, comment?}]`, where each item needs a card or a topic, and a grade or a score
   - **For each item:**
     1. If only `score` is given, derive `grade` using the table in §7.3. Clamp the grade to an integer from 1 to 4.
     2. Insert a `reviews` row. For a card, set `topic` to the card's topic.
     3. **Card item:**
        - Apply SM-2 (§8.4) to the card.
        - Update the card's `mastery` EMA, `last_grade` and `last_reviewed`.
     4. **Topic-only item:**
        - Update the topic's `self_mastery` EMA.
     5. Mark the topic dirty.
   - **After all items:** recompute `mastery`, `review_count` and `last_reviewed` once for each dirty topic (§8.5).
   - **Returns:** for each card, `{card_id, grade, next_due, interval_days, mastery}`, plus `{topic_path, mastery}` for each affected topic and a session summary `{count, avg_grade}`.
9. **`get_progress`**
   - **Inputs:**
     - `project`
     - `topic_path?`
     - `days?` (default 30)
     - `session?`
   - **Returns:**
     - review counts per day
     - average grade per exercise type
     - the 10 weakest topics by `mastery`, considering only topics with at least one review
     - the 10 most-lapsed cards
     - due counts for today, the next 7 days and the next 30 days
     - when `session` is given, that session's reviews

**Graph**

10. **`link`**
    - **Inputs:**
      - `project`
      - `type`
      - `label?`
      - either `from_card_id` and `to_card_id`, or `from_topic` and `to_topic` (each given as an id or a path)
      - `remove?` (default false)
    - **Validation:** follows §7.4.
    - **Duplicates:** an existing identical link (in either direction for undirected types) is a no-op and returns that link.
    - **`remove: true`** deletes the matching link instead of creating one.
11. **`get_graph`**
    - **Inputs:**
      - `project`
      - `root_path?`
      - `depth?` (default 3)
      - `include_cards?` (default false)
      - `link_types?` (default all)
      - `mode?`: `mindmap` (tree only) | `flow` (topics or cards and their typed links) | `full` (tree plus links). Default `full`.
      - `format?`: `json` | `mermaid` | `both`. Default `both`.
      - `max_nodes?` (default 150, hard max 400)
    - **JSON output:**
      ```
      {nodes: [{id, kind: "topic"|"card", label, path, mastery, due_count?}],
       edges: [{from, to, type: "child"|"contains"|<link type>, label?}],
       truncated, stats}
      ```
      Include link edges only when both endpoints are within the selected node set. When `include_cards` is set, add each card as a node with a `contains` edge from its topic.
    - **Mermaid output:**
      - **`mindmap` mode:** render a Mermaid `mindmap` with the topic tree (cards as leaves if included). Put a mastery hint in each label, e.g. `Particles (62%)`.
      - **`flow` and `full` modes:** render a `flowchart LR`.
        - **Node ids:** use sanitised ids like `t_<id>` and `c_<id>`, with labels quoted and escaped. Japanese text must survive.
        - **Mastery classes:**
          - `classDef weak` for mastery below 0.4
          - `classDef ok` for 0.4 to below 0.75
          - `classDef strong` for 0.75 and above
          - `classDef new` for nodes with no reviews
        - **Edge styles:**

          | Edge type | Mermaid |
          |---|---|
          | tree edges | `---` |
          | `prerequisite` and `leads_to` | `-->` with the label |
          | `related` | `-.-` |
          | `contrasts` and `confused_with` | `-. label .-` |
    - **Truncation:** when the graph would exceed `max_nodes`, it is cut breadth-first from the root, with `truncated: true`.
    - **Rendering:** Claude can draw either output inline in chat (Mermaid, or a custom visual from the JSON).

### 8.4 SRS algorithm (SM-2 variant, `lib/srs.js`, pure)

**Input:** the card's state `{interval_days, ease, reps, lapses}`, plus `grade` and `now`. **Output:** the new state plus `due`.

```
ease defaults 2.5, floor 1.3
grade 1 (again): lapses += 1; reps = 0; ease -= 0.20; interval_days = 0; due = now + 10 minutes
grade 2 (hard):  ease -= 0.15; reps += 1; interval = reps==1 ? 1 : max(1, round(interval * 1.2))
grade 3 (good):  reps += 1; interval = reps==1 ? 1 : reps==2 ? 3 : round(interval * ease)
grade 4 (easy):  ease += 0.15; reps += 1; interval = reps==1 ? 3 : reps==2 ? 6 : round(interval * ease * 1.3)
cap interval at 365 days; due = now + interval days (for grades 2–4)
```

**Same-day reviews.** When a card is graded several times in one session, every review is logged, but only the first review that day advances `reps` and `interval`. Later reviews that day only update `due` if the grade is 1, and always update `mastery`. To implement this, compare `last_reviewed` against the start of the current day in Asia/Tokyo (UTC+9).

**Keep the algorithm swappable.** It sits behind one function, so it can be replaced with FSRS later without a schema change.

### 8.5 Mastery (`lib/mastery.js`)

**Card mastery** is an exponential moving average of the normalised grade `g = (grade-1)/3`:
- `m = reps_total == 0 ? g : m + 0.3 * (g - m)`
- A card with no reviews has mastery 0 and counts as "new" in graphs.

**Topic `self_mastery`** uses the same EMA, applied to topic-level grades only.

**Topic `mastery`** is recomputed with a single SQL aggregate over that topic's **direct** cards:
- `card_avg` is the average mastery of the cards that have at least one review. Cards never reviewed are excluded.
- If both `card_avg` and `self_mastery` exist, `mastery = 0.7 * card_avg + 0.3 * self_mastery`.
- If only one of them exists, `mastery` is that value. If neither exists, it is 0.

**Ancestors are not stored.** The rollup to parent topics (`rolled_mastery`) is computed at read time in `list_topics` and `get_graph`. This avoids cascading writes.

**Decay is out of scope for now.** `get_progress` and `get_due_cards` already surface stale items through `due`.

### 8.6 Delete tool behaviour (fold into existing tools; no separate delete tool)

- **`update_card` with `delete: true`** deletes the card. Its reviews and links cascade.
- **`upsert_topic` with `delete: true`** deletes the topic, but only if it has no cards and no child topics. Otherwise it fails with the counts.
- **Links** are removed with `link` and `remove: true`.

### 8.7 Logging

Log one line per `tools/call`: the tool name, ok or error, item count and duration. **Never log the secret, the URL path, or any card content.**

## 9. Acceptance tests (`scripts/smoke-test.sh` + local unit tests)

### 9.1 Local unit tests

Run these with plain Node, with no server.

- **`srs.js`:**
  - A new card graded 3 three times gives intervals of 1, 3 and about 8 days.
  - Grade 1 resets `reps` and increments `lapses`.
  - `ease` never drops below 1.3.
  - Intervals are capped at 365 days.
  - On a same-day repeat, only the first review advances the interval.
- **`mastery.js`:** check the EMA maths, the topic blend, and the edge cases where there are no cards or no topic-level grades.
- **Mermaid renderer:** confirm escaping of quotes, brackets and Japanese text, and confirm the class assignment.

### 9.2 Live tests against the server

The script uses `BASE` and `SECRET` from the environment and a throwaway project value such as `dsa`. It cleans up after itself.

1. **Protocol basics.**
   - `initialize` returns `serverInfo.name == "study-kb"`.
   - A notification gets 202.
   - `tools/list` returns 11 tools, with the `project` enum populated.
2. **Topic upsert.** `upsert_topic` with `DSA/Graphs/Shortest Path` creates 3 topics with paths `dsa/graphs/shortest-path`. Calling it again is idempotent.
3. **Saving cards.**
   - `save_cards` with 3 cards under that path succeeds.
   - Re-saving one of them with the same front fails with `duplicate` and writes nothing, because the batch is atomic.
4. **Japanese round-trip.** A card under `japanese` with topic path `文法/助詞` and front `は vs が` saves. `search_cards` with query `助詞` or `が` finds it.
5. **Due queue.** `get_due_cards` returns the 3 cards under `new`.
6. **Card grading.** `record_reviews` with grades 3, 1 and 4:
   - The grade-1 card is due in about 10 minutes and has `lapses` of 1.
   - The others are due in 1 and 3 days.
   - The topic's `mastery` is updated.
   - The response includes `next_due`.
7. **Topic-level grade.** `record_reviews` with only `topic_path` and `score: 85` stores grade 3 and changes `self_mastery`.
8. **Weak topics.** `list_topics` with `sort: mastery_asc` lists the topics, with `rolled_mastery` on `dsa/graphs`.
9. **Links.**
   - Create `link prerequisite` from `dsa/graphs/bfs` (create it first) to `dsa/graphs/shortest-path`.
   - Creating it again is a no-op.
   - A link from a card to a topic is rejected.
10. **Graph.**
    - `get_graph` with `mode: full` and `format: both` returns nodes including the three topics and an edge of type `prerequisite`.
    - The Mermaid output starts with `flowchart LR` and contains `classDef`.
    - `mode: mindmap` returns Mermaid starting with `mindmap`.
11. **Progress.** `get_progress` shows today's review count of at least 4.
12. **Card update.**
    - `update_card` with a `meta` merge works.
    - `reset_progress` resets the card's SRS fields.
    - `delete: true` also removes its reviews.
13. **Topic deletion.** Deleting a non-empty topic fails. Deleting an empty one succeeds.
14. **Security.**
    - A wrong secret gets 404.
    - A GET gets 405.
    - Unauthenticated `GET /api/collections/{topics,cards,reviews,links}/records` never returns data.
15. **Cleanup.** Remove all test data.

If Node is available on Marcus's machine, also run the MCP Inspector: `npx @modelcontextprotocol/inspector`.

## 10. Hand-off steps for Marcus (put these in the README)

1. In Claude, go to Settings → Connectors and add a custom connector. Paste `https://<domain>/mcp/<SECRET>` and leave OAuth empty.
2. Enable the connector in the relevant chats and projects.
3. Add a snippet like this to each study project's instructions, adjusting the project name:
   > Use the study-kb connector with project=`japanese`. Save new knowledge as atomic cards under sensible topic paths. After every exercise or drill, call record_reviews with grades. When I ask for a map of what I know, call get_graph and draw it.
4. Document these operations in the README:
   - **Upgrading:** replace the binary, read the changelog for JSVM changes, restart, then run the smoke test.
   - **Rotating the secret:** edit the env file, restart, then update the connector URL in Claude.
   - **Adding a project:** add the select value in `topics`, `cards`, `reviews` and `links`, via the admin UI or a migration.
   - **Browsing and editing data:** use `https://<domain>/_/`. Enable MFA for the superuser.
   - **Restoring:** use the admin UI → Backups.

## 11. Security notes

- **Auth is a bearer secret in the URL path,** which Marcus accepted for personal data.
  - Treat the URL like a password.
  - Keep it out of git, logs, screenshots and shell history.
- **Admin UI:** protect it with superuser credentials and MFA.
- **Rate limiting:** enable PocketBase's built-in rate limiting if the pinned version supports it.
- **Exposure:** no collection is public.

## 12. Out of scope

- The skills themselves: flashcards, speaking practice and drills. They consume `get_due_cards`, `record_reviews`, `get_progress` and `get_graph`.
- FSRS scheduling. The SM-2 implementation is swappable.
- Mastery decay over time.
- Embeddings and semantic search.
- OAuth.
- Multiple users.
- **A standalone web graph viewer.** This would be optional later: a static `pb_public/graph.html` reading a secret-protected JSON route, adding no new process. Do not build it now.

## 13. Definition of done

- [ ] PocketBase (pinned version) runs under systemd, survives a reboot and serves HTTPS on `<domain>`.
- [ ] The four collections are created by migrations, with indexes, cascade rules and locked API rules as specified. The v1 migration has been run if needed.
- [ ] The hook implements §8: 11 tools, transactional batches, SM-2, mastery, and graph JSON and Mermaid output. The secret is read from the environment and fails closed.
- [ ] The local unit tests (§9.1) and the live smoke test (§9.2) all pass.
- [ ] Scheduled backups are configured.
- [ ] The README is written and the repo committed, with no secrets in it.
- [ ] Marcus has received the connector URL privately.
