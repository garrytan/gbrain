import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { runTrustBackfill } from '../src/core/trust/backfill.ts';
import { frontmatterTrustCapsSql } from '../src/core/trust/channel.ts';
import { previewMarkerRepair } from '../src/core/trust/marker-repair.ts';
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

test('a legacy claimed page with a trust_tier: unknown marker is classified from its signals, so the marker repair can see it', async () => {
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES('marked','marked','/home/alice-example/marked')`);
  const ins = async (slug: string, sourceKind: string | null, fm: object) => Number((await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages(slug,type,title,compiled_truth,source_id,source_kind,frontmatter)
      VALUES($1,'note','T','A note.', 'marked', $2, $3::text::jsonb) RETURNING id`, [slug, sourceKind, JSON.stringify(fm)]))[0]!.id);
  const agent = await ins('notes/unknown-agent', 'mcp:put_page', { trust_tier: 'unknown' });
  const plain = await ins('notes/unknown-plain', null, { trust_tier: 'unknown' });
  const lower = await ins('notes/external-agent', 'mcp:put_page', { trust_tier: 'external_untrusted' });
  const agentMarker = await ins('notes/agent-marker', null, { trust_tier: 'agent_written' });
  await recordSourceClaims(engine, ['marked']);
  await liftClaimedSources(engine);
  const tier = async (id: number) => (await engine.executeRaw<{ t: string }>(`SELECT trust_tier t FROM pages WHERE id=$1`, [id]))[0]!.t;
  // The unknown marker is no cap: agent signals classify the page, and a page with no signal is the owner's.
  expect(await tier(agent)).toBe('agent_written');
  expect(await tier(plain)).toBe('operator_curated');
  // Markers naming a real lower tier still cap.
  expect(await tier(lower)).toBe('external_untrusted');
  expect(await tier(agentMarker)).toBe('agent_written');
  // The pages keep their marker, now below the stored tier: exactly what the repair lists.
  const preview = await previewMarkerRepair(engine, { sourceId: 'marked' });
  expect(preview.candidates.map(c => [c.slug, c.marker, c.stored_tier])).toEqual([
    ['notes/unknown-agent', 'unknown', 'agent_written'],
    ['notes/unknown-plain', 'unknown', 'operator_curated'],
  ]);
});

test('the SQL frontmatter caps can leave out an unknown marker and nothing else', async () => {
  const rank = async (fm: object, opts?: { ignoreUnknownMarker?: boolean }) => {
    const [row] = await engine.executeRaw<{ r: number | null }>(
      `SELECT LEAST(${frontmatterTrustCapsSql('v.fm', opts).join(', ')}) AS r FROM (SELECT $1::text::jsonb AS fm) v`, [JSON.stringify(fm)]);
    return row!.r === null ? null : Number(row!.r);
  };
  expect(await rank({ trust_tier: 'unknown' })).toBe(2);
  expect(await rank({ trust_tier: 'unknown' }, { ignoreUnknownMarker: true })).toBeNull();
  expect(await rank({ trust_tier: 'unknown', provenance: 'auto-extracted' }, { ignoreUnknownMarker: true })).toBe(3);
  expect(await rank({ trust_tier: 'external_untrusted' }, { ignoreUnknownMarker: true })).toBe(1);
});
