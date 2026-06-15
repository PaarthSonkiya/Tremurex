# Security Policy

Tremurex is a **privacy-first, self-hosted** tool. Its security posture is part of the product:
captured data, inferred schemas, and diffs never leave the operator's environment (see the hard
invariants in [`CLAUDE.md` §7](./CLAUDE.md)).

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue for a vulnerability.

- Use [GitHub private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on this repository (**Security → Report a vulnerability**), or
- email the maintainer.

Please include: affected component (core / schema-engine / proxy / web / cli), version or commit,
reproduction steps, and impact. We aim to acknowledge within **72 hours** and to ship a fix or
mitigation for confirmed high-severity issues promptly.

## Supported versions

This project tracks `main`. Security fixes land on `main`; pin a commit or release tag for
reproducible self-hosted deployments.

## Security model & hardening

Because Tremurex observes untrusted upstreams, it ships safe defaults you can tighten via `.env`
(see [`.env.example`](./.env.example)):

| Control                                                 | Default                                    | Tighten with                      |
| ------------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Secret redaction                                        | Always on (headers + value patterns, §7.2) | —                                 |
| Captured-body size cap                                  | 10 MiB                                     | `TREMUREX_MAX_RESPONSE_BYTES`     |
| SSRF guard (link-local / cloud-metadata always blocked) | Private ranges allowed                     | `TREMUREX_BLOCK_PRIVATE_IPS=true` |
| API authentication                                      | Off (zero-config)                          | `TREMUREX_API_TOKEN` (≥16 chars)  |
| CORS                                                    | Locked to the local UI                     | `TREMUREX_ALLOWED_ORIGINS`        |

### Deployment guidance

- Tremurex v1 has **no built-in user auth/RBAC** (a documented non-goal, §2). Run it on a trusted
  network and enable `TREMUREX_API_TOKEN` if the API is reachable beyond localhost.
- Configure outbound alert destinations (Slack/webhook/SMTP) to systems you control — those, plus
  polling the endpoints you register, are the **only** outbound calls Tremurex makes (§7.1).
- Secrets come from the environment only; never commit a real `.env`.

## Scope

In scope: core, schema-engine, proxy, web, and cli within this repository. Out of scope: the
third-party endpoints and MCP servers you choose to monitor, and your own alert destinations.
