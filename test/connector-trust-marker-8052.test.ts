/**
 * #8052: `gbrain repair provenance --apply` stamps a connector page's stored tier as its `trust_tier` frontmatter
 * marker (`restamp`, #7918), and the next managed connector import re-rendered the page without it, so doctor
 * `provenance_stamp_drift` listed the page again after every import and could never reach zero on a brain with
 * active connector sources.
 *
 * Protects: the managed connector re-render carries a stored `trust_tier` marker forward when it names the tier the
 * connector import itself assigns (`external_untrusted`), so the repaired page stays clear; a stored marker naming
 * any other tier is not carried, so a stored marker can never raise what the import assigns.
 * Seams: none; the real managed Google importer with a fake People API, PGLite always and Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { scanProvenanceDrift } from '../src/core/trust/provenance-drift.ts';
import { repairPageMarker } from '../src/core/trust/page-handlers.ts';
import { contact, createConnectorFixture, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

async function connectorSource(engine: BrainEngine) {
  const f = await source(engine, googleConfig);
  let generation = 0;
  const fetcher = withGoogleAccount(async (url: string) => {
    if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
    if (url.includes('/people/me/connections')) {
      return json({ connections: [{ ...contact('c1', 'Alice Example'), organizations: [{ name: `Acme Example ${generation}` }] }], nextSyncToken: `token-${generation}` });
    }
    throw new Error(`Unexpected Google fixture route: ${url}`);
  }, googleConfig.g_account);
  const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
  const sync = async () => {
    const result = await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(result.failedFiles ?? 0).toBe(0);
    return result;
  };
  await sync();
  const [page] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id]);
  const read = async () => (await engine.executeRaw<{ trust_tier: string; marker: string | null; org: string }>(
    "SELECT trust_tier, frontmatter->>'trust_tier' AS marker, compiled_truth AS org FROM pages WHERE source_id=$1 AND slug=$2", [f.id, page!.slug]))[0]!;
  const resync = async () => { generation++; await sync(); expect((await read()).org).toContain(`Acme Example ${generation}`); };
  return { id: f.id, slug: page!.slug, read, resync };
}

test('a repaired connector page keeps its trust_tier marker across a re-import, and the drift check stays clear', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await connectorSource(engine);
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: null });
    const before = await scanProvenanceDrift(engine, s.id);
    expect(before.marker_missing).toBe(1);

    const item = before.items.find(i => i.slug === s.slug)!;
    expect(item.verdict.class).toBe('restamp');
    await repairPageMarker(engine, { sourceId: s.id, slug: s.slug, expectedRevision: item.revision, confirmation: { via: 'preview_hash' } });
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: 'external_untrusted' });
    expect((await scanProvenanceDrift(engine, s.id)).marker_missing).toBe(0);

    await s.resync();
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: 'external_untrusted' });
    const after = await scanProvenanceDrift(engine, s.id);
    expect(after.marker_missing).toBe(0);
    expect(after.items).toEqual([]);
  }
}), 180_000);

test('a stored marker naming a tier above the connector tier is not carried into the re-render', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await connectorSource(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"trust_tier":"agent_written"}'::jsonb WHERE source_id=$1 AND slug=$2`, [s.id, s.slug]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await s.read()).marker).toBe('agent_written');
    await s.resync();
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: null });
  }
}), 180_000);
