import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { runTrustBackfill } from '../src/core/trust/backfill.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';

let engine: BrainEngine;
beforeAll(async () => {
  const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema(); engine = pg;
  await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
    JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('#6533 claim never lifts a legacy extract_atoms page to operator_curated; backfill classifies it', async () => {
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES('own','own','/home/alice-example/notes')`);
  const ins = async (slug: string, fm: object) => Number((await engine.executeRaw<{ id: number }>(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter)
      VALUES($1,'atom','T','An atom.', 'own', $2::text::jsonb) RETURNING id`, [slug, JSON.stringify(fm)]))[0]!.id);
  const atom = await ins('atoms/2026-09-07/x', { type: 'atom', extracted_by: 'extract_atoms-v0.41.2.1', extracted_at: '2026-09-07T00:17:03.757Z', source_slug: 'originals/x' });
  const unclaimed = await ins('atoms/2026-09-07/y', { type: 'atom', extracted_by: 'extract_atoms-v0.41.2.1', source_slug: 'originals/y' });
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES('other','other','/home/alice-example/other')`);
  await engine.executeRaw(`UPDATE pages SET source_id='other' WHERE id=$1`, [unclaimed]);
  await runTrustBackfill(engine, { sources: ['other'] });
  await recordSourceClaims(engine, ['own']);
  await liftClaimedSources(engine);
  const tier = async (id: number) => (await engine.executeRaw<{ t: string }>(`SELECT trust_tier t FROM pages WHERE id=$1`, [id]))[0]!.t;
  expect(await tier(atom)).toBe('agent_written');
  expect(await tier(unclaimed)).toBe('agent_written');
});
