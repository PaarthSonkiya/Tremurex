# CLAUDE.md — Tremurex

This file is the source of truth for the Tremurex project. Read it at the start of every session and follow it. When a request conflicts with this file, surface the conflict before proceeding.

---

## 1. What Tremurex is

Tremurex is an **open-source, self-hostable service that detects structural drift in the external APIs and MCP servers an application depends on.** It learns a structural schema of each dependency's responses, watches for changes, and alerts with severity-classified diffs **before** a breaking change silently corrupts production.

**Headline value prop:** privacy. Everything runs in the user's own environment. Tremurex never phones home, never transmits captured data, schemas, or telemetry anywhere. This is a hard invariant (see §7).

**Secondary value prop:** trivial self-hosting. `docker compose up` brings up the entire system. Keep it that way.

---

## 2. Goals and non-goals

**Goals**
- High-quality structural schema inference with **multi-sample baselining** so conditionally-present fields do not cause false positives. This is the core quality bar.
- A **semantic diff + severity classifier** with excellent signal-to-noise. Alert fatigue is the failure mode that kills tools like this; precision matters more than recall.
- Two capture modes: scheduled **polling** (ship first) and a passive **proxy** (the showpiece, later).
- First-class **MCP monitoring**: track the `initialize → tools/list` lifecycle and the tool catalog over time.
- Clear alerting, a drift timeline, and a readable diff view.

**Non-goals (do not build these unless told)**
- Not a runtime gateway or enforcement layer. Tremurex observes; it never blocks or proxies production traffic inline (the proxy mode is passive capture only).
- Not a general APM/observability platform.
- Not multi-tenant SaaS. Single-org, self-hosted. No billing, no account system.
- v1 dashboard has no auth/RBAC (note as a future concern; do not build it now).

---

## 3. Phased roadmap

Build in order. Do not start a later phase until the prior one is complete, tested, and demoable.

1. **Polling REST drift detection** — multi-sample baselining + severity classification + alerting + minimal diff-view UI, self-hostable via Docker. This phase alone is a usable, demoable product.
2. **MCP server monitoring** — track tool catalog drift over the MCP lifecycle.
3. **Passive proxy mode** — capture real authenticated traffic via a mitmproxy sidecar (the technical showpiece).
4. **CI integration** — a CLI that fails a build when a dependency's schema drifts (breaking).

The current target is **Phase 1** unless stated otherwise in the session.

---

## 4. Architecture

Polyglot by design: TypeScript core + small single-responsibility Python sidecars, all orchestrated by `docker compose`. JSON Schema is the language-agnostic contract between them.

```
                 ┌─────────────────────────────────────────────┐
                 │                  core (TS/Node)              │
   captures ───▶ │  capture → baseline store → diff+severity   │ ──▶ alerts
                 │  scheduler · MCP client · REST API · web UI  │
                 └───────┬───────────────────────┬─────────────┘
                         │ HTTP (JSON Schema)     │ SQL
                         ▼                        ▼
              ┌────────────────────┐      ┌──────────────┐
              │ schema-engine (Py) │      │  Postgres    │
              │ FastAPI + genson   │      │  (JSONB)     │
              └────────────────────┘      └──────────────┘
              ┌────────────────────┐      ┌──────────────┐
              │  proxy (Py, P3)    │      │   Redis      │
              │  mitmproxy addon   │      │  (BullMQ)    │
              └────────────────────┘      └──────────────┘
```

**Service responsibilities**
- **core (TS)** — owns everything operational: capture adapters, the baseline store, the **semantic diff + severity classifier (the differentiator — keep it here, in the main codebase)**, the polling scheduler, the MCP client for monitoring MCP servers, alerting, the REST API, and the web UI.
- **schema-engine (Python)** — a tiny FastAPI service wrapping `genson`. Its only job: take N JSON samples and return one merged **JSON Schema (draft 2020-12)** with correct required/optional marking. Keep its surface minimal and replaceable.
- **proxy (Python, Phase 3)** — a mitmproxy addon that passively captures responses and forwards them to core for inference.
- **Postgres** — persistence (baselines, samples, diffs, alert history). Use `JSONB` for stored schemas.
- **Redis** — backs the BullMQ job queue for polling cadence, retries, and concurrency.

---

## 5. Tech stack (use these; ask before substituting)

**core (TypeScript / Node 22, ESM, pnpm)**
- API server: **Fastify**
- DB access: **Drizzle ORM** against **Postgres** (Drizzle keeps a SQLite "lite mode" open for a future single-binary deploy — design the data layer so the DB is swappable)
- Queue/scheduler: **BullMQ** + **Redis**
- Validation: **Zod** (config, API I/O)
- HTTP client: **undici**
- MCP client (Phase 2): **@modelcontextprotocol/sdk**
- Slack: **@slack/web-api**
- Tests: **Vitest**
- Lint/format: **ESLint** + **Prettier**

**web (diff-view UI)**
- **React + Vite + TypeScript**, **TanStack Query** for data fetching. Keep Phase 1 UI minimal: dependency list, drift timeline, and a single readable diff view.

**schema-engine (Python 3.12, managed with `uv`)**
- **FastAPI** + **uvicorn**, **pydantic** models, **genson** for inference, **pytest** for tests.

**proxy (Python, Phase 3)** — **mitmproxy** addon script.

**Tooling** — pnpm workspaces monorepo; conventional commits; pre-commit hooks running lint + tests.

---

## 6. Repository layout

```
tremurex/
├── apps/
│   ├── core/                 # TS service (capture, baseline, diff, scheduler, mcp, alerting, api, db)
│   └── web/                  # React/Vite diff-view UI
├── services/
│   ├── schema-engine/        # Python FastAPI + genson
│   └── proxy/                # Python mitmproxy addon (Phase 3)
├── packages/
│   └── shared/               # shared TS types: schema model, diff result, severity enum, contracts
├── tests/                    # cross-service / e2e tests + golden fixtures
├── docker-compose.yml
├── .env.example
└── CLAUDE.md
```

---

## 7. Hard rules / invariants (never violate)

1. **No phone-home.** Tremurex must never transmit captured payloads, inferred schemas, diffs, or usage telemetry to any external endpoint. The only outbound network calls allowed are (a) polling the user-configured endpoints being monitored and (b) delivering alerts to user-configured destinations (their Slack, their webhook, their SMTP). Nothing else leaves the box.
2. **Redact secrets.** Capture (especially proxy mode) will see auth headers, tokens, cookies, and credential-shaped fields. Never persist these. Redact known-sensitive headers and value patterns before storage. Schemas record *shape*, not secret *values*.
3. **JSON Schema (draft 2020-12) is the canonical internal schema representation.** All inference output and all diff input use it. This is the contract across the TS/Python boundary.
4. **Determinism.** Schema inference and diffing must be deterministic: identical inputs always yield byte-identical output. This is required for reliable diffs and golden-file tests.
5. **Every severity rule and every schema-merge edge case has a unit test.** No exceptions. The diff/severity engine is the product; it is tested like it.
6. **Additive-safe semantics.** For monitored *responses*, additions do not break consumers; removals and shape changes do. Classify accordingly (see §8).

---

## 8. Domain model & severity semantics

**Vocabulary**
- **Capture** — one observed response (or one MCP `tools/list` result).
- **Sample** — a capture used to build/refine a baseline.
- **Baseline** — the merged schema representing "normal" for a dependency, built from a window of samples.
- **Baselining window** — the count/duration of samples collected before a baseline is locked. While baselining, do not emit drift alerts.
- **Drift** — a diff between a new capture's schema and the locked baseline.
- **Diff** — a list of typed, located, severity-classified changes.

**Multi-sample baselining (the core feature) — how it must work**
1. Collect samples across the baselining window.
2. Send all accumulated samples to schema-engine; `genson` merges them into one schema where a field is `required` only if present in **all** samples and optional otherwise. This is what stops conditional fields from producing false positives.
3. Lock that merged schema as the baseline.
4. On each new capture, infer its schema, diff against the baseline, classify, and alert if warranted.
5. A new optional field seen post-baseline is INFO and may extend the baseline; a removal/type-change is drift and is flagged, never silently absorbed.

**Severity matrix — REST responses** (consumer-of-response semantics)
| Change | Severity |
|---|---|
| Required field removed | BREAKING |
| Field type changed (e.g. string → number) | BREAKING |
| Structure changed (object ↔ array, nesting change) | BREAKING |
| Array element type changed | BREAKING |
| Optional field removed | WARNING |
| Field became nullable (was never null) | WARNING |
| Enum value removed | WARNING |
| New field added (optional or always-present) | INFO |
| Optional field became always-present | INFO |
| New enum value added | INFO |

**Severity matrix — MCP tool catalog** (caller-of-tool semantics)
| Change | Severity |
|---|---|
| Tool removed | BREAKING |
| Tool parameter removed or renamed | BREAKING |
| Parameter type changed | BREAKING |
| Optional parameter became required | BREAKING |
| Parameter became nullable | WARNING |
| New tool added | INFO |
| New optional parameter added | INFO |
| Tool/param description changed | INFO |

Each diff entry carries: a JSON path to the change, the before/after fragment, the rule that fired, and the severity. Alerts fire on BREAKING and WARNING by default; INFO is recorded to the timeline but not pushed (make the threshold configurable).

---

## 9. Service contracts

**core → schema-engine**
- `POST /infer` — body `{ "samples": [<json>, ...] }` → `{ "schema": <json-schema-2020-12> }`. Pure, deterministic, stateless. The engine holds no state; core owns all persistence and orchestration.

**core REST API (shape, not exhaustive)**
- `GET /dependencies` · `GET /dependencies/:id/timeline` · `GET /diffs/:id` · `POST /dependencies` (register an endpoint or MCP server to monitor) · `GET /health`.

Validate all API and config I/O with Zod. Never put captured data or secrets in URLs/query strings or logs.

---

## 10. Conventions & definition of done

- **Test-first for the schema/diff core.** Write the failing test (or golden fixture) before the implementation. Use golden-file fixtures for inference and diff outputs.
- **TypeScript:** strict mode on, no `any` (use `unknown` + Zod), ESM, named exports, small modules.
- **Python:** typed (pydantic + type hints), `ruff` clean, small surface.
- **Commits:** conventional commits, one logical change each, with passing tests.
- **A feature is done when:** it has tests, passes lint, runs under `docker compose up` with a working health check, and is reflected in the README and `.env.example`.
- **When unsure** about a severity classification, a schema-merge edge case, or anything that affects the product's signal-to-noise: stop and ask rather than guessing.

---

## 11. Local dev / running

- `docker compose up` must start: core, web, schema-engine, postgres, redis — with health checks — and nothing else required.
- Provide a `tests/mock-api` (a controllable mock server, e.g. Prism/WireMock/json-server) whose responses can be deliberately mutated to manufacture drift for tests and demos.
- Keep `.env.example` complete and current. Secrets come from env only, never committed.
