import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { drainProjections, previewProjectionDrain, readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from '../src/core/embedding-invalidation.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { safeChunksRepair } from '../src/core/repair/safe-chunks.ts';
import { parseRepairArgs } from '../src/commands/repair.ts';
import { validateProjectionEmbedArgs } from '../src/core/embed-projection-args.ts';
import { embedStaleImages } from '../src/core/embed-stale-images.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let serial = 0;
const vector = new Float32Array(1536).fill(0.001);

beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

async function source(engine: BrainEngine) {
  await engine.unsetConfig('embed.current_projections_only');
  const sourceId = `projection-hold-${++serial}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  return sourceId;
}
async function seed(engine: BrainEngine, sourceId: string, slug: string, opts: { legacy?: boolean; queued?: boolean; vector?: boolean } = {}) {
  const body = `Synthetic text for ${slug}.`;
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
  const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
  if (opts.vector) await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1',
    [prepared.snapshot.page.id, `[${Array.from(vector).join(',')}]`, prepared.embeddingModel]);
  if (opts.legacy) await engine.executeRaw('UPDATE pages SET chunker_version=3 WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  if (opts.queued) {
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
    await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id=$1 AND p.slug=$2
      ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason`, [sourceId, slug]);
  }
}
async function chunkState(engine: BrainEngine, sourceId: string, slug: string) {
  return engine.executeRaw(`SELECT c.id,c.chunk_text,c.model,c.embedding::text AS embedding,c.embedded_text_hash,c.embedded_at
    FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY c.chunk_index`, [sourceId, slug]);
}

test('resident and normal drain hold historical work; owner override rebuilds and preserves the unchanged vector', async () => {
  for (const engine of engines) {
    const id = await source(engine);
    await seed(engine, id, 'old', { legacy: true, queued: true, vector: true });
    const before = await chunkState(engine, id, 'old');
    await engine.setConfig('embed.current_projections_only', 'true');
    await engine.putPage('new', { type: 'note', title: 'new', compiled_truth: 'A new note.' }, { sourceId: id });
    expect((await previewProjectionDrain(engine)).rows.map(row => row.slug)).toContain('new');
    expect((await previewProjectionDrain(engine)).rows.map(row => row.slug)).not.toContain('old');
    expect(await rebuildPendingPageProjections(engine, 100)).toEqual({ rebuilt: 1, superseded: 0 });
    expect(await chunkState(engine, id, 'old')).toEqual(before);
    const held = await drainProjections(engine);
    expect(held.held).toBeGreaterThanOrEqual(1);
    expect(await chunkState(engine, id, 'old')).toEqual(before);
    await expect(engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id=$1 AND slug=$2', [id, 'old']))
      .rejects.toThrow(/historical_projection_held/);
    const preview = await previewProjectionDrain(engine, 100, { currentProjectionsOnly: false });
    expect(preview.rows.some(row => row.source_id === id && row.slug === 'old')).toBe(true);
    const result = await drainProjections(engine, { currentProjectionsOnly: false });
    expect(result.rebuilt).toBeGreaterThanOrEqual(1);
    expect(await chunkState(engine, id, 'old')).toEqual(before);
    const [page] = await engine.executeRaw<{ sealed: boolean }>('SELECT text_projection_revision=knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug=$2', [id, 'old']);
    expect(page.sealed).toBe(true);
    expect(await engine.executeRaw("SELECT COALESCE(current_setting('gbrain.current_projections_only_override',true),'') AS value")).toEqual([{ value: '' }]);
  }
}, 120_000);

test('historical reasons survive a canonical update and the safe-chunks repair requires an explicit override', async () => {
  for (const engine of engines) {
    const id = await source(engine);
    await seed(engine, id, 'old', { legacy: true, queued: true });
    await engine.setConfig('embed.current_projections_only', 'true');
    await engine.putPage('old', { type: 'note', title: 'old', compiled_truth: 'Edited synthetic text.' }, { sourceId: id });
    expect(await engine.executeRaw('SELECT reason FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation WHERE s.id=$1 AND j.slug=$2', [id, 'old']))
      .toEqual([{ reason: 'protocol_activation' }]);
    const scope = { brain_id: 'test', source_ids: [id] };
    const held = await safeChunksRepair.plan(engine, scope, null, { apply: false });
    expect(held.items).toEqual([]);
    expect(held.residuals.historical_projection_held).toBe(1);
    const authorized = await safeChunksRepair.plan(engine, scope, null, { apply: true, currentProjectionsOnly: false });
    expect(authorized.items.map(item => item.slug)).toEqual(['old']);
    const ctx = { engine, sourceId: id, logger: { info() {}, warn() {}, error() {} } } as never;
    expect(await safeChunksRepair.apply(ctx, authorized.items[0]!, { embed: false })).toBe(false);
    expect(await safeChunksRepair.apply(ctx, authorized.items[0]!, { embed: false, currentProjectionsOnly: false })).toBe(true);
  }
}, 120_000);

test('stale selectors and both invalidation paths leave unsafe and unsealed vectors untouched', async () => {
  for (const engine of engines) {
    const id = await source(engine);
    await seed(engine, id, 'current', { vector: true });
    await seed(engine, id, 'old', { legacy: true, vector: true });
    await seed(engine, id, 'pending', { queued: true, vector: true });
    await engine.executeRaw("UPDATE pages SET embedding_signature='example:old:1536' WHERE source_id=$1", [id]);
    await engine.executeRaw("UPDATE content_chunks SET model='example:old',embedded_text_hash=md5('earlier') WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)", [id]);
    await engine.setConfig('embed.current_projections_only', 'true');
    const before = [...await chunkState(engine, id, 'old'), ...await chunkState(engine, id, 'pending')];
    expect(await engine.countStaleChunks({ sourceId: id, signature: 'example:new:1536' })).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: id, signature: 'example:new:1536', currentProjectionsOnly: false })).toBe(3);
    expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, { sourceId: id, signature: 'example:new:1536' })).toBe(1);
    expect(await engine.invalidateContentDriftEmbeddings({ sourceId: id })).toBe(0);
    expect([...await chunkState(engine, id, 'old'), ...await chunkState(engine, id, 'pending')]).toEqual(before);
    expect((await engine.listStaleChunks({ sourceId: id })).map(row => row.slug)).toEqual(['current']);
  }
}, 120_000);

test('source stale embedding sends current text, not held history; an owner override repairs before sending', async () => {
  for (const engine of engines) {
    const id = await source(engine);
    await seed(engine, id, 'current');
    await seed(engine, id, 'old', { legacy: true, queued: true });
    await engine.setConfig('embed.current_projections_only', 'true');
    const before = await chunkState(engine, id, 'old');
    const sent: string[] = [];
    const embedFn = async (texts: string[]) => { sent.push(...texts); return texts.map(() => vector); };
    const held = await embedStaleForSource(engine, id, { embedFn });
    expect(held.embedded).toBe(1);
    expect(held.held?.chunks).toBeGreaterThan(0);
    expect(sent).toContain('Synthetic text for current.');
    expect(sent).not.toContain('Synthetic text for old.');
    expect(await chunkState(engine, id, 'old')).toEqual(before);
    const authorized = await embedStaleForSource(engine, id, { currentProjectionsOnly: false, embedFn });
    expect(authorized.embedded).toBe(1);
    expect(sent).toContain('Synthetic text for old.');
    expect((await engine.readPageSnapshot('old', { sourceId: id }))!.page.text_projection_revision).toBe((await engine.readPageSnapshot('old', { sourceId: id }))!.revision);
  }
}, 120_000);

test('an unbuildable historical page is never sent to the provider by the override', async () => {
  for (const engine of engines) {
    const id = await source(engine);
    await engine.putPage('broken', { type: 'code', page_kind: 'code', title: 'broken', compiled_truth: 'synthetic private code text' }, { sourceId: id });
    await installFixtureChunks(engine, 'broken', [{ chunk_index: 0, chunk_text: 'synthetic private code text', chunk_source: 'compiled_truth' }], { sourceId: id });
    await engine.executeRaw('UPDATE pages SET chunker_version=3,text_projection_revision=NULL WHERE source_id=$1 AND slug=$2', [id, 'broken']);
    await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id=$1 AND p.slug=$2
      ON CONFLICT(source_incarnation,slug) DO UPDATE SET reason=EXCLUDED.reason`, [id, 'broken']);
    await engine.setConfig('embed.current_projections_only', 'true');
    const before = await chunkState(engine, id, 'broken');
    const sent: string[] = [];
    const result = await embedStaleForSource(engine, id, { currentProjectionsOnly: false, embedFn: async texts => { sent.push(...texts); return texts.map(() => vector); } });
    expect(result.blocked).toBe(1);
    expect(result.embedded).toBe(0);
    expect(sent).not.toContain('synthetic private code text');
    expect(await chunkState(engine, id, 'broken')).toEqual(before);
  }
}, 120_000);

test('a failed current job retains its eligibility and retry cooldown', async () => {
  for (const engine of engines) {
    const id = await source(engine);
    await engine.setConfig('embed.current_projections_only', 'true');
    await engine.putPage('broken-new', { type: 'code', page_kind: 'code', title: 'new', compiled_truth: 'export const x=1;' }, { sourceId: id });
    const failures: string[] = [];
    await rebuildPendingPageProjections(engine, 20, { retryCooldown: true, onFailure: failure => failures.push(failure.slug) });
    expect(failures).toContain('broken-new');
    expect(await engine.executeRaw('SELECT reason FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation WHERE s.id=$1 AND j.slug=$2', [id, 'broken-new']))
      .toEqual([{ reason: 'canonical_change_rebuild_failed' }]);
    const count = failures.length;
    await rebuildPendingPageProjections(engine, 20, { retryCooldown: true, onFailure: failure => failures.push(failure.slug) });
    expect(failures).toHaveLength(count);
  }
}, 120_000);

test('image sweep previews held legacy projections without importing them', async () => {
  for (const engine of engines) {
    const id = await source(engine);
    await engine.putPage('picture', { type: 'image', page_kind: 'image', title: 'picture', compiled_truth: 'Synthetic image text.' }, { sourceId: id });
    await engine.executeRaw('UPDATE pages SET chunker_version=3,text_projection_revision=NULL WHERE source_id=$1 AND slug=$2', [id, 'picture']);
    await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id=$1 AND p.slug=$2
      ON CONFLICT(source_incarnation,slug) DO UPDATE SET reason=EXCLUDED.reason`, [id, 'picture']);
    await engine.setConfig('embed.current_projections_only', 'true');
    const preview = await embedStaleImages(engine, { sourceId: id, dryRun: true });
    expect(preview.held).toBe(1);
    expect(preview.candidates).toBe(0);
  }
}, 120_000);

test('owner override is foreground, explicit, and financially bounded', () => {
  expect(() => validateProjectionEmbedArgs(['--stale', '--no-current-projections-only'])).toThrow(/--yes/);
  expect(() => validateProjectionEmbedArgs(['--stale', '--no-current-projections-only', '--yes', '--max-usd', '0'])).toThrow(/finite positive/);
  expect(() => validateProjectionEmbedArgs(['--stale', '--no-current-projections-only', '--yes', '--max-usd', '1', '--background'])).toThrow(/foreground/);
  expect(() => validateProjectionEmbedArgs(['--stale', '--no-current-projections-only', '--dry-run'])).not.toThrow();
  expect(() => validateProjectionEmbedArgs(['--stale', '--no-current-projections-only', '--yes', '--max-usd', '1'])).not.toThrow();
  expect(() => parseRepairArgs(['safe-chunks', '--apply', '--no-current-projections-only'])).toThrow(/--max-usd/);
  expect(parseRepairArgs(['safe-chunks', '--apply', '--no-current-projections-only', '--no-embed']).currentProjectionsOnly).toBe(false);
  expect(parseRepairArgs(['safe-chunks', '--apply', '--no-current-projections-only', '--yes', '--max-usd', '1']).maxUsd).toBe(1);
  expect(() => parseRepairArgs(['timeline', '--no-current-projections-only'])).toThrow(/only to gbrain repair safe-chunks/);
});
