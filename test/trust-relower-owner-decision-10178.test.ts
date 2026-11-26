/**
 * #10178: `trust claim-sources --relower` (which doctor `trust_sources_unclaimed` offers as an agent-runnable fix) lowers
 * only rows the claim lifted that nobody decided since. A row the owner confirmed keeps its tier and its owner_decision,
 * and a row on a page the owner confirmed is not lowered through that page either.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { recordSourceClaims } from '../src/core/trust/claim.ts';
import { relowerClaimedRows } from '../src/core/trust/backfill.ts';
import { setRowTier } from '../src/core/trust/page-handlers.ts';
import { withTrustBackfill } from '../src/core/persistence/context.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) {
  describe(`#10178 the relower leaves owner decisions alone (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
        JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
    }, 120_000);
    afterAll(async () => { await close(); });

    const atom = async (slug: string) => {
      const [page] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(slug, type, title, compiled_truth, source_id, frontmatter)
        VALUES($1, 'atom', 'Atom', 'Body.', 'own', $2::text::jsonb) RETURNING id`,
        [slug, JSON.stringify({ type: 'atom', extracted_by: 'extract_atoms-v0.41.2.1', source_slug: 'originals/x' })]);
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, row_num)
        VALUES('own', $1, 'A claim on ' || $1, 'fact', 'world', 'test', $1, 1) RETURNING id`, [slug]);
      return { page: Number(page!.id), fact: Number(fact!.id) };
    };
    const state = async (table: 'pages' | 'facts', id: number) => (await engine.executeRaw<{ tier: string; decided: string | null }>(
      `SELECT trust_tier AS tier, write_origin->'owner_decision'->>'tier' AS decided FROM ${table} WHERE id = $1`, [id]))[0];

    test('a confirmed page, a fact on it and a confirmed fact keep their tiers; the undecided page is lowered', async () => {
      await engine.executeRaw(`INSERT INTO sources(id, name, local_path) VALUES('own', 'own', '/home/alice-example/notes')`);
      const a = await atom('atoms/2026-09-07/a');
      const b = await atom('atoms/2026-09-07/b');
      await recordSourceClaims(engine, ['own']);
      // A claim that ran before extracted_by was a signal (#6533) lifted every one of these rows to "your notes".
      await engine.transaction(tx => withTrustBackfill(tx, async () => {
        for (const table of ['pages', 'facts']) {
          await tx.executeRaw(`UPDATE ${table} SET trust_tier = 'operator_curated', write_origin = '{"channel":"trust_claim"}'::jsonb WHERE id = ANY($1::bigint[])`,
            [table === 'pages' ? [a.page, b.page] : [a.fact, b.fact]]);
        }
      }));
      expect(await setRowTier(engine, { table: 'pages', id: a.page, sourceId: 'own', tier: 'user_confirmed', ceiling: 'user_confirmed' })).toBe(true);
      expect(await setRowTier(engine, { table: 'facts', id: b.fact, sourceId: 'own', tier: 'user_confirmed', ceiling: 'user_confirmed' })).toBe(true);

      const preview = await relowerClaimedRows(engine, { dryRun: true });
      expect(preview.rows).toBe(1);
      expect(preview.sample).toEqual([{ source_id: 'own', slug: 'atoms/2026-09-07/b', from: 'operator_curated', to: 'agent_written' }]);
      expect((await relowerClaimedRows(engine)).rows).toBe(1);

      expect(await state('pages', a.page)).toEqual({ tier: 'user_confirmed', decided: 'user_confirmed' });
      expect(await state('facts', a.fact)).toEqual({ tier: 'operator_curated', decided: null });
      expect(await state('pages', b.page)).toEqual({ tier: 'agent_written', decided: null });
      expect(await state('facts', b.fact)).toEqual({ tier: 'user_confirmed', decided: 'user_confirmed' });
      expect((await relowerClaimedRows(engine, { dryRun: true })).rows).toBe(0);
    }, 120_000);

    // Postgres only: PGLite runs one connection, so the two transactions cannot overlap there.
    test.skipIf(kind !== 'postgres')('an owner decision that commits while the relower waits on the row survives it', async () => {
      const c = await atom('atoms/2026-09-07/c');
      await engine.transaction(tx => withTrustBackfill(tx, () => tx.executeRaw(
        `UPDATE facts SET trust_tier = 'operator_curated', write_origin = '{"channel":"trust_claim"}'::jsonb WHERE id = $1`, [c.fact])));
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const holdsRow = new Promise<void>(resolve => { locked = resolve; });
      const confirm = engine.transaction(async tx => {
        expect(await setRowTier(tx, { table: 'facts', id: c.fact, sourceId: 'own', tier: 'user_confirmed', ceiling: 'user_confirmed' })).toBe(true);
        locked();
        await released;
      });
      await holdsRow;
      const relower = relowerClaimedRows(engine);
      await new Promise(resolve => setTimeout(resolve, 1_000));
      release();
      await confirm;
      await relower;
      expect(await state('facts', c.fact)).toEqual({ tier: 'user_confirmed', decided: 'user_confirmed' });
    }, 120_000);
  });
}
