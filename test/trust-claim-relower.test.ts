/**
 * #6533 repair (D16): brains that ran `trust claim-sources` before extracted_by
 * was a signal hold legacy extract_atoms atoms at operator_curated. The
 * lower-only `claim-sources --relower` pass returns exactly the claim-lifted
 * rows whose own signals now rank lower, never raises, never touches rows a
 * claim did not lift, previews the same rows it applies, and doctor names it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { relowerClaimedRows } from '../src/core/trust/backfill.ts';
import { withTrustBackfill } from '../src/core/persistence/context.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';
import { trustSourcesUnclaimedEntry } from '../src/commands/doctor/checks/trust-sources-unclaimed.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: BrainEngine;
beforeAll(async () => {
  const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema(); engine = pg;
  await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
    JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const tier = async (table: string, id: number) =>
  (await engine.executeRaw<{ t: string; c: string | null }>(`SELECT trust_tier t, write_origin->>'channel' c FROM ${table} WHERE id=$1`, [id]))[0]!;
const doctor = async () => ((await trustSourcesUnclaimedEntry.run({ engine } as never)) as Check[])[0]!;

test('relower lowers only claim-lifted rows whose own signals rank lower, and doctor guides it', async () => {
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES('own','own','/home/alice-example/notes')`);
  const page = async (slug: string, type: string, fm: object) => Number((await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES($1,$2,'T','Body.','own',$3::text::jsonb) RETURNING id`,
    [slug, type, JSON.stringify(fm)]))[0]!.id);
  const atomFm = { type: 'atom', extracted_by: 'extract_atoms-v0.41.2.1', source_slug: 'originals/x' };
  const atom = await page('atoms/2026-09-07/x', 'atom', atomFm);
  const syncedAtom = await page('atoms/2026-09-07/synced', 'atom', atomFm);
  const plain = await page('notes/plain', 'note', {});
  const entry = Number((await engine.executeRaw<{ id: number }>(
    `INSERT INTO timeline_entries(page_id,date,summary) VALUES($1,'2026-09-07','Atom event') RETURNING id`, [atom]))[0]!.id);
  await recordSourceClaims(engine, ['own']);
  // What a claim did before #6533: the atoms and the atom's timeline row lifted to "your notes".
  const stamp = (table: string, id: number, to: string, channel: string) => engine.transaction(tx => withTrustBackfill(tx, () =>
    tx.executeRaw(`UPDATE ${table} SET trust_tier=$2, write_origin=$3::text::jsonb WHERE id=$1`, [id, to, JSON.stringify({ channel })])));
  await stamp('pages', atom, 'operator_curated', 'trust_claim');
  await stamp('timeline_entries', entry, 'operator_curated', 'trust_claim');
  await stamp('pages', syncedAtom, 'operator_curated', 'managed_sync');
  await liftClaimedSources(engine);
  expect((await tier('pages', plain)).t).toBe('operator_curated');

  const check = await doctor();
  expect(check.status).toBe('warn');
  expect(check.message).toContain('gbrain trust claim-sources --relower');
  expect(check.fix?.argv).toEqual(['gbrain', 'trust', 'claim-sources', '--relower']);

  const before = JSON.stringify(await engine.executeRaw(`SELECT id, trust_tier, write_origin FROM pages ORDER BY id`));
  const preview = await relowerClaimedRows(engine, { dryRun: true });
  expect(JSON.stringify(await engine.executeRaw(`SELECT id, trust_tier, write_origin FROM pages ORDER BY id`))).toBe(before);
  expect(preview.rows).toBe(2);
  expect(preview.sample).toEqual([{ source_id: 'own', slug: 'atoms/2026-09-07/x', from: 'operator_curated', to: 'agent_written' }]);

  const applied = await relowerClaimedRows(engine);
  expect({ ...applied, mode: 'dry_run' }).toEqual(preview);
  expect(await tier('pages', atom)).toEqual({ t: 'agent_written', c: 'trust_relower' });
  expect(await tier('timeline_entries', entry)).toEqual({ t: 'agent_written', c: 'trust_relower' });
  expect(await tier('pages', syncedAtom)).toEqual({ t: 'operator_curated', c: 'managed_sync' });
  expect(await tier('pages', plain)).toEqual({ t: 'operator_curated', c: 'trust_claim' });

  expect((await relowerClaimedRows(engine, { dryRun: true })).rows).toBe(0);
  expect((await doctor()).status).toBe('ok');
});
