# Tremurex

Tremurex is an open-source, self-hostable service that detects **structural drift** in the
external APIs and MCP servers your application depends on. It learns a structural schema of each
dependency's responses, watches for changes, and alerts with severity-classified diffs **before**
a breaking change silently corrupts production.

**Privacy first:** everything runs in your own environment. Tremurex never phones home — no
captured data, schemas, or telemetry ever leave your infrastructure. The only outbound calls are
polling the endpoints _you_ configure and delivering alerts to destinations _you_ configure.

## Quick start

```sh
cp .env.example .env   # optional — sensible defaults are built in
docker compose up
```

This brings up five services, all with health checks:

| Service       | Port | What it is                                                                       |
| ------------- | ---- | -------------------------------------------------------------------------------- |
| core          | 4000 | TS/Fastify — capture, baselining, diff + severity, scheduler, alerting, REST API |
| web           | 3000 | React diff-view UI                                                               |
| schema-engine | 8000 | Python/FastAPI — multi-sample JSON Schema inference (genson)                     |
| postgres      | 5432 | Persistence (baselines, samples, diffs, alerts)                                  |
| redis         | 6379 | BullMQ job queue for polling                                                     |

Verify:

```sh
curl http://localhost:4000/health   # core
curl http://localhost:8000/health   # schema-engine
open http://localhost:3000          # web UI
```

## Using it

Register an endpoint to monitor:

```sh
curl -X POST http://localhost:4000/dependencies \
  -H 'content-type: application/json' \
  -d '{
    "name": "github-repo",
    "url": "https://api.github.com/repos/golang/go",
    "headers": { "accept": "application/vnd.github+json" },
    "pollIntervalSeconds": 300,
    "baselineWindow": 5,
    "alertThreshold": "WARNING"
  }'
```

Tremurex polls the endpoint on the configured cadence, accumulates `baselineWindow` samples,
merges them into one JSON Schema (a field is `required` only if present in **every** sample —
this is what stops conditionally-present fields from producing false positives), locks that as
the baseline, and then diffs every subsequent capture against it. Drift is severity-classified
per the matrix in `CLAUDE.md` §8: removals and type/shape changes are BREAKING, optionality and
nullability loosening are WARNING, additions are INFO.

Explore via API or the web UI at `http://localhost:3000`:

- `GET /dependencies` — everything monitored, with `baselining`/`monitoring` status
- `GET /dependencies/:id/timeline` — baseline locks + drift events, newest first
- `GET /diffs/:id` — one classified diff: entries, rule, JSON path, before/after fragments

Configured header values (e.g. `authorization`) are stored for polling but always masked in API
responses, logs, and alerts.

### Managing dependencies

The web UI is a full control surface — register, edit, and operate dependencies without touching
curl — and every action has a REST equivalent:

- `PATCH /dependencies/:id` — edit name, URL, headers, cadence, window, alert threshold, or
  pause/resume (`enabled`). The schedule reconciles automatically.
- `DELETE /dependencies/:id` — stop monitoring and remove all of its history.
- `POST /dependencies/:id/poll` — poll once, right now (poll-mode only).
- `POST /dependencies/:id/rebaseline` — when a dependency has _legitimately_ changed shape,
  discard its baseline and relearn from the next captures.
- `POST /diffs/:id/resolve` — manually mark a drift resolved during triage.
- `GET /dependencies/:id/alerts` — the alert delivery history for a dependency.

### Monitoring MCP servers

Register a remote MCP server (Streamable HTTP transport) with `"kind": "mcp"`:

```sh
curl -X POST http://localhost:4000/dependencies \
  -H 'content-type: application/json' \
  -d '{
    "name": "docs-mcp",
    "kind": "mcp",
    "url": "https://mcp.example.com/mcp",
    "headers": { "authorization": "Bearer ..." },
    "pollIntervalSeconds": 300
  }'
```

Each poll runs the `initialize → tools/list` lifecycle and captures the tool catalog. The first
successful capture locks it as the baseline (catalogs are exact documents, so `baselineWindow`
defaults to 1), and every later capture is diffed against it per the §8 MCP matrix: tool or
parameter removals, parameter type changes, and parameters becoming required are BREAKING;
parameters becoming nullable are WARNING; new tools, new optional parameters, and description
changes are INFO.

### Monitoring real traffic with the passive proxy

Instead of polling, Tremurex can learn from the responses your app actually receives. A
mitmproxy sidecar observes traffic you route through it and forwards JSON responses of monitored
hosts to core — it never modifies or blocks anything (passive capture only).

It is opt-in so the default `docker compose up` stays lean:

```sh
docker compose --profile proxy up        # adds the proxy on :8080
```

Register a dependency with `"captureMode": "proxy"`. Its `url` is treated as a
scheme+host+path **prefix** that real request URLs are matched against:

```sh
curl -X POST http://localhost:4000/dependencies \
  -H 'content-type: application/json' \
  -d '{"name":"shop-products","captureMode":"proxy","url":"https://api.shop.example.com/v1/products"}'
```

Then point the client whose traffic you want to watch at the proxy and trust its CA so it can
read HTTPS:

```sh
# Grab the CA the sidecar generated (written to the proxy-certs volume):
docker compose --profile proxy cp proxy:/certs/mitmproxy-ca-cert.pem ./mitmproxy-ca.pem
# Install ./mitmproxy-ca.pem in your OS/browser trust store, then route traffic:
HTTPS_PROXY=http://localhost:8080 HTTP_PROXY=http://localhost:8080 your-app
```

Captured bodies are redacted (§7.2) and run through the **same** baseline → diff → severity →
alert pipeline as polling, so everything above — multi-sample baselining, the severity matrix,
dedup, the timeline and diff UI — applies unchanged. Captures arrive only as your app makes real
requests, so the baseline locks once enough live traffic has been seen.

### Alerting

Alerts fire for drift at or above `ALERT_THRESHOLD` (default `WARNING`; INFO drift is recorded
to the timeline but never pushed). Configure destinations in `.env` — both optional:

- `ALERT_WEBHOOK_URL` — drift alerts are POSTed there as JSON
- `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` — posts a formatted Slack message

Every delivery attempt (sent or failed) is recorded in alert history.

### Hardening

Sensible defaults that you can tighten in `.env` (see `.env.example`):

- **Response size cap** — captured bodies are bounded (`TREMUREX_MAX_RESPONSE_BYTES`, default
  10 MiB) so a slow or hostile endpoint can't exhaust memory.
- **SSRF guard** — link-local / cloud-metadata addresses (`169.254.0.0/16`, `fe80::/10`, IMDSv6)
  are **always** refused, at both registration and poll time. Private/loopback ranges stay
  allowed so you can monitor internal APIs; set `TREMUREX_BLOCK_PRIVATE_IPS=true` to block those
  too.
- **API auth (optional)** — set `TREMUREX_API_TOKEN` (≥16 chars) to require
  `Authorization: Bearer <token>` on every route except `/health`. The CLI reads the same
  variable; the web UI reads `VITE_API_TOKEN` at build time. Unset = no auth (the zero-config
  default).
- **CORS** — locked to the local web UI by default; override with `TREMUREX_ALLOWED_ORIGINS`
  (comma-separated, or `*` to reflect any origin).

### Failing CI on drift

The `tremurex` CLI turns drift into a build gate. It asks a running core which
dependencies are currently drifted and exits non-zero when any sits at or above a
threshold.

```sh
pnpm --filter @tremurex/cli build      # produces apps/cli/dist/cli.js

# Fail the build only on BREAKING drift (the default); --refresh polls each
# pollable dependency once first so the check reflects the live APIs right now.
node apps/cli/dist/cli.js check --url http://localhost:4000 --refresh
```

Options: `--url` (or `TREMUREX_CORE_URL`), `--threshold BREAKING|WARNING|INFO`,
`--refresh`, `--json`. Exit codes: **0** clean · **1** drift at/above threshold ·
**2** usage/connection error.

In GitHub Actions, run core (e.g. as a service or a prior `docker compose up -d`
step) and then either call the CLI directly:

```yaml
- name: Check API dependencies for drift
  run: node apps/cli/dist/cli.js check --refresh --threshold BREAKING
  env:
    TREMUREX_CORE_URL: http://localhost:4000
```

…or use the bundled composite action:

```yaml
- uses: PaarthSonkiya/tremurex/.github/actions/drift-gate@main
  with:
    core-url: http://localhost:4000
    threshold: BREAKING
    refresh: 'true'
```

### Manufacture drift in 2 minutes (demo)

```sh
# 1. Start the controllable mock API on your host (port 5050):
pnpm --filter @tremurex/mock-api start

# 2. Register it with a short cadence and small window
#    (host.docker.internal lets the core container reach your host):
curl -X POST http://localhost:4000/dependencies \
  -H 'content-type: application/json' \
  -d '{"name":"widget-api","url":"http://host.docker.internal:5050/api/widget","pollIntervalSeconds":5,"baselineWindow":3}'

# 3. Wait ~15s for the baseline to lock (watch http://localhost:3000), then
#    mutate the response — remove a required field, change a type:
curl -X PUT http://localhost:5050/__control/response \
  -H 'content-type: application/json' \
  -d '{"id":"WID-7341","name":"seismograph-9000","status":"active","tags":["sensor"]}'

# 4. Within one poll the timeline shows BREAKING drift:
#    required-field-removed at $.price, field-type-changed at $.id.
```

The same works for MCP: `pnpm --filter @tremurex/mock-api start:mcp` serves a mock MCP server
on port 5051 (register `http://host.docker.internal:5051/mcp` with `"kind": "mcp"`), and
`PUT http://localhost:5051/__control/tools` mutates its tool catalog.

## Health & API reference

Core exposes three unauthenticated, secret-free endpoints for operations and discovery:

- `GET /health` — **liveness**: the process is up.
- `GET /ready` — **readiness**: returns `200` only when Postgres, Redis, and the schema-engine are
  all reachable; `503` otherwise (with a per-check breakdown). Point your orchestrator's readiness
  probe here.
- `GET /openapi.json` — a self-served **OpenAPI 3.1** description of the REST API (§9). Load it in
  any OpenAPI viewer; nothing is sent anywhere.

## Development

Prereqs: Node ≥ 20 with pnpm 10 (via corepack), [uv](https://docs.astral.sh/uv/), Docker.

```sh
pnpm install                # JS workspaces
pnpm test                   # all TS tests (Vitest)
pnpm lint                   # ESLint + Prettier

for svc in schema-engine proxy; do
  (cd services/$svc && uv sync && uv run pytest -q && uv run ruff check .)
done
```

Pre-commit hooks (lint + all tests) are installed automatically by `pnpm install` via
`core.hooksPath` → `.githooks/`.

## Repository layout

```
apps/core              TS service: capture, baseline store, diff + severity, scheduler, API
apps/web               React/Vite diff-view UI
apps/cli               tremurex CLI: CI drift gate (Phase 4)
services/schema-engine Python FastAPI + genson inference sidecar
services/proxy         Python mitmproxy addon: passive capture → core /ingest (Phase 3)
packages/shared        Shared TS domain types (schema model, Diff, Severity)
tests/mock-api         Controllable mock REST + MCP servers for manufacturing drift
tests/e2e              End-to-end drift proofs (REST poll, MCP, proxy capture, CI gate)
```

See `CLAUDE.md` for the full project spec, architecture, and severity semantics,
[`CONTRIBUTING.md`](./CONTRIBUTING.md) to get set up, and [`SECURITY.md`](./SECURITY.md) for the
security model and private vulnerability reporting.

## Status

**Phase 1 (polling REST drift detection) — complete**: multi-sample baselining, semantic
diff + severity classification, BullMQ polling scheduler, webhook/Slack alerting (with
repeat-drift dedup), REST API, diff-view UI, and an end-to-end drift proof — all self-hosted
via `docker compose up`.

**Phase 2 (MCP server monitoring) — complete**: `initialize → tools/list` capture over
Streamable HTTP, exact-catalog baselining, and tool-catalog drift classified per the §8 MCP
severity matrix, flowing through the same pipeline, dedup, alerting, and UI.

**Phase 3 (passive proxy capture) — complete**: a mitmproxy sidecar observes routed traffic and
forwards monitored JSON responses to core's `/ingest`, which redacts and runs them through the
same baseline/diff/alert pipeline. Opt-in via the `proxy` compose profile.

**Phase 4 (CI integration) — complete**: the `tremurex` CLI fails a build when a monitored
dependency has drift at or above a configurable severity, with an optional live `--refresh`.

All four roadmap phases are implemented, tested, and demoable under `docker compose up`, with
full dependency management (edit, delete, re-baseline, resolve, alert history) from both the API
and the web UI.

## License

[MIT](LICENSE).
