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
tests/                 Cross-service / e2e tests + golden fixtures
```

See `CLAUDE.md` for the full project spec, architecture, and severity semantics.

## Status

Phase 1 (polling REST drift detection) — in progress. Current milestone: **0 — scaffold/harness**.
