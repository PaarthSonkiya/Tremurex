<!--
Thanks for contributing! Keep PRs to one logical change and use Conventional Commits.
See CONTRIBUTING.md and CLAUDE.md for the invariants this project must uphold.
-->

## Summary

<!-- What does this change and why? Link any related issue. -->

## Roadmap area

<!-- e.g. diff/severity engine, MCP monitoring, web UI, CI gate, schema-engine -->

## Checklist

- [ ] One logical change; Conventional Commit title
- [ ] Tests added/updated (golden fixtures for inference/diff where relevant)
- [ ] `pnpm lint` and `pnpm test` pass
- [ ] Python sidecars: `ruff` clean and `pytest` green (if touched)
- [ ] Runs under `docker compose up` with a working health check (if touched)
- [ ] README and `.env.example` updated where relevant
- [ ] Upholds the hard invariants (no phone-home, secrets redacted, deterministic, every severity
      rule tested) — `CLAUDE.md` §7

## Notes for reviewers

<!-- Edge cases, severity-classification decisions, anything you want a close look at. -->
