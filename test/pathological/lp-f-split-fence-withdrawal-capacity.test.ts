/**
 * Large-pages hardening (f): a withdrawal from a facts fence a forced segment cut splits, over the rows discovery
 * checks one such fence within, is refused with a message that names the fence and the row limit.
 *
 * 1. Protects: withdrawal discovery (facts/withdrawal-discovery.ts splitFactsFences) reads a facts fence a forced
 *    cut split whole and checks every row of it in one statement, bounded by WITHDRAWAL_LIMITS.matchRows (16,384
 *    rows) and matchBytes (8 MiB). Over that bound it refuses `withdrawal_capacity` (bound unchanged) with reason
 *    `split_fence_rows`: the message names the page, its row count and the limit, says source size and the ledger
 *    are not the limit, and the fix asks the user to split the fence into fences of at most 16,384 rows.
 * 2. Fails when: the refusal is the generic one ("could not prove a bounded complete target set ... inspect the source
 *    with the host operator"), which reads as a capacity or budget problem and tells the user not to split the source.
 * 3. A purge plan (planFactPurge, what `purge_fact`'s dry run and commit run) of a claim in a 17,000-row split fence on a
 *    segmented page. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { planFactPurge, type PurgeTarget } from '../../src/core/facts/purge.ts';
import { WITHDRAWAL_LIMITS } from '../../src/core/facts/withdrawal-discovery.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const ROWS = 17_000;
const CLAIM = 'Fence Example vault code is 6201';
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const row = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
function page(): string {
  const rows = Array.from({ length: ROWS }, (_, i) => row(i + 1, `Routine note number ${i + 1} about the weekly planning meeting`));
  rows.splice(ROWS / 2, 0, row(ROWS + 1, CLAIM));
  return `---\ntitle: Fence Example\ntype: person\n---\n\n# Fence Example\n\n<!--- gbrain:facts:begin -->\n${HEADER}${rows.join('\n')}\n<!--- gbrain:facts:end -->\n\nAfter the fence.\n`;
}

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

for (const { backend, databaseUrl } of pathologicalArms()) describe(`a purge from a split fence over the row limit names the fence (${backend})`, () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-lp-f-'));
  homes.push(home);
  const env = () => ({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env(), async () => {
    if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }), 120_000);
  afterAll(async () => withEnv(env(), async () => { await disposePersistenceConsumer(engine); await close?.(); }), 120_000);

  test('withdrawal_capacity with reason split_fence_rows, the page, its rows, the limit and a split-the-fence fix', async () => {
    await withEnv(env(), async () => {
      await registerLocalWriter(engine, 'cli');
      await engine.setConfig('pages.segmented_storage', 'on');
      const slug = 'people/fence-example';
      const file = join(home, 'fence-example.md');
      writeFileSync(file, page());
      expect(await importFromFile(engine, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
      const [split] = await engine.executeRaw<{ storage: string; split: number }>(`SELECT p.body_storage AS storage,
          (SELECT count(*)::int FROM page_body_manifest m CROSS JOIN LATERAL jsonb_array_elements(m.facts_slots) s
            WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND s ? 'open_start') AS split
        FROM pages p WHERE p.source_id='default' AND p.slug=$1`, [slug]);
      expect(split).toEqual({ storage: 'segmented', split: expect.any(Number) });
      expect(split!.split).toBeGreaterThan(1);

      const [{ hash }] = await engine.executeRaw<{ hash: string }>('SELECT gbrain_fact_fingerprint($1) AS hash', [CLAIM]);
      const target: PurgeTarget = { id: 1, source_id: 'default', visibility: 'world', fact: CLAIM, entity_slug: slug, source_markdown_slug: slug,
        fact_hash: hash, embedding: null, embedding_model: null };
      let refused: unknown;
      try { await planFactPurge(engine, target, false); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(OperationError);
      const error = refused as OperationError;
      console.log(`[lp-f] ${backend}: ${error.code}: ${error.message} | ${error.suggestion}`);
      expect(error.code).toBe('withdrawal_capacity');
      expect(error.reason).toBe('split_fence_rows');
      expect(error.message).toContain(`Page ${slug} (source default) has a facts fence split across stored segments with ${ROWS + 1} rows`);
      expect(error.message).toContain(`over the ${WITHDRAWAL_LIMITS.matchRows}-row / ${WITHDRAWAL_LIMITS.matchBytes / 1024 ** 2} MiB limit`);
      expect(error.message).toContain('Source size and the withdrawal ledger are not the limit');
      expect(error.message).not.toContain('could not prove a bounded complete target set');
      expect(error.suggestion).toContain(`Split that facts fence into smaller fences of at most ${WITHDRAWAL_LIMITS.matchRows} rows each`);
      expect(error.suggestion).not.toContain('split/delete the source');
      const wire = JSON.parse(JSON.stringify(error)) as { fix?: { next?: string; user_message?: string; verify?: { argv?: string[] } } };
      expect(wire.fix?.next).toBe('ask_user');
      expect(wire.fix?.user_message).toContain(`Page ${slug} has a facts fence of ${ROWS + 1} rows`);
      expect(wire.fix?.verify?.argv).toEqual(['gbrain', 'get', '--source', 'default', '--', slug]);
    });
  }, 600_000);
});
