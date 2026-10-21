#!/usr/bin/env bash
# Live acceptance test for the study-kb MCP endpoint (HANDOVER §9.2).
#
#   BASE=https://ans.mhetsu.com SECRET=... scripts/smoke-test.sh
#
# To also run the full OAuth sign-in flow (step 16), pass the PocketBase admin
# credentials: ADMIN_EMAIL=... ADMIN_PASSWORD=... (and have openssl). Without
# them only the OAuth checks that need no sign-in run.
#
# Needs bash, curl and jq. Everything is created under a random root topic
# (smoke-XXXXXX) in the dsa and japanese projects, so real data is never
# touched, and it is all deleted at the end, even if a check fails.
set -uo pipefail

for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "smoke-test needs $bin: sudo apt-get install -y $bin" >&2; exit 2; }
done
: "${BASE:?set BASE, e.g. https://ans.mhetsu.com}"
: "${SECRET:?set SECRET}"
BASE="${BASE%/}"
URL="$BASE/mcp/$SECRET"
RUN="smoke-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6)"
SESSION="$RUN-session"
PASS=0
FAIL=0
ID=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

check() { # check "description" <command...>
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    green "  ok   $desc"
  else
    FAIL=$((FAIL + 1))
    red "  FAIL $desc"
  fi
}

post() { # post <json-body> → response body
  curl -sS -X POST "$URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data-binary "$1"
}

status() { # status <method> <url> [body] → HTTP status code
  if [ -n "${3:-}" ]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$1" "$2" -H 'Content-Type: application/json' --data-binary "$3"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$1" "$2"
  fi
}

# call <tool> <arguments-json> → sets $RES (parsed tool result or error text) and $ISERR
call() {
  ID=$((ID + 1))
  local body raw
  body=$(jq -cn --arg name "$1" --argjson args "$2" --argjson id "$ID" \
    '{jsonrpc: "2.0", id: $id, method: "tools/call", params: {name: $name, arguments: $args}}')
  raw=$(post "$body")
  if [ "$(jq -r '.error != null' <<<"$raw")" = "true" ]; then
    ISERR=rpc
    RES=$(jq -c '.error' <<<"$raw")
    return
  fi
  if [ "$(jq -r '.result.isError // false' <<<"$raw")" = "true" ]; then
    ISERR=true
    RES=$(jq -r '.result.content[0].text' <<<"$raw")
  else
    ISERR=false
    RES=$(jq -r '.result.content[0].text' <<<"$raw")
  fi
}

jqt() { jq -e "$@" <<<"$RES"; } # assert a jq expression on $RES
errhas() { [ "$ISERR" = true ] && grep -qF -- "$1" <<<"$RES"; } # tool error containing text
nodata() { [ "$1" != 200 ] || ! grep -qF '"items":[{' <<<"$2"; }

cleanup() {
  echo "cleanup"
  local project ids paths
  for project in dsa japanese; do
    call search_cards "$(jq -cn --arg p "$project" --arg t "$RUN" '{project: $p, topic_path: $t, limit: 100}')"
    if [ "$ISERR" = false ]; then
      ids=$(jq -r '.items[].id' <<<"$RES")
      for id in $ids; do call update_card "{\"id\":\"$id\",\"delete\":true}"; done
    fi
    call list_topics "$(jq -cn --arg p "$project" --arg t "$RUN" '{project: $p, root_path: $t, limit: 1000}')"
    if [ "$ISERR" = false ]; then
      # deepest first, so every topic is empty when deleted
      paths=$(jq -r '.items | sort_by(.path | split("/") | length) | reverse | .[].path' <<<"$RES")
      for p in $paths; do
        call upsert_topic "$(jq -cn --arg pr "$project" --arg p "$p" '{project: $pr, path: $p, delete: true}')"
      done
    fi
  done
  call list_topics "$(jq -cn --arg t "$RUN" '{project: "dsa", root_path: $t}')"
  check "cleanup removed all test topics" test "$ISERR" = true
}
trap cleanup EXIT

echo "study-kb smoke test against $BASE (run $RUN)"

echo "1. protocol basics"
RES=$(post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
check "initialize returns serverInfo.name study-kb" jqt '.result.serverInfo.name == "study-kb"'
check "initialize negotiates protocolVersion" jqt '.result.protocolVersion == "2025-06-18"'
check "initialize advertises tools" jqt '.result.capabilities.tools != null'
check "notification gets 202" test "$(status POST "$URL" '{"jsonrpc":"2.0","method":"notifications/initialized"}')" = 202
RES=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
check "tools/list returns 11 tools" jqt '.result.tools | length == 11'
check "project enum is populated" jqt '[.result.tools[] | select(.name == "save_cards") | .inputSchema.properties.project.enum[]] | index("dsa") != null'
check "every inputSchema forbids extra properties" jqt 'all(.result.tools[]; .inputSchema.additionalProperties == false)'
RES=$(post '{"jsonrpc":"2.0","id":3,"method":"ping"}')
check "ping returns {}" jqt '.result == {}'
RES=$(post '[{"jsonrpc":"2.0","id":4,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/x"},{"jsonrpc":"2.0","id":5,"method":"nope"}]')
check "batch returns one response per request" jqt 'length == 2 and .[0].id == 4 and .[1].error.code == -32601'
RES=$(post '{not json')
check "parse error is -32700 with id null" jqt '.error.code == -32700 and .id == null'
call no_such_tool '{}'
check "unknown tool is -32601" jqt '.code == -32601'
call list_topics '{"project":"dsa","bogus":1}'
check "malformed params is -32602" jqt '.code == -32602'

echo "2. topic upsert"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/Graphs/Shortest Path\"}"
check "upsert_topic succeeds" test "$ISERR" = false
check "slug path" jqt ".path == \"$RUN/graphs/shortest-path\" and .name == \"Shortest Path\" and .created == true"
call list_topics "{\"project\":\"dsa\",\"root_path\":\"$RUN\"}"
check "3 topics created" jqt '.total == 3'
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/Graphs/Shortest Path\"}"
check "repeat upsert is idempotent" jqt '.created == false'
call list_topics "{\"project\":\"dsa\",\"root_path\":\"$RUN\"}"
check "still 3 topics" jqt '.total == 3'

echo "3. saving cards"
SP="$RUN/graphs/shortest-path"
call save_cards "$(jq -cn --arg t "$SP" '{project: "dsa", topic_path: $t, cards: [
  {front: "Dijkstra", back: "Greedy single-source shortest paths, non-negative weights.", kind: "concept", tags: ["Graphs", "greedy"]},
  {front: "Bellman-Ford", back: "Relax all edges V-1 times; handles negative weights.", kind: "concept"},
  {front: "When does Dijkstra fail?", back: "With negative edge weights.", kind: "mistake", meta: {source: "lecture 7"}}]}')"
check "save_cards with 3 cards" jqt '.count == 3'
C1=$(jq -r '.created[0].id' <<<"$RES")
C2=$(jq -r '.created[1].id' <<<"$RES")
C3=$(jq -r '.created[2].id' <<<"$RES")
call save_cards "$(jq -cn --arg t "$SP" '{project: "dsa", topic_path: $t, cards: [
  {front: "A* search", back: "Dijkstra plus a heuristic.", kind: "concept"},
  {front: "  dijkstra ", back: "dup", kind: "concept"}]}')"
check "duplicate front fails with item index" errhas "item 1: duplicate"
check "duplicate error names the existing card" errhas "$C1"
call search_cards "{\"project\":\"dsa\",\"topic_path\":\"$RUN\",\"query\":\"A* search\"}"
check "failed batch wrote nothing" jqt '.total == 0'

echo "4. Japanese round-trip"
call save_cards "$(jq -cn --arg t "$RUN/文法/助詞" '{project: "japanese", topic_path: $t, cards: [
  {front: "は vs が", back: "Both are 助詞 (particles): は marks the topic, が marks the subject.", kind: "grammar"}]}')"
check "japanese card saves" jqt ".created[0].topic_path == \"$RUN/文法/助詞\""
JP=$(jq -r '.created[0].id' <<<"$RES")
call search_cards "{\"project\":\"japanese\",\"query\":\"助詞\",\"topic_path\":\"$RUN\"}"
check "search query 助詞 finds it" jqt ".items[0].id == \"$JP\""
call search_cards "{\"project\":\"japanese\",\"topic_path\":\"$RUN/文法/助詞\"}"
check "search by japanese topic path finds it" jqt ".items[0].id == \"$JP\""
call search_cards "{\"project\":\"japanese\",\"query\":\"が\",\"topic_path\":\"$RUN\"}"
check "search query が finds it" jqt ".items[0].id == \"$JP\""

echo "5. due queue"
call get_due_cards "{\"project\":\"dsa\",\"topic_path\":\"$RUN\"}"
check "3 new cards, none due" jqt '(.new | length) == 3 and (.due | length) == 0 and .counts.new_total == 3'

echo "6. card grading"
call record_reviews "$(jq -cn --arg s "$SESSION" --arg a "$C1" --arg b "$C2" --arg c "$C3" '{project: "dsa", exercise: "flashcard", session: $s,
  items: [{card_id: $a, grade: 3}, {card_id: $b, grade: 1, comment: "forgot V-1"}, {card_id: $c, grade: 4}]}')"
check "record_reviews succeeds" test "$ISERR" = false
check "response includes next_due" jqt 'all(.cards[]; .next_due != null)'
check "grade 3 -> 1 day, grade 4 -> 3 days" jqt '[.cards[] | .interval_days] == [1, 0, 3]'
check "topic mastery updated" jqt "any(.topics[]; .topic_path == \"$SP\" and .mastery > 0)"
NOW=$(date -u +%s)
call get_cards "{\"ids\":[\"$C2\"]}"
check "grade-1 card has lapses 1" jqt '.items[0].lapses == 1 and .items[0].reps == 0'
DUE=$(jq -r '.items[0].due' <<<"$RES")
DUE_S=$(date -u -d "$DUE" +%s 2>/dev/null || echo 0)
check "grade-1 card due in about 10 minutes" test $((DUE_S - NOW)) -ge 540 -a $((DUE_S - NOW)) -le 660
check "get_cards includes last reviews" jqt '.items[0].reviews[0].comment == "forgot V-1"'

echo "7. topic-level grade"
call record_reviews "$(jq -cn --arg s "$SESSION" --arg t "$SP" '{project: "dsa", exercise: "speaking", session: $s, items: [{topic_path: $t, score: 85}]}')"
check "score 85 stored as a topic-level review" test "$ISERR" = false
check "self_mastery changed (grade 3 -> 0.6667)" jqt '.topics[0].self_mastery == 0.6667'
check "session summary" jqt '.session.count == 1 and .session.avg_grade == 3'

echo "8. weak topics"
call list_topics "{\"project\":\"dsa\",\"root_path\":\"$RUN\",\"sort\":\"mastery_asc\"}"
check "list_topics sorted by mastery" jqt '[.items[].mastery] == ([.items[].mastery] | sort)'
check "rolled_mastery on graphs" jqt "any(.items[]; .path == \"$RUN/graphs\" and .rolled_mastery > 0)"

echo "9. links"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/Graphs/BFS\"}"
call link "{\"project\":\"dsa\",\"type\":\"prerequisite\",\"from_topic\":\"$RUN/graphs/bfs\",\"to_topic\":\"$SP\",\"label\":\"unweighted case\"}"
check "prerequisite link created" jqt '.existed == false and .type == "prerequisite"'
call link "{\"project\":\"dsa\",\"type\":\"prerequisite\",\"from_topic\":\"$RUN/graphs/bfs\",\"to_topic\":\"$SP\"}"
check "repeat link is a no-op" jqt '.existed == true'
call link "{\"project\":\"dsa\",\"type\":\"contrasts\",\"from_card_id\":\"$C1\",\"to_card_id\":\"$C2\"}"
call link "{\"project\":\"dsa\",\"type\":\"contrasts\",\"from_card_id\":\"$C2\",\"to_card_id\":\"$C1\"}"
check "undirected link dedupes in reverse" jqt '.existed == true'
call link "{\"project\":\"dsa\",\"type\":\"related\",\"from_card_id\":\"$C1\",\"to_topic\":\"$SP\"}"
check "card -> topic link rejected" test "$ISERR" = true
call link "{\"project\":\"dsa\",\"type\":\"related\",\"from_card_id\":\"$C1\",\"to_card_id\":\"$C1\"}"
check "self-link rejected" test "$ISERR" = true

echo "10. graph"
call get_graph "{\"project\":\"dsa\",\"root_path\":\"$RUN\",\"mode\":\"full\",\"format\":\"both\"}"
check "nodes include the topics" jqt "[.nodes[] | .path] | contains([\"$RUN/graphs\", \"$SP\", \"$RUN/graphs/bfs\"])"
check "prerequisite edge present" jqt 'any(.edges[]; .type == "prerequisite")'
check "mermaid flowchart with classDef" jqt '(.mermaid | startswith("flowchart LR")) and (.mermaid | contains("classDef"))'
call get_graph "{\"project\":\"dsa\",\"root_path\":\"$RUN\",\"mode\":\"mindmap\",\"format\":\"mermaid\",\"include_cards\":true}"
check "mindmap mermaid" jqt '(.mermaid | startswith("mindmap")) and .nodes == null'
call get_graph "{\"project\":\"dsa\",\"root_path\":\"$RUN\",\"mode\":\"flow\",\"include_cards\":true,\"format\":\"json\"}"
check "flow graph has the card contrasts edge" jqt 'any(.edges[]; .type == "contrasts")'

echo "11. progress"
call get_progress "{\"project\":\"dsa\",\"topic_path\":\"$RUN\",\"session\":\"$SESSION\"}"
check "today's review count >= 4" jqt '.reviews_per_day[-1].count >= 4'
check "session reviews listed" jqt '(.session | length) == 4'
check "most-lapsed card listed" jqt ".most_lapsed_cards[0].id == \"$C2\""
check "due counts present" jqt '.due.next_30_days >= 3'

echo "12. card update"
call update_card "{\"id\":\"$C3\",\"meta\":{\"difficulty\":\"easy\",\"source\":null}}"
check "meta shallow merge (add + delete key)" jqt '.meta == {"difficulty": "easy"}'
call update_card "{\"id\":\"$C3\",\"reset_progress\":true}"
check "reset_progress resets SRS" jqt '.due == null and .reps == 0 and .mastery == 0 and .ease == 2.5'
call update_card "{\"id\":\"$C3\",\"delete\":true}"
check "delete card" jqt '.deleted == true'
call get_progress "{\"project\":\"dsa\",\"topic_path\":\"$RUN\",\"session\":\"$SESSION\"}"
check "deleted card's reviews are gone" jqt '(.session | length) == 3'

echo "13. topic deletion"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$SP\",\"delete\":true}"
check "non-empty topic delete fails with counts" errhas "2 cards"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/graphs/bfs\",\"delete\":true}"
check "empty topic delete succeeds" jqt '.deleted == true'

echo "13b. topic move / rename"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/Move/Old Name/Child\"}"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/Other\"}"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/move/old-name\",\"new_path\":\"$RUN/Other\"}"
check "move onto an existing path fails" errhas "already exists"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/move/old-name\",\"new_path\":\"$RUN/move/old-name/child/x\"}"
check "move under itself fails" errhas "under itself"
call upsert_topic "{\"project\":\"dsa\",\"path\":\"$RUN/move/old-name\",\"new_path\":\"$RUN/Renamed/New Name\"}"
check "move/rename succeeds" jqt ".path == \"$RUN/renamed/new-name\" and .name == \"New Name\""
call list_topics "{\"project\":\"dsa\",\"root_path\":\"$RUN/renamed\"}"
check "descendant path rewritten" jqt "any(.items[]; .path == \"$RUN/renamed/new-name/child\")"
check "new parent chain is consistent" jqt "(.items | map({(.id): .path}) | add) as \$m | all(.items[] | select(.parent != null and \$m[.parent] != null); (. as \$i | \$i.path | startswith(\$m[\$i.parent] + \"/\")))"

echo "14. security"
check "wrong secret -> 404" test "$(status POST "$BASE/mcp/not-the-secret" '{"jsonrpc":"2.0","id":1,"method":"ping"}')" = 404
check "GET -> 405" test "$(status GET "$URL")" = 405
check "DELETE -> 405" test "$(status DELETE "$URL")" = 405
for c in topics cards reviews links; do
  code=$(status GET "$BASE/api/collections/$c/records")
  body=$(curl -sS "$BASE/api/collections/$c/records")
  check "public REST list of $c returns no data ($code)" nodata "$code" "$body"
done

echo "16. OAuth"
REDIRECT="https://claude.ai/api/mcp/auth_callback"
RES=$(curl -sS -D - -o /dev/null -X POST "$BASE/mcp" -H 'Content-Type: application/json' --data-binary '{"jsonrpc":"2.0","id":1,"method":"ping"}')
check "POST /mcp without a token -> 401" grep -q '^HTTP/[0-9.]* 401' <<<"$RES"
check "401 carries WWW-Authenticate resource_metadata" grep -qi 'www-authenticate: Bearer resource_metadata="' <<<"$RES"
RES=$(curl -sS "$BASE/.well-known/oauth-protected-resource/mcp")
check "protected resource metadata names /mcp" jqt ".resource | endswith(\"/mcp\")"
RES=$(curl -sS "$BASE/.well-known/oauth-authorization-server")
check "authorization server metadata: S256 + registration" jqt '(.code_challenge_methods_supported | index("S256")) != null and (.registration_endpoint | endswith("/oauth/register"))'
check "registration of a foreign redirect URI is refused" test "$(status POST "$BASE/oauth/register" '{"redirect_uris":["https://evil.example/cb"]}')" = 400
RES=$(curl -sS -X POST "$BASE/oauth/register" -H 'Content-Type: application/json' \
  --data-binary "{\"client_name\":\"smoke-test\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\"}")
CLIENT=$(jq -r '.client_id // empty' <<<"$RES")
check "dynamic client registration" test -n "$CLIENT"
check "unknown client gets an error page, not a redirect" test "$(status GET "$BASE/oauth/authorize?client_id=nope&redirect_uri=$REDIRECT&response_type=code")" = 400
check "bogus bearer token -> 401" test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H 'Authorization: Bearer skb_at_bogus' -d '{}')" = 401

if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ] && command -v openssl >/dev/null; then
  VERIFIER=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64)
  CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  STATE="st-$RUN"
  AUTHQ="response_type=code&client_id=$CLIENT&redirect_uri=$REDIRECT&code_challenge=$CHALLENGE&code_challenge_method=S256&state=$STATE&scope=mcp&resource=$BASE/mcp"
  check "sign-in page renders" test "$(status GET "$BASE/oauth/authorize?$AUTHQ")" = 200
  form() { # form <email> <password> → redirect URL ("" when none)
    curl -sS -o /dev/null -w '%{redirect_url}' -X POST "$BASE/oauth/authorize" \
      --data-urlencode "response_type=code" --data-urlencode "client_id=$CLIENT" --data-urlencode "redirect_uri=$REDIRECT" \
      --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "code_challenge_method=S256" --data-urlencode "state=$STATE" \
      --data-urlencode "scope=mcp" --data-urlencode "resource=$BASE/mcp" --data-urlencode "decision=allow" \
      --data-urlencode "email=$1" --data-urlencode "password=$2"
  }
  check "wrong password does not redirect" test -z "$(form "$ADMIN_EMAIL" "wrong-password-$RUN")"
  LOC=$(form "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  CODE=$(sed -n 's/.*[?&]code=\([^&]*\).*/\1/p' <<<"$LOC")
  check "correct sign-in redirects to the client with code and state" bash -c "[[ '$LOC' == $REDIRECT?* && '$LOC' == *state=$STATE* && -n '$CODE' ]]"
  tok() { curl -sS -X POST "$BASE/oauth/token" "$@"; }
  RES=$(tok --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" --data-urlencode "client_id=$CLIENT" \
    --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code_verifier=wrong-${VERIFIER}")
  check "wrong PKCE verifier is refused" jqt '.error == "invalid_grant"'
  # The code was consumed by the failed attempt; get a fresh one.
  LOC=$(form "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  CODE=$(sed -n 's/.*[?&]code=\([^&]*\).*/\1/p' <<<"$LOC")
  RES=$(tok --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" --data-urlencode "client_id=$CLIENT" \
    --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code_verifier=$VERIFIER" --data-urlencode "resource=$BASE/mcp")
  check "code exchange returns access + refresh tokens" jqt '.token_type == "Bearer" and (.access_token | startswith("skb_at_")) and (.refresh_token | startswith("skb_rt_"))'
  AT=$(jq -r .access_token <<<"$RES")
  RT=$(jq -r .refresh_token <<<"$RES")
  RES=$(tok --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" --data-urlencode "client_id=$CLIENT" \
    --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code_verifier=$VERIFIER")
  check "authorization code is single-use" jqt '.error == "invalid_grant"'
  bearer() { curl -sS -X POST "$BASE/mcp" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data-binary "$2"; }
  RES=$(bearer "$AT" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  check "bearer token works on POST /mcp" jqt '.result.tools | length == 11'
  RES=$(tok --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$RT" --data-urlencode "client_id=$CLIENT")
  check "refresh returns a rotated token pair" jqt "(.access_token | startswith(\"skb_at_\")) and .refresh_token != \"$RT\""
  AT2=$(jq -r .access_token <<<"$RES")
  RT2=$(jq -r .refresh_token <<<"$RES")
  RES=$(bearer "$AT2" '{"jsonrpc":"2.0","id":2,"method":"ping"}')
  check "refreshed access token works" jqt '.result == {}'
  RES=$(tok --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$RT" --data-urlencode "client_id=$CLIENT")
  check "reusing a rotated refresh token is refused" jqt '.error == "invalid_grant"'
  check "...and revokes the whole token family" test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Authorization: Bearer $AT2" -d '{}')" = 401
  RES=$(tok --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$RT2" --data-urlencode "client_id=$CLIENT")
  check "family revocation also kills the newest refresh token" jqt '.error == "invalid_grant"'
  curl -sS -o /dev/null -X POST "$BASE/oauth/revoke" --data-urlencode "token=$RT2"
else
  echo "  (skipping OAuth sign-in flow: set ADMIN_EMAIL and ADMIN_PASSWORD to run it)"
fi

echo "15. cleanup (on exit)"
trap - EXIT
cleanup
echo
if [ "$FAIL" -eq 0 ]; then
  green "all $PASS checks passed"
else
  red "$FAIL of $((PASS + FAIL)) checks failed"
  exit 1
fi
