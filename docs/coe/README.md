# CoE Lite contracts

This directory records the accepted architecture decisions for the CoE Lite contract layer.
The executable source of truth is [`src/coe/contracts`](../../src/coe/contracts), and the
generated JSON Schema artifacts are under [`schemas/coe/v1`](../../schemas/coe/v1).

Phase 1 freezes the data contracts. Phase 2 adds the immutable raw snapshot ledger and rebuildable
SQL projections. Phase 3 adds deterministic normalization, raw-to-normalized mappings, canonical
EvidenceItems, and their rebuildable SQL projections. Claim retrieval and release automation remain
outside this boundary.

## Contract boundary

- Version: `1.0.0`.
- JSON Schema dialect: Draft 2020-12.
- Unknown object fields: rejected at every modeled object boundary.
- Canonicalization: `coe-c14n-json-v1`.
- Identifiers and integrity hashes: SHA-256.
- Numeric measurements: decimal strings when exact representation matters.
- Access propagation: derived artifacts may preserve or narrow scope, never widen it.
- Release policy: fail closed when evidence or verification is incomplete.

See [CONTRACTS.md](CONTRACTS.md), [VERSIONING.md](VERSIONING.md),
[MIGRATION_CONSTRAINTS.md](MIGRATION_CONSTRAINTS.md), the non-blocking
[OPEN_QUESTIONS.md](OPEN_QUESTIONS.md), the [snapshot ledger](SNAPSHOT_LEDGER.md), the
[evidence ledger](EVIDENCE_LEDGER.md), and the accepted [architecture decisions](adr/).

## Rebuild and check

```bash
bun run build:coe-schemas
bun run check:coe-schemas
bun run check:coe-pilot
bun test test/coe-contracts.test.ts
bun test test/coe-snapshot-ledger.test.ts test/coe-http-acquisition.test.ts test/coe-pilot-acquisition.test.ts
bun test test/coe-evidence-ledger.test.ts
COE_PARSER_E2E=1 bun test test/e2e/coe-document-parsers-local.test.ts
```

Generated schemas are review artifacts. A source change that makes them stale fails the
repository verification command.
