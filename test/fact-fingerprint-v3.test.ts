/**
 * The fact fingerprint folds one explicit whitespace list on every engine (migration fact_fingerprint_v3). Postgres
 * folded the locale's [[:space:]] before, which on en_US.utf8 leaves out U+0085 and adds U+1680.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a withdrawal stored under the fingerprint Postgres computed before the migration keeps matching its
 *    claim after it (the fact guard, the withdrawal lookup and the export overlay), no stored hash is rewritten, and an
 *    active fact the new fingerprint matches to a withdrawal is expired. A page read and the export strike a fence row
 *    a pre-migration withdrawal names (an escaped cell included) and drop one a pre-migration purge tombstone names
 *    (the page's own or a '*' one), as on every engine. Every engine computes the same fingerprint.
 *  - Regression: a claim holding U+0085 exported live on Postgres although a withdrawal of it existed, and a ledger
 *    hash Postgres wrote would stop matching once the fingerprint changed; the overlay of a page read and the export
 *    hashed the new fingerprint only, so on Postgres such a fence row exported live.
 *  - Why existing coverage misses it: the fingerprint goldens hold no character the locale classes disagree on, and
 *    PGLite's [[:space:]] already is the explicit list, so only a Postgres arm can show it.
 *  - Seam: the pre-migration ledger row is written with the pre-migration fingerprint spelled out in this file (the
 *    locale's [[:space:]]), independent of the source under test. Synthetic claims only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';
import { FINGERPRINT_PUNCTUATION } from '../src/core/facts/withdrawal-schema.ts';
import { isFactWithdrawn } from '../src/core/facts/withdrawal.ts';
import { parseFactsFenceFor, renderFactsTable } from '../src/core/facts-fence.ts';
import { readExportPages, readExportWithdrawals } from '../src/core/export-snapshot.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const fence = (...claims: string[]) => renderFactsTable(claims.map((claim, i) => ({ rowNum: i + 1, claim, kind: 'fact' as const, confidence: 1,
  visibility: 'world' as const, notability: 'medium' as const, active: true, context: '' })));

/** The fingerprint before the migration: whitespace by the database locale's [[:space:]]. */
const legacyFingerprintSql = (claim: string) => `encode(sha256(convert_to(btrim(regexp_replace(regexp_replace(regexp_replace(
  translate(lower(${claim}), '${FINGERPRINT_PUNCTUATION.replace(/'/g, "''")}', '${' '.repeat([...FINGERPRINT_PUNCTUATION].length)}'),
  '[[:space:]]+', ' ', 'g'), '\\.(?=[. ]|$)', ' ', 'g'), ' +', ' ', 'g'), ' '), 'UTF8')), 'hex')`;

/** The fingerprint every engine computes: Rust's is_pg_space list, as JavaScript. */
const PG_SPACE = /[\u0009-\u000d \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+/gu;
const explicitFingerprint = (claim: string) => {
  let out = '';
  for (const ch of claim.toLowerCase()) out += FINGERPRINT_PUNCTUATION.includes(ch) ? ' ' : ch;
  out = out.replace(PG_SPACE, ' ').replace(/\.(?=[. ]|$)/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
  return createHash('sha256').update(out).digest('hex');
};

for (const backend of testBackends()) describe(`fact fingerprint v3 (${backend})`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  const expired = async (id: number) =>
    (await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [id]))[0]!.expired;

  test('the fingerprint folds the explicit whitespace list whatever the locale', async () => {
    const claims = ['Next\u0085line claim', 'Ogham\u1680space claim', 'No\u00a0break claim', 'Em\u2003space claim', 'Plain claim'];
    const rows = await engine.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) WITH ORDINALITY u(c, n) ORDER BY n', [claims]);
    expect(rows.map(r => r.fp)).toEqual(claims.map(explicitFingerprint));
  });

  test('a withdrawal stored under the pre-migration fingerprint still matches after the migration', async () => {
    const sourceId = `fpv3-${backend}-${crypto.randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
    const legacyClaim = 'Delta\u0085legacy claim', fenceClaim = 'Epsilon\u0085fence claim', newlyMatching = 'Zeta\u0085new claim';
    // A withdrawal whose claim text survives nowhere gets no twin row; only the _v2 match leg keeps it matching.
    const orphanClaim = 'Eta\u0085orphan, claim.';
    const legacyFact = await engine.insertFact({ fact: legacyClaim, visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    const newFact = await engine.insertFact({ fact: newlyMatching, visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    await engine.executeRaw('UPDATE facts SET expired_at=now() WHERE id=$1', [legacyFact.id]);
    // Ledger rows as a pre-migration Postgres wrote them: the claim, a fence-only claim, and a space-spelled claim.
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash,withdrawn_at)
      SELECT $1,'world',${legacyFingerprintSql('c')},'2026-01-02T00:00:00Z' FROM unnest($2::text[]) c ON CONFLICT DO NOTHING`,
    [sourceId, [legacyClaim, fenceClaim, 'Zeta new claim', orphanClaim]]);
    await engine.putPage('notes/fpv3', { type: 'note', title: 'Fingerprint', compiled_truth: 'Lead.\n\n' + fence(fenceClaim, legacyClaim, 'A live claim') }, { sourceId });
    const stored = async () => (await engine.executeRaw<{ fact_hash: string }>('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1 ORDER BY fact_hash', [sourceId])).map(r => r.fact_hash);
    const before = await stored();

    const migration = MIGRATIONS.find(m => m.name === 'fact_fingerprint_v3');
    expect(migration?.version).toBe(353);
    await engine.runMigration(migration!.version, migration!.sql);

    // No stored hash is rewritten; new rows only add the current fingerprint.
    const after = await stored();
    expect(after.filter(h => before.includes(h))).toEqual(before);
    for (const claim of [legacyClaim, fenceClaim]) expect(after).toContain(explicitFingerprint(claim));
    // The guard, the lookup and the export overlay match every legacy withdrawal.
    for (const claim of [legacyClaim, fenceClaim, 'Zeta new claim', newlyMatching, orphanClaim]) expect(await isFactWithdrawn(engine, sourceId, 'world', claim, null)).toBe(true);
    const reinserted = await engine.insertFact({ fact: legacyClaim, visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    expect(await expired(reinserted.id)).toBe(true);
    const orphan = await engine.insertFact({ fact: orphanClaim, visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    expect(await expired(orphan.id)).toBe(true);
    // Postgres only: the old fingerprint left U+0085 unfolded, so this active fact matched no withdrawal until the
    // migration. PGLite's old fingerprint already folded it, so the migration has nothing to expire there.
    expect(await expired(newFact.id)).toBe(backend === 'postgres');
    const page = (await engine.getPage('notes/fpv3', { sourceId }))!;
    const [snapshot] = await readExportPages(engine, [{ id: String(page.id), source_id: sourceId, slug: 'notes/fpv3' }], await readExportWithdrawals(engine, sourceId));
    expect(parseFactsFenceFor(snapshot!.page.compiled_truth, { slug: 'notes/fpv3' }).facts.map(f => [f.claim, f.forgotten ?? false]))
      .toEqual([[fenceClaim, true], [legacyClaim, true], ['A live claim', false]]);
    // The index serves the current fingerprint of a fact holding U+0085.
    const [hit] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=$3',
      [sourceId, 'world', explicitFingerprint(legacyClaim)]);
    expect(hit!.n).toBe(2);
  });

  test('running the migration a second time changes no row: the same withdrawals, fingerprints and expired facts', async () => {
    // Sync 20 moved this migration from v341 to v353; a brain may meet it again, so a rerun must be a no-op.
    const sourceId = `fpv3-${backend}-${crypto.randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
    const claims = ['Iota\u0085twice claim', 'Kappa\u0085fence claim', 'Lambda plain claim'];
    const fact = await engine.insertFact({ fact: claims[0]!, visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash,withdrawn_at)
      SELECT $1,'world',${legacyFingerprintSql('c')},'2026-01-03T00:00:00Z' FROM unnest($2::text[]) c ON CONFLICT DO NOTHING`, [sourceId, claims]);
    await engine.putPage('notes/fpv3-twice', { type: 'note', title: 'Fingerprint', compiled_truth: 'Lead.\n\n' + fence(claims[1]!, claims[2]!) }, { sourceId });
    const migration = MIGRATIONS.find(m => m.name === 'fact_fingerprint_v3')!;
    const state = async () => ({
      withdrawals: await engine.executeRaw<Record<string, unknown>>(
        `SELECT source_id, visibility, subject, fact_hash, withdrawn_at::text AS at FROM fact_withdrawals WHERE source_id=$1
         ORDER BY fact_hash, subject NULLS FIRST`, [sourceId]),
      facts: await engine.executeRaw<Record<string, unknown>>(
        'SELECT id, gbrain_fact_fingerprint(fact) AS fp, expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1 ORDER BY id', [sourceId]),
    });
    await engine.runMigration(migration.version, migration.sql);
    const once = await state();
    expect(once.facts.map(f => Number(f.id))).toContain(Number(fact.id));
    await engine.runMigration(migration.version, migration.sql);
    expect(await state()).toEqual(once);
  });

  /** A fresh source holding `slug` with a fence of `claims`, and the migration run after `ledger` wrote its pre-migration rows. */
  async function legacyPage(slug: string, claims: string[], ledger: (sourceId: string) => Promise<unknown>) {
    const sourceId = `fpv3-${backend}-${crypto.randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
    await engine.putPage(slug, { type: 'note', title: 'Fingerprint', compiled_truth: 'Lead.\n\n' + fence(...claims) }, { sourceId });
    await ledger(sourceId);
    const migration = MIGRATIONS.find(m => m.name === 'fact_fingerprint_v3')!;
    await engine.runMigration(migration.version, migration.sql);
    return sourceId;
  }
  /** The fence rows of `slug` as the export and a page read show them: [claim, struck]. */
  async function shownRows(slug: string, sourceId: string) {
    const page = (await engine.getPage(slug, { sourceId }))!;
    const [exported] = await readExportPages(engine, [{ id: String(page.id), source_id: sourceId, slug }], await readExportWithdrawals(engine, sourceId));
    const read = (await engine.readPageSnapshot(slug, { sourceId }))!;
    return [exported!.page.compiled_truth, read.page.compiled_truth]
      .map(body => parseFactsFenceFor(body, { slug }).facts.map(f => [f.claim, f.forgotten ?? false]));
  }

  test('a withdrawal stored before the migration strikes its claim in a fence cell that escapes a pipe', async () => {
    const slug = 'notes/fpv3-escaped', claim = 'Theta\u0085pipe | claim';
    const sourceId = await legacyPage(slug, [claim, 'A live claim'], id => engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash,withdrawn_at)
      VALUES ($1,'world',${legacyFingerprintSql('$2::text')},'2026-01-02T00:00:00Z')`, [id, claim]));
    expect(await shownRows(slug, sourceId)).toEqual([[[claim, true], ['A live claim', false]], [[claim, true], ['A live claim', false]]]);
  });

  test('a claim held only in a segment text keeps its twin withdrawal row, whatever the database collation', async () => {
    // The segment body is bytea; decoding it must fold by the database's collation, not C, or U+1680 stays unfolded
    // and a non-ASCII capital stays uppercased, so the twin row would be missed or hashed wrong.
    const sourceId = `fpv3-${backend}-${crypto.randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
    const claims = ['Ogham\u1680segment claim', '\u00c9lan\u0085segment claim'];
    const body = Buffer.from(fence(...claims, 'A live segment claim'), 'utf8');
    await engine.executeRaw('INSERT INTO page_segment_texts(source_id, sha256, byte_len, line_count, body) VALUES ($1, $2, $3, $4, $5)',
      [sourceId, createHash('sha256').update(body).digest(), body.length, 1, body]);
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash,withdrawn_at)
      SELECT $1,'world',${legacyFingerprintSql('c')},'2026-01-02T00:00:00Z' FROM unnest($2::text[]) c ON CONFLICT DO NOTHING`, [sourceId, claims]);
    const migration = MIGRATIONS.find(m => m.name === 'fact_fingerprint_v3')!;
    await engine.runMigration(migration.version, migration.sql);
    const stored = (await engine.executeRaw<{ fact_hash: string }>('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1', [sourceId])).map(r => r.fact_hash);
    for (const claim of claims) {
      expect(stored).toContain(explicitFingerprint(claim));
      expect(await isFactWithdrawn(engine, sourceId, 'world', claim, null)).toBe(true);
    }
    expect(await isFactWithdrawn(engine, sourceId, 'world', 'A live segment claim', null)).toBe(false);
  });

  test('a purge tombstone stored before the migration drops its claim from a fence the purge did not rewrite', async () => {
    const slug = 'notes/fpv3-stale', claim = 'Iota\u0085purged claim', global = 'Kappa\u0085global claim';
    const sourceId = await legacyPage(slug, [claim, global, 'A live claim'], id => engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,purged_at)
      SELECT $1,'world',s,${legacyFingerprintSql('c')},'2026-01-02T00:00:00Z' FROM unnest($2::text[], $3::text[]) u(c, s)`, [id, [claim, global], [slug, '*']]));
    expect(await shownRows(slug, sourceId)).toEqual([[['A live claim', false]], [['A live claim', false]]]);
  });
});
