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

### Alerting

Alerts fire for drift at or above `ALERT_THRESHOLD` (default `WARNING`; INFO drift is recorded
to the timeline but never pushed). Configure destinations in `.env` — both optional:

- `ALERT_WEBHOOK_URL` — drift alerts are POSTed there as JSON
- `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` — posts a formatted Slack message

Every delivery attempt (sent or failed) is recorded in alert history.

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

## Development

Prereqs: Node ≥ 20 with pnpm 10 (via corepack), [uv](https://docs.astral.sh/uv/), Docker.

```sh
pnpm install                # JS workspaces
pnpm test                   # all TS tests (Vitest)
pnpm lint                   # ESLint + Prettier

cd services/schema-engine
uv sync                     # Python deps
uv run pytest               # Python tests
uv run ruff check .         # Python lint
```

Pre-commit hooks (lint + all tests) are installed automatically by `pnpm install` via
`core.hooksPath` → `.githooks/`.

## Repository layout

```
apps/core              TS service: capture, baseline store, diff + severity, scheduler, API
apps/web               React/Vite diff-view UI
services/schema-engine Python FastAPI + genson inference sidecar
packages/shared        Shared TS domain types (schema model, Diff, Severity)
tests/mock-api         Controllable mock server for manufacturing drift (demos + e2e)
tests/e2e              End-to-end drift lifecycle test (real schema-engine + Postgres)
```

See `CLAUDE.md` for the full project spec, architecture, and severity semantics.

## Status

**Phase 1 (polling REST drift detection) — complete**: multi-sample baselining, semantic
diff + severity classification, BullMQ polling scheduler, webhook/Slack alerting, REST API,
diff-view UI, and an end-to-end drift proof — all self-hosted via `docker compose up`.

Next phases (see `CLAUDE.md` §3): MCP server monitoring, passive proxy capture, CI integration.
