# Contributing to Tremurex

Thanks for your interest! Tremurex detects structural drift in the external APIs and MCP servers an
application depends on. Before contributing, please skim [`CLAUDE.md`](./CLAUDE.md) — it is the
source of truth for scope, architecture, the severity model, and the hard invariants. When a change
would conflict with it, raise that first.

## Ground rules (non-negotiable, from `CLAUDE.md` §7)

1. **No phone-home.** The only allowed outbound calls are polling user-configured endpoints and
   delivering alerts to user-configured destinations.
2. **Redact secrets** before anything is stored or inferred.
3. **JSON Schema (draft 2020-12)** is the canonical internal schema representation.
4. **Determinism.** Identical inputs must yield byte-identical inference/diff output.
5. **Every severity rule and schema-merge edge case has a unit test.** No exceptions.
6. **Additive-safe semantics** for monitored responses (additions = INFO; removals/type changes =
   BREAKING).

## Project layout

- `apps/core` — TypeScript service: capture, baseline store, **diff + severity engine**, scheduler,
  MCP client, alerting, REST API.
- `apps/web` — React/Vite diff-view UI.
- `apps/cli` — the `tremurex` CI drift gate (Phase 4).
- `services/schema-engine` — Python FastAPI + genson inference sidecar.
- `services/proxy` — Python mitmproxy addon (Phase 3).
- `packages/shared` — shared TypeScript contracts.
- `tests/` — cross-service / e2e tests, golden fixtures, and the controllable mock API.

## Development

Requires Node 22 + `pnpm`, Python 3.12 + `uv`, and Docker for the integration/e2e suites.

```sh
pnpm install
pnpm build            # build all workspaces
docker compose up     # full stack with health checks

# Python sidecars
(cd services/schema-engine && uv sync)
(cd services/proxy && uv sync)
```

## Tests & checks (must pass before a PR)

```sh
pnpm lint                                            # ESLint + Prettier
pnpm test                                            # TypeScript (Vitest)
cd services/schema-engine && uv run ruff check . && uv run pytest -q
cd services/proxy        && uv run ruff check . && uv run pytest -q
```

- **Test-first for the schema/diff core.** Write the failing test or golden fixture before the
  implementation.
- **TypeScript:** strict mode, no `any` (use `unknown` + Zod), ESM, named exports, small modules.
- **Python:** typed, `ruff` clean, minimal surface.

## Commits & PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
  `test:`, `ci:`, `refactor:`, `chore:`), one logical change per commit, each with passing tests.
- A change is **done** when it has tests, passes lint, runs under `docker compose up` with a working
  health check, and is reflected in the README and `.env.example` where relevant.
- When unsure about a severity classification or a schema-merge edge case, open an issue and ask —
  signal-to-noise is the product.

## Reporting security issues

Please follow [`SECURITY.md`](./SECURITY.md) — do not file public issues for vulnerabilities.
