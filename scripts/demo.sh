#!/usr/bin/env bash
#
# Tremurex guided demo. Proves the whole loop end to end in ~60 seconds against
# the bundled mock API — no real upstream needed.
#
#   docker compose --profile demo up -d   # 5 core services + the mock API
#   ./scripts/demo.sh
#
# It registers the mock API, learns a baseline from a few samples, then mutates
# the mock's response to introduce a BREAKING change and shows the classified
# drift Tremurex catches. Open http://localhost:3000 to see the same drift in
# the UI.
#
# Env overrides: CORE_URL, MOCK_CONTROL_URL, MOCK_INTERNAL_URL, TREMUREX_API_TOKEN.
set -euo pipefail

CORE_URL="${CORE_URL:-http://localhost:4000}"
# The mock's control endpoint, reached from the host (this script).
MOCK_CONTROL_URL="${MOCK_CONTROL_URL:-http://localhost:5050}"
# The mock's URL as core (inside the compose network) reaches it.
MOCK_INTERNAL_URL="${MOCK_INTERNAL_URL:-http://mock-api:5050}"
WEB_URL="${WEB_URL:-http://localhost:3000}"
TOKEN="${TREMUREX_API_TOKEN:-}"

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  B=$(tput bold); R=$(tput sgr0); G=$(tput setaf 2); Y=$(tput setaf 3); C=$(tput setaf 6); RD=$(tput setaf 1)
else
  B=""; R=""; G=""; Y=""; C=""; RD=""
fi
step()  { printf '\n%s▸ %s%s\n' "$B$C" "$1" "$R"; }
ok()    { printf '%s  ✓ %s%s\n' "$G" "$1" "$R"; }
info()  { printf '    %s\n' "$1"; }
die()   { printf '%s✗ %s%s\n' "$RD" "$1" "$R" >&2; exit 1; }

HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1
command -v curl >/dev/null 2>&1 || die "curl is required."

# curl against core, with the API token if one is set.
api() {
  local method="$1" path="$2"; shift 2
  if [ -n "$TOKEN" ]; then
    curl -fsS -X "$method" -H "Authorization: Bearer $TOKEN" "$@" "$CORE_URL$path"
  else
    curl -fsS -X "$method" "$@" "$CORE_URL$path"
  fi
}

# Extract a string field from a JSON blob by jq-style path, e.g. "id" or
# "drift.id". jq when available; otherwise grep the path's last segment (good
# enough for these flat-ish responses).
json_str() {
  local path="$1" blob="$2"
  if [ "$HAVE_JQ" -eq 1 ]; then
    printf '%s' "$blob" | jq -r ".$path // empty"
  else
    local key="${path##*.}"
    printf '%s' "$blob" | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E "s/.*:[[:space:]]*\"([^\"]*)\"/\1/"
  fi
}

printf '%s\n' "${B}Tremurex — guided drift demo${R}"

# --- 1. wait for core --------------------------------------------------------
step "Waiting for core at $CORE_URL ..."
for i in $(seq 1 60); do
  if curl -fsS "$CORE_URL/health" >/dev/null 2>&1; then ok "core is healthy"; break; fi
  [ "$i" -eq 60 ] && die "core never became healthy. Is \`docker compose --profile demo up\` running?"
  sleep 2
done
curl -fsS "$MOCK_CONTROL_URL/health" >/dev/null 2>&1 \
  || die "mock API not reachable at $MOCK_CONTROL_URL. Start it: docker compose --profile demo up -d"

# Reset the mock to its pristine body so re-runs are deterministic.
curl -fsS -X PUT "$MOCK_CONTROL_URL/__control/response" -H 'content-type: application/json' -d '{
  "id": 7341,
  "name": "seismograph-9000",
  "status": "active",
  "price": { "amount": 1299.5, "currency": "USD" },
  "tags": ["sensor", "precision"]
}' >/dev/null

# --- 2. register the dependency ---------------------------------------------
step "Registering the mock API as a monitored dependency"
BASELINE_WINDOW=3
DEP_NAME="demo-widget-api-$(date +%H%M%S)"
REG=$(api POST /dependencies -H 'content-type: application/json' -d "{
  \"name\": \"$DEP_NAME\",
  \"url\": \"$MOCK_INTERNAL_URL/api/widget\",
  \"pollIntervalSeconds\": 3600,
  \"baselineWindow\": $BASELINE_WINDOW,
  \"alertThreshold\": \"WARNING\"
}") || die "registration failed — is core healthy? ($CORE_URL/health)"
DEP_ID=$(json_str id "$REG")
[ -n "$DEP_ID" ] || die "could not read dependency id from: $REG"
ok "registered  (id ${DEP_ID})"
info "url: $MOCK_INTERNAL_URL/api/widget   baseline window: $BASELINE_WINDOW samples"

# --- 3. learn the baseline ---------------------------------------------------
step "Learning the baseline (genson merges $BASELINE_WINDOW samples into one schema)"
for i in $(seq 1 "$BASELINE_WINDOW"); do
  P=$(api POST "/dependencies/$DEP_ID/poll")
  PHASE=$(json_str phase "$P")
  info "sample $i/$BASELINE_WINDOW captured  (phase: ${PHASE:-baselining})"
  sleep 1
done
ok "baseline locked — Tremurex now knows this API's normal shape"

# --- 4. manufacture a BREAKING change ---------------------------------------
step "Simulating an upstream change: price.amount number → string, and 'status' removed"
curl -fsS -X PUT "$MOCK_CONTROL_URL/__control/response" -H 'content-type: application/json' -d '{
  "id": 7341,
  "name": "seismograph-9000",
  "price": { "amount": "1299.50", "currency": "USD" },
  "tags": ["sensor", "precision"]
}' >/dev/null
ok "the mock API now returns a drifted response"

# --- 5. detect it ------------------------------------------------------------
step "Polling once more — Tremurex diffs the new capture against the baseline"
POLL=$(api POST "/dependencies/$DEP_ID/poll")
DIFF_ID=$(json_str drift.id "$POLL")
SEV=$(json_str drift.severity "$POLL")
[ -n "$DIFF_ID" ] || die "expected drift but none was recorded. Poll result: $POLL"
printf '%s  ⚠ DRIFT DETECTED — severity: %s%s%s\n' "$Y" "$B$RD" "${SEV:-?}" "$R"

step "The classified diff"
DIFF=$(api GET "/diffs/$DIFF_ID")
if [ "$HAVE_JQ" -eq 1 ]; then
  printf '%s' "$DIFF" | jq -r '
    "  severity: " + .severity,
    (.entries[] | "    • [" + .severity + "] " + .rule + "  at  " + .path)'
else
  printf '%s\n' "$DIFF"
  info "(install jq for a prettier view)"
fi

# --- done --------------------------------------------------------------------
printf '\n%s%s━━━ done in well under 5 minutes ━━━%s\n' "$B" "$G" "$R"
info "See the same drift in the UI:   $WEB_URL"
info "Inspect via API:                $CORE_URL/dependencies/$DEP_ID/timeline"
info "Re-run anytime — each run resets the mock and registers a fresh dependency."
