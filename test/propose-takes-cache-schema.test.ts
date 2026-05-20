/**
 * v0.37.1.1 — propose_takes scan-cache schema regression tests.
 *
 * The phase's cost bug was structural: `take_proposals` doubled as both the
 * operator-facing proposal queue and the per-page idempotency cache. That cannot
 * represent the successful zero-proposal result (`[]`). These tests pin the
 * schema split so future refactors cannot silently collapse the two surfaces
 * again.
 */

import { describe, test, expect } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

describe('propose_takes scan-cache schema', () => {
  test('migration creates scan cache and moves proposal dedup to claim_text', () => {
    const migration = MIGRATIONS.find(m => m.name === 'take_proposal_page_scans_v0_37_1_1');
    expect(migration).toBeDefined();
    expect(migration!.version).toBe(80);
    expect(migration!.sql).toContain('DROP INDEX IF EXISTS take_proposals_idempotency_idx');
    expect(migration!.sql).toContain('CREATE TABLE IF NOT EXISTS take_proposal_page_scans');
    expect(migration!.sql).toContain('PRIMARY KEY (source_id, page_slug, content_hash, prompt_version)');
    expect(migration!.sql).toContain('take_proposals_proposal_dedup_idx');
    expect(migration!.sql).toContain('(source_id, page_slug, content_hash, prompt_version, claim_text)');
    expect(migration!.sql).toContain('ALTER TABLE take_proposal_page_scans ENABLE ROW LEVEL SECURITY');
  });

  test('fresh Postgres schema contains the same split', () => {
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS take_proposal_page_scans');
    expect(SCHEMA_SQL).toContain('take_proposals_proposal_dedup_idx');
    expect(SCHEMA_SQL).toContain('ALTER TABLE take_proposal_page_scans ENABLE ROW LEVEL SECURITY');
    expect(SCHEMA_SQL).not.toContain('take_proposals_idempotency_idx');
  });

  test('fresh PGLite schema contains the same split', () => {
    expect(PGLITE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS take_proposal_page_scans');
    expect(PGLITE_SCHEMA_SQL).toContain('take_proposals_proposal_dedup_idx');
    expect(PGLITE_SCHEMA_SQL).not.toContain('take_proposals_idempotency_idx');
  });
});
