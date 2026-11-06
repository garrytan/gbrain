import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-1113 (gaps 1+2 of the internal QM provider): attest_sources, the
// sources an attested memory_write may name per call (source_id), beside
// attest_actor and attest_ops (v286). NULL = none: the credential writes only
// its own source, as before. A source listed here is a scope source: it holds
// a shared scope's memory page (memory/scope) and no credential that does not
// list it may read it (enforced on every grant write, access/attest-sources.ts).
// Database only, so a repo-less brain gets it unchanged. Nothing is rewritten
// on upgrade. No schema.sql mirror: like v286, these exist only through
// migrations.
export const v293: Migration = {
  version: 293,
  name: 'qm_attest_sources',
  idempotent: true,
  sql: `
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS attest_sources TEXT[];
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS attest_sources TEXT[];
`,
};
