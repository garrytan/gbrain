# Page identity and writer administration

[Back to the index](../KEY_FILES.md). Read this contract alongside the
[page-operation entries](core-services-2.md) when changing source identity,
snapshot selection, or deliberate ownership administration.

Binding owner epochs and topology generations are cast to exact decimal strings
before resident IPC serialization, preserving values above JavaScript's safe
integer range. Reviewed admin-state fingerprints include legacy-lock identity.
Self-transfer preparation records physical before-state and intended repair in
a durable manifest; acceptance checks root, epoch, manifest and coordination
path under the native lock from the database binding. A private token-bound
temporary stamp is byte-verified before rename; changed tokens and malformed
records refuse without deleting uncertain state. Regression coverage:
`test/persistence-admin-recovery.test.ts`, `test/persistence-onboarding.test.ts`,
`test/persistence-container-preflight.test.ts`.

- `src/core/deep-research-id.ts` — canonical `gbrain-page:v1:` handles encode a
  JSON pair of source ID and slug in unpadded base64url. The decoder rejects
  malformed or noncanonical encodings rather than treating them as legacy
  slugs. IDs are logical addresses, not credentials, revisions or encrypted
  metadata. Citation URLs escape each path segment. See the
  [wire protocol](../../protocol/DEEP_RESEARCH_IDS_v1.md).
- `src/core/persistence/admin-intent.ts` — whole-brain topology fingerprints
  bind a deliberate writer action to inspected state. Administration requires
  an exact action name and a fresh fingerprint; the mutation transaction
  rechecks it under metadata locks. Generic confirmation and terminal presence
  are not substitutes. This protects routine repair from accidental topology
  changes, not against a malicious trusted local administrator. Read the
  [operator procedure](../topologies.md) before changing its preconditions.

`stampDeepResearchIds` uses each result's own source, including query fallback
and image paths. `fetch` independently applies the current source grant and
visibility policy. Legacy slugs resolve only when one readable live page
matches; snapshot content, identity and ambiguity count come from one SQL
statement. An encoded ID never falls back to another source. Source aliases
remain source-bound.

`writer_status` reads an existing host identity without creating one. Claim,
activate and transfer are explicit local administration paths; ordinary page
errors, startup and `doctor --fix` lead with inspection, not ownership changes.
The CLI uses the shared BigInt replacer when rendering PostgreSQL epochs.

Behavioral coverage lives in `test/helpers/deep-research-contract.ts`, its
PGLite/Postgres callers, `test/e2e/deep-research-http.test.ts` (live OAuth
rescoping/revocation), `test/deep-research-cli.test.ts`,
`test/persistence-admin-intent.test.ts`, and
`test/e2e/persistence-admin-intent.test.ts` (actual routine and deliberate CLI
sequences). These tests establish the exercised boundaries, not a universal
authorization guarantee.

## Installation and metadata migrations

The upgrade and migration command entries also carry the memory-only opt-out:
`GBRAIN_NO_AUTOPILOT_INSTALL=1` / `--no-autopilot-install` is propagated through
package installation, post-upgrade and migration orchestration. It skips service
installation and unit rewrites, not unrelated migration work. Paid reindexing
has its own `GBRAIN_NO_REEMBED=1` control.

The grandfathering batch in `src/commands/migrations/v0_13_1.ts` changes only
`frontmatter.validate`. It holds canonical page guards and row locks, rechecks
eligibility, and advances the text seal only for already-sealed snapshots.
An unsealed page stays unsealed. This preserves keyword retrieval after a
metadata-only upgrade without bypassing revision safety. The installed-lifecycle
test and `test/e2e/grandfather-projection-postgres.test.ts` cover the actual
upgrade consequence and engine parity respectively.
