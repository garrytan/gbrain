# Upstream Pinning Policy — confer/gbrain

**Upstream:** https://github.com/garrytan/gbrain
**Pinned SHA:** 42d99b6fca3b5270f664dd61b8b1e3091e493760
**Pinned at:** 2026-05-27

## Rebase cadence

Quarterly. Aether (fork maintainer) runs:

```bash
git fetch upstream
git rebase upstream/master  # NOT upstream/main — gbrain default is master
# resolve any conflicts with Confer migrations under src/migrations/
bun test  # must pass before push
git push --force-with-lease origin confer/main
```

## Maintainer chain

Per Confer-OS spec §5 row 4:
1. **Aether** (S7) — operational maintainer; reviews PRs, runs quarterly rebase
2. **Vulcan** (MacStudio) — ultimate authority on fork policy; override on Aether decisions
3. **Yatin** — escalation for policy / scope changes

## Confer-local additions (DO NOT remove on rebase)

- `src/migrations/0001_confer_rls.sql` through `0004_confer_source_config_keys.sql`
- `src/migrations/down/0001_*.down.sql` through `0004_*.down.sql`
- `tests/migrations/*.test.ts`
- `tests/load/*`

All other files track upstream exactly.

## Linking to the spec

Authoritative spec: `~/Workspace/temporary/docs/superpowers/specs/2026-05-27-confer-gbrain-gstack-os-design.md` (committed in the principal's workspace; canonical mirror lands in `ConferInc/agent-ops/specs/` post-SP-0).
