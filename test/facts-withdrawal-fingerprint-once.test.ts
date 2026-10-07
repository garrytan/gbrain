/**
 * #5725: withdrawal overlay lookups fingerprint each incoming claim once.
 *
 * Protects: the withdrawn-row overlay (preserveWithdrawnFenceRows) and the
 * malformed-fence guard (assertPreparedFactWithdrawals) keep their exact
 * matching rules after the fingerprints moved into a MATERIALIZED CTE:
 * current and legacy (v1) fingerprints both match, visibility and subject
 * scope the match, and the earliest withdrawal date wins, on a page with
 * many fence rows against many unrelated withdrawals.
 * Fails when: the rewrite drops the v1 fingerprint, ignores visibility or
 * subject, or collapses rows onto the wrong row number.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { assertPreparedFactWithdrawals, preserveWithdrawnFenceRows } from '../src/core/facts/withdrawal.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SUBJECT = 'people/alice-example';

function row(rowNum: number, claim: string, visibility: 'world' | 'private' = 'world'): ParsedFact {
  return { rowNum, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', validFrom: '2026-01-01', source: 'chat', active: true };
}

async function withdraw(engine: BrainEngine, claim: string, opts: { visibility?: string; subject?: string; at?: string; legacy?: boolean } = {}) {
  await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash, withdrawn_at)
    VALUES ('default', $1, $2, ${opts.legacy ? 'gbrain_fact_fingerprint_v1($3)' : 'gbrain_fact_fingerprint($3)'}, $4::timestamptz)`,
  [opts.visibility ?? 'world', opts.subject ?? SUBJECT, claim, opts.at ?? '2026-03-01T00:00:00Z']);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: the overlay strikes exactly the withdrawn rows among many`, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      for (let i = 0; i < 400; i++) await withdraw(engine, `Unrelated withdrawn claim ${i}`, { subject: i % 2 ? '*' : `people/other-${i}` });
      const facts = Array.from({ length: 28 }, (_, i) => row(i + 1, `Alice example fact number ${i + 1}`));
      facts[2] = row(3, 'Prefers email');
      facts[5] = row(6, 'Lives in Lisbon');
      facts[8] = row(9, 'Has a private budget', 'private');
      facts[11] = row(12, 'Plays chess');
      await withdraw(engine, 'Prefers email', { at: '2026-03-05T00:00:00Z' });
      await withdraw(engine, 'prefers   EMAIL', { at: '2026-02-10T00:00:00Z', subject: '*' });
      await withdraw(engine, 'Lives in Lisbon', { legacy: true });
      await withdraw(engine, 'Has a private budget', { visibility: 'world' });
      await withdraw(engine, 'Plays chess', { subject: 'people/bob-example' });

      const body = `# Alice Example\n\n## Facts\n\n${renderFactsTable(facts)}\n`;
      const overlaid = parseFactsFence(await preserveWithdrawnFenceRows(engine, 'default', body, SUBJECT)).facts;
      expect(overlaid.filter(f => !f.active).map(f => [f.rowNum, f.validUntil])).toEqual([[3, '2026-02-10'], [6, '2026-03-01']]);
      expect(overlaid.map(f => f.claim)).toEqual(facts.map(f => f.claim));
      const forBob = parseFactsFence(await preserveWithdrawnFenceRows(engine, 'default', body, 'people/bob-example')).facts;
      expect(forBob.filter(f => !f.active).map(f => [f.rowNum, f.validUntil])).toEqual([[3, '2026-02-10'], [12, '2026-03-01']]);
    } finally { await close(); }
  }, 60_000);

  test(`${backend}: a malformed fence holding a withdrawn claim is refused, scoped by visibility`, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      for (let i = 0; i < 400; i++) await withdraw(engine, `Unrelated withdrawn claim ${i}`);
      await withdraw(engine, 'Prefers email', { legacy: true });
      const unbalanced = (visibility: string) => `# Alice Example\n\n<!--- gbrain:facts:begin -->\n` +
        `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n` +
        `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n` +
        `| 1 | Prefers email | preference | 1.0 | ${visibility} | medium | 2026-01-01 |  | chat |  |\n`;
      // #6188 (E6): the wire code stays invalid_params; the canonical code is the typed fence refusal.
      await expect(assertPreparedFactWithdrawals(engine, 'default', unbalanced('world'), '', SUBJECT)).rejects.toMatchObject({ code: 'invalid_params', canonical: 'invalid_fence',
        reason: 'withdrawn_claim_in_malformed_fence' });
      await expect(assertPreparedFactWithdrawals(engine, 'default', unbalanced('private'), '', SUBJECT)).resolves.toBeUndefined();
      await expect(assertPreparedFactWithdrawals(engine, 'default', unbalanced('world'), '', 'people/bob-example')).resolves.toBeUndefined();
    } finally { await close(); }
  }, 60_000);
}
