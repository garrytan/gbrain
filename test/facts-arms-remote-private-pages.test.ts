/**
 * The query op's two fact reads (the facts arm, search/facts-arm.ts
 * collectFactCandidates, and the saved-fact match beside the blocks,
 * ops/search.ts matchingSavedFacts) hide a world fact whose provenance page
 * is private from a remote caller, under the same operator override as every
 * other fact read (resolveExcludePrivatePages: `search.remote_private_pages`).
 * By default the fact is hidden; with the override set to `visible` it comes
 * back; a `visibility: private` fact stays hidden either way, and a local
 * caller always sees it. PGLite, keyword-only, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { QUERY_FACTS_ARM_KEY, matchQueryFacts } from '../src/core/search/facts-arm.ts';
import { REMOTE_PRIVATE_PAGES_KEY, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'Where is the Forge offsite booked?';
const facts = async (remote: boolean) => (await matchQueryFacts(engine, Q, { sourceIds: [sourceId], remote })).map(f => f.fact);
const remoteQuery = async () => {
  const auth = { token: 't', clientId: 'facts-privacy', scopes: ['read'], sourceId, allowedSources: [sourceId] };
  const r = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 6 },
    { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
  return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
};
const override = async (value: string | null) => {
  if (value === null) await engine.executeRaw('DELETE FROM config WHERE key = $1', [REMOTE_PRIVATE_PAGES_KEY]);
  else await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, value);
  __resetPrivateVisibilityCacheForTests();
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, 'notes/forge-plan', page('note', 'Forge plan', 'Planning notes for the Forge offsite.', 'visibility: private\n'));
  await putPage(engine, sourceId, 'notes/forge-public', page('note', 'Forge public', 'Public notes on the Forge offsite.'));
  const add = (fact: string, visibility: 'world' | 'private', day: string) =>
    engine.insertFact({ fact, kind: 'fact', entity_slug: 'forge', source: 'notes', visibility, valid_from: new Date(`2025-07-${day}T00:00:00Z`) }, { source_id: sourceId });
  await add('The Forge offsite is booked in Missoula.', 'world', '12');
  await add('The Forge offsite is booked in Taos.', 'world', '13');
  await add('The Forge offsite is booked in Boise.', 'private', '14');
  await engine.executeRaw(`UPDATE facts SET source_markdown_slug = CASE WHEN fact LIKE '%Taos%' THEN 'notes/forge-plan' ELSE 'notes/forge-public' END WHERE source_id = $1`, [sourceId]);
}, 120_000);
afterEach(async () => { await override(null); });
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('facts arm (collectFactCandidates)', () => {
  test('remote, default: the private-sourced world fact is hidden; local sees it', async () => {
    expect(await facts(true)).toEqual(['The Forge offsite is booked in Missoula.']);
    expect((await facts(false)).sort()).toEqual(['The Forge offsite is booked in Boise.', 'The Forge offsite is booked in Missoula.', 'The Forge offsite is booked in Taos.']);
  });

  test('remote, remote_private_pages=visible: the private-sourced world fact comes back; a private fact stays hidden', async () => {
    await override('visible');
    expect((await facts(true)).sort()).toEqual(['The Forge offsite is booked in Missoula.', 'The Forge offsite is booked in Taos.']);
  });
});

describe('saved-fact match (matchingSavedFacts)', () => {
  test('remote, default: the private-sourced world fact is hidden', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    try {
      const text = await remoteQuery();
      expect(text).toContain('Missoula');
      expect(text).not.toContain('Taos');
      expect(text).not.toContain('Boise');
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true'); }
  });

  test('remote, remote_private_pages=visible: the private-sourced world fact comes back; a private fact stays hidden', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    await override('visible');
    try {
      const text = await remoteQuery();
      expect(text).toContain('Missoula');
      expect(text).toContain('Taos');
      expect(text).not.toContain('Boise');
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true'); }
  });
});
