/** Real in-memory SQL engine regression: no service, provider or external database. */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { asOwner } from './helpers/owner-tier.ts';

let engine: PGLiteEngine;
const opts: DispatchOpts = { remote: true, transport: 'http', sourceId: 'default', config: { engine: 'pglite' },
  auth: { token: 'synthetic-token', clientId: 'synthetic-client', principal: { kind: 'oauth_client', id: 'synthetic-client' },
    member: null, scopes: ['read'], sourceId: 'alpha', allowedSources: ['alpha', 'beta'] }, metaHook: getBrainHotMemoryMeta };
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  for (const source of ['alpha', 'beta', 'foreign']) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [source]);
    await asOwner(engine, tx => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source)
      VALUES ($1, 'synthetic/entity', $2, 'fact', 'world', 'test')`, [source, `Synthetic ${source} hot memory`]));
  }
  await asOwner(engine, tx => tx.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
    VALUES ('beta', 'synthetic/page', 'note', 'Synthetic page', 'Synthetic beta body', '', '{}')`));
});
afterAll(async () => { await engine?.disconnect(); });
beforeEach(__resetHotMemoryCacheForTests);

for (const extra of [{}, { source_id: 'beta' }]) {
  test(`real get_page lookup and hot memory agree on beta (${extra.source_id ?? 'federated'})`, async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'synthetic/page', ...extra }, opts);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ source_id: 'beta', compiled_truth: 'Synthetic beta body' });
    expect(result._meta?.brain_hot_memory).toMatchObject({ source_id: 'beta', facts: [{ fact: 'Synthetic beta hot memory' }] });
    expect(JSON.stringify(result._meta)).not.toContain('Synthetic alpha hot memory');
    expect(JSON.stringify(result._meta)).not.toContain('Synthetic foreign hot memory');
  });
}

test('real multi-source listing remains metadata-suppressed', async () => {
  const result = await dispatchToolCall(engine, 'list_pages', { source_ids: ['alpha', 'beta'] }, opts);
  expect(result.isError).not.toBe(true);
  expect(result._meta?.brain_hot_memory).toBeUndefined();
});

test('a real trust-floor refusal never invokes the page metadata hook', async () => {
  let hooks = 0;
  await engine.executeRaw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE source_id = 'beta' AND slug = 'synthetic/page'");
  try {
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'synthetic/page' }, { ...opts,
      auth: { ...opts.auth!, minTrust: 'operator_curated' }, metaHook: async (...args) => { hooks++; return getBrainHotMemoryMeta(...args); } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe('page_not_found');
    expect(hooks).toBe(0);
    expect(result._meta?.brain_hot_memory).toBeUndefined();
  } finally { await asOwner(engine, tx => tx.executeRaw("UPDATE pages SET trust_tier = 'operator_curated' WHERE source_id = 'beta' AND slug = 'synthetic/page'")); }
});
