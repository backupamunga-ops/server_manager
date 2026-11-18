# ADR Template

Copy this file to `docs/ADR/ADR-XXX-short-title.md` and fill in.

```markdown
# ADR-XXX: Title

**Status:** proposed | accepted | superseded
**Date:** YYYY-MM-DD
**Owner:** task claimant / reviewer

## Context

What is the observed need, known constraint, or evidence driving this decision?

## Decision

What changes, where, and why?

## Alternatives considered

- Alternative A — why not
- Alternative B — why not

## Security/resource implications

Be explicit about impact on security, resource budget, or operational burden.

## Compatibility/migration

How does this affect existing data, routes, or deployments?

## Acceptance evidence

Which tests or benchmarks validate this decision?

## Links

- Task ID: CL-XXX
- PR: (link)
- Original blueprint: (reference)
```

## Index of ADRs

- `ADR-P10-stalwart-garage-lightweight.md` — Using Stalwart Mail and Garage Storage instead of external providers (user decision, lightweight Rust alternatives)
- `ADR-P12-off-host-builds-mandatory.md` — Off-host builds mandatory on 1GB VPS target
