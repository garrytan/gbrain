/** #10178: the relower never lowers a claim-channel row the owner confirmed (write_origin.owner_decision). */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { recordSourceClaims } from '../src/core/trust/claim.ts';
import { relowerClaimedRows } from '../src/core/trust/backfill.ts';
import { withTrustBackfill } from '../src/core/persistence/context.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';

let engine: BrainEngine;
beforeAll(async () => {
  const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema(); engine = pg;
  await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
    JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('relower skips a claim-channel row carrying an owner_decision', async () => {
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES('own','own','/home/alice-example/notes')`);
  const fm = JSON.stringify({ type: 'atom', extracted_by: 'extract_atoms-v0.41.2.1', source_slug: 'originals/x' });
  const id = Number((await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES('atoms/2026-09-07/x','atom','T','Body.','own',$1::text::jsonb) RETURNING id`,
    [fm]))[0]!.id);
  await recordSourceClaims(engine, ['own']);
  const origin = JSON.stringify({ channel: 'trust_claim', owner_decision: { tier: 'user_confirmed' } });
  await engine.transaction(tx => withTrustBackfill(tx, () =>
    tx.executeRaw(`UPDATE pages SET trust_tier='operator_curated', write_origin=$2::text::jsonb WHERE id=$1`, [id, origin])));

  const preview = await relowerClaimedRows(engine, { dryRun: true });
  expect(preview.rows).toBe(0);
  await relowerClaimedRows(engine);
  const [row] = await engine.executeRaw<{ t: string; o: string | null }>(
    `SELECT trust_tier t, write_origin->'owner_decision'->>'tier' o FROM pages WHERE id=$1`, [id]);
  expect(row).toEqual({ t: 'operator_curated', o: 'user_confirmed' });
});
