/**
 * HydraDB as storage and search backend (src/core/hydradb*.ts,
 * search/hydra-primary.ts, commands/cloud.ts) against an in-process fake of
 * api.hydradb.com: the mirror sends the embedding projection (no private pages,
 * private fact rows or secrets), resumes from its cursor, removes soft-deleted
 * pages, keeps the cursor on failure, and a committed write is pushed; search
 * is byte-identical and makes no request when off, primary is off, or HydraDB
 * fails, and otherwise follows HydraDB's order as local page rows under the
 * caller's read policy (unheld pages as cloud rows, deleted and private ones
 * dropped, unsupported filters searched locally); `gbrain cloud` refuses
 * without consent and connect/status/primary/disconnect round-trip. Serial:
 * replaces global fetch and process env. PGLite, keyword-only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { unpackToolResult } from '../src/core/mcp-client.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { HYDRADB_API_KEY_ENV, HYDRADB_CONFIG, hydraDocId, resolveHydraConnection, saveHydraApiKey } from '../src/core/hydradb.ts';
import { hydraPrimarySearch } from '../src/core/search/hydra-primary.ts';
import { mirrorBrain, scheduleCloudPush } from '../src/core/hydradb-mirror.ts';
import { uploadBenchmarkCorpus } from '../evals/cloud-memory/ingest.ts';
import { runCloud } from '../src/commands/cloud.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { drainAllBackgroundWorkForCliExit } from '../src/core/background-work.ts';
import type { SearchResult } from '../src/core/types.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

interface CloudDoc { id: string; title: string; markdown: string; meta: { gbrain_source: string; gbrain_slug: string; gbrain_type?: string; gbrain_revision?: string } }
const cloud = {
  database: null as string | null,
  docs: new Map<string, CloudDoc>(),
  calls: [] as string[],
  queries: [] as Array<Record<string, unknown>>,
  uploads: [] as string[],
  fail: false,
  responseExtras: {} as Record<string, unknown>,
};
const realFetch = globalThis.fetch;
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 300, data }), { status, headers: { 'content-type': 'application/json' } });

async function fakeHydra(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  cloud.calls.push(`${method} ${url.pathname}`);
  if (cloud.fail) return reply(null, 503);
  const json = () => JSON.parse(String(init!.body));
  switch (`${method} ${url.pathname}`) {
    case 'POST /databases':
      if (cloud.database) return reply(null, 409);
      cloud.database = json().database;
      return reply({});
    case 'GET /databases/status':
      return reply({ infra: { ready_for_ingestion: true } });
    case 'DELETE /databases':
      cloud.database = null;
      cloud.docs.clear();
      return reply({});
    case 'POST /context/ingest': {
      const form = init!.body as FormData;
      const files = form.getAll('documents') as File[];
      const items = JSON.parse(String(form.get('document_metadata')));
      if (files.length !== items.length) return reply(null, 400);
      for (const [i, item] of items.entries()) {
        const markdown = await files[i]!.text(); cloud.uploads.push(markdown);
        cloud.docs.set(item.id, { id: item.id, title: files[i]!.name.replace(/\.md$/, ''), markdown, meta: item.additional_metadata });
      }
      return reply({ failed_count: 0, results: items.map((item: { id: string }) => ({ id: item.id, status: 'queued' })) }, 202);
    }
    case 'GET /context/status':
      return reply({ statuses: (url.searchParams.get('ids') ?? '').split(',').map(id => ({ id, indexing_status: 'completed' })) });
    case 'DELETE /context': {
      const ids = json().ids as string[];
      for (const id of ids) cloud.docs.delete(id);
      return reply({ deleted_count: ids.length, results: ids.map(id => ({ id, deleted: true })) });
    }
    case 'POST /context/list':
      return reply({ sources: (json().ids as string[]).flatMap(id => { const d = cloud.docs.get(id); return d ? [{ id, title: d.title, additional_metadata: d.meta }] : []; }) });
    case 'POST /query': {
      const body = json();
      cloud.queries.push(body);
      const allowed: string[] | undefined = body.metadata_filters?.additional_metadata?.gbrain_source;
      const types: string[] | undefined = body.metadata_filters?.additional_metadata?.gbrain_type;
      const chunks = [...cloud.docs.values()].filter(d => (!allowed || allowed.includes(d.meta.gbrain_source)) && (!types || types.includes(d.meta.gbrain_type ?? '')))
        .map(d => ({ id: d.id, chunk_uuid: d.id + '_chunk_0000', source_title: d.title, chunk_content: d.markdown, additional_metadata: d.meta }));
      return reply({ chunks, ...cloud.responseExtras });
    }
    default:
      return reply(null, 404);
  }
}

let engine: PGLiteEngine;
let sourceId: string;
let otherSource: string;
const Q = 'Where is the Forge offsite booked?';
const FENCE = [
  '## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Founded Acme in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |',
  '| 2 | Prefers async over meetings | preference | 0.85 | private | medium | 2026-04-29 |  | 1:1 notes |  |',
  '<!--- gbrain:facts:end -->',
].join('\n');

const query = async (params: Record<string, unknown> = {}) =>
  await handleToolCall(engine, 'query', { query: Q, expand: false, use_cache: false, source_id: sourceId, limit: 8, ...params }) as SearchResult[];
const settle = (slug?: string) => engine.executeRaw(
  `UPDATE pages SET updated_at = now() - interval '1 minute' WHERE source_id = ANY($1::text[])${slug ? ' AND slug = $2' : ''}`,
  slug ? [[sourceId, otherSource], slug] : [[sourceId, otherSource]]);
const disconnectAll = async () => { for (const key of Object.values(HYDRADB_CONFIG)) await engine.unsetConfig(key); };
const connectAll = async () => {
  cloud.database = 'gbrain';
  await engine.setConfig(HYDRADB_CONFIG.database, 'gbrain');
  await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
};
const conn = { database: 'gbrain', apiKey: 'hk_test.secret' };
// Import deliberately discards user-forged gate markers. Model a persisted
// gate-owned marker from an older brain, with its keyword chunks intact.
async function markSkipped(source: string, slug: string) {
  await engine.executeRaw(
    "UPDATE pages SET frontmatter = jsonb_set(frontmatter, '{embed_skip}', $3::text::jsonb), updated_at = now() - interval '1 minute' WHERE source_id = $1 AND slug = $2",
    [source, slug, JSON.stringify({ reason: 'oversized' })]);
  const chunks = await engine.getChunks(slug, { sourceId: source, includeUnsealed: true });
  await installFixtureChunks(engine, slug, chunks.map(c => ({ chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source })), { sourceId: source });
}
const cloudDoc = (source: string, slug: string, markdown: string) =>
  cloud.docs.set(hydraDocId(source, slug), { id: hydraDocId(source, slug), title: slug, markdown, meta: { gbrain_source: source, gbrain_slug: slug } });

beforeAll(async () => {
  globalThis.fetch = fakeHydra as typeof fetch;
  process.env[HYDRADB_API_KEY_ENV] = conn.apiKey;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  otherSource = await newSource(engine);
  await putPage(engine, sourceId, 'notes/forge-offsite', page('note', 'Forge offsite', 'The Forge offsite is booked in Santa Fe.'));
  await putPage(engine, sourceId, 'people/acme-founder', page('person', 'Acme founder', `Builds widgets.\n\n${FENCE}`));
  await putPage(engine, sourceId, 'notes/diary', page('note', 'Diary', 'A private entry about the Forge offsite.', 'visibility: private\n'));
  await putPage(engine, sourceId, 'notes/garden', page('note', 'Garden', 'Tomatoes need water. CI token ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8.'));
  await putPage(engine, otherSource, 'notes/elsewhere', page('note', 'Elsewhere', 'Another source.'));
  await putPage(engine, sourceId, 'notes/retired', page('note', 'Retired', 'An old Forge offsite plan.'));
  await engine.softDeletePage('notes/retired', { sourceId });
  await settle();
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete process.env[HYDRADB_API_KEY_ENV];
  await engine?.disconnect();
}, 60_000);

beforeEach(async () => {
  cloud.database = null;
  cloud.docs.clear();
  cloud.calls = [];
  cloud.queries = [];
  cloud.uploads = [];
  cloud.fail = false; cloud.responseExtras = {};
  await disconnectAll();
  _resetCliExitVerdictForTests();
});

describe('mirror', () => {
  test('embed-skipped keyword pages never reach cloud backfill or benchmark ingestion', async () => {
    const source = await newSource(engine), slug = 'notes/excluded';
    try {
      await putPage(engine, source, slug, page('note', 'Excluded', 'EXCLUDED_CLOUD_CANARY'));
      await markSkipped(source, slug);
      expect((await engine.getPage(slug, { sourceId: source }))!.frontmatter.embed_skip).toBeDefined();
      expect((await engine.getChunks(slug, { sourceId: source })).length).toBeGreaterThan(0);
      await mirrorBrain(engine, conn, { full: true });
      expect(cloud.docs.has(hydraDocId(source, slug))).toBe(false);
      expect(cloud.uploads.join('\n')).not.toContain('EXCLUDED_CLOUD_CANARY');
      const calls = cloud.calls.length;
      await expect(uploadBenchmarkCorpus(engine, conn, [source], 1, () => {})).rejects.toThrow('empty outgoing projection');
      expect(cloud.calls.slice(calls)).toEqual([]);
    } finally {
      await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [source]);
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [source]);
    }
  });

  test('marking a mirrored page embed-skipped deletes its cloud copy without uploading the edit', async () => {
    const source = await newSource(engine), slug = 'notes/newly-excluded';
    try {
      await connectAll();
      await putPage(engine, source, slug, page('note', 'Initially public', 'Public before exclusion.'));
      await drainAllBackgroundWorkForCliExit();
      await mirrorBrain(engine, conn, { full: true });
      expect(cloud.docs.has(hydraDocId(source, slug))).toBe(true);
      await disconnectAll();
      const before = await engine.getPage(slug, { sourceId: source });
      await putPage(engine, source, slug, page('note', 'Now excluded', 'NEWLY_EXCLUDED_CLOUD_CANARY'), before!.knowledge_revision);
      await markSkipped(source, slug);
      await connectAll();
      scheduleCloudPush(engine, { source_id: source, slug });
      await drainAllBackgroundWorkForCliExit();
      await mirrorBrain(engine, conn, { full: true });
      expect(cloud.docs.has(hydraDocId(source, slug))).toBe(false);
      expect(cloud.uploads.join('\n')).not.toContain('NEWLY_EXCLUDED_CLOUD_CANARY');
      expect((await engine.getChunks(slug, { sourceId: source })).length).toBeGreaterThan(0);
    } finally {
      await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [source]);
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [source]);
    }
  });

  test('sends the embedding projection: no private page, no private fact row, no secret', async () => {
    const r = await mirrorBrain(engine, conn);
    expect(r.upserted).toBe(4);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/diary'))).toBe(false);
    const founder = cloud.docs.get(hydraDocId(sourceId, 'people/acme-founder'))!;
    expect(founder.markdown).toContain('Founded Acme in 2017');
    expect(founder.markdown).not.toContain('Prefers async');
    expect(founder.meta).toMatchObject({ gbrain_source: sourceId, gbrain_slug: 'people/acme-founder', gbrain_type: 'person' });
    const garden = cloud.docs.get(hydraDocId(sourceId, 'notes/garden'))!.markdown;
    expect(garden).toContain('Tomatoes need water.');
    expect(garden).not.toContain('ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  });

  test('resumes from the cursor and keeps it when HydraDB fails', async () => {
    await mirrorBrain(engine, conn);
    cloud.calls = [];
    expect((await mirrorBrain(engine, conn)).upserted).toBe(0);
    expect(cloud.calls.filter(c => c === 'POST /context/ingest')).toHaveLength(0);

    await putPage(engine, sourceId, 'notes/new-idea', page('note', 'New idea', 'Ship the cloud arm.'));
    await settle('notes/new-idea');
    const cursor = await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
    cloud.fail = true;
    await expect(mirrorBrain(engine, conn)).rejects.toThrow('HydraDB 503');
    expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).toBe(cursor);
    cloud.fail = false;
    expect((await mirrorBrain(engine, conn)).upserted).toBe(1);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/new-idea'))).toBe(true);
  });

  test('a page soft-deleted since the last run is removed from the cloud', async () => {
    await mirrorBrain(engine, conn);
    await putPage(engine, sourceId, 'notes/doomed', page('note', 'Doomed', 'Delete me.'));
    await settle('notes/doomed');
    await mirrorBrain(engine, conn);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/doomed'))).toBe(true);
    await engine.setConfig(HYDRADB_CONFIG.deletedSince, '2000-01-01T00:00:00.000000Z');
    await engine.softDeletePage('notes/doomed', { sourceId });
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '1 minute' WHERE source_id = $1 AND slug = 'notes/doomed'`, [sourceId]);
    expect((await mirrorBrain(engine, conn)).removed).toBe(1);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/doomed'))).toBe(false);
  });
});

describe('HydraDB as primary search', () => {
  const pages = (rows: SearchResult[]): unknown[] => rows.filter(r => r.result_type !== 'fact').map(r => [r.result_type ?? 'page', r.slug ?? null, r.source_id]);

  test('off, primary off, or HydraDB down: no change from local search', async () => {
    const off = await query();
    expect(cloud.calls).toEqual([]);
    await connectAll();
    cloudDoc(sourceId, 'notes/remote-only', 'The Forge offsite moved to Missoula.');
    await engine.setConfig(HYDRADB_CONFIG.primary, 'false');
    expect(JSON.stringify(await query())).toBe(JSON.stringify(off));
    await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
    cloud.fail = true;
    expect(JSON.stringify(await query())).toBe(JSON.stringify(off));
  });

  test('on: rows follow HydraDB order as local page rows; unheld pages are cloud rows; deleted pages dropped', async () => {
    await connectAll();
    cloudDoc(sourceId, 'notes/garden', 'Tomatoes need water.');
    cloudDoc(sourceId, 'notes/remote-only', 'The Forge offsite moved to Missoula.');
    cloudDoc(sourceId, 'notes/retired', 'An old Forge offsite plan.');
    cloudDoc(sourceId, 'notes/forge-offsite', 'The Forge offsite is booked in Santa Fe.');
    cloudDoc(otherSource, 'notes/elsewhere', 'Another source.');
    const on = await query();
    expect(pages(on)).toEqual([['page', 'notes/garden', sourceId], ['cloud', null, sourceId], ['page', 'notes/forge-offsite', sourceId]]);
    expect(on.find(r => r.slug === 'notes/garden')!.page_id).toBeGreaterThan(0);
    expect(on.find(r => r.result_type === 'cloud')!.chunk_text).toContain('The Forge offsite moved to Missoula.');
    expect(on.find(r => r.result_type === 'cloud')!.chunk_text).toContain('Source:');
    expect(cloud.queries.at(-1)!.metadata_filters).toEqual({ additional_metadata: { gbrain_source: [sourceId] } });
  });

  test('a remote caller gets only its sources and never a private page', async () => {
    await connectAll();
    cloudDoc(sourceId, 'notes/diary', 'A private entry about the Forge offsite.');
    cloudDoc(sourceId, 'notes/remote-only', 'The Forge offsite moved to Missoula.');
    cloudDoc(otherSource, 'notes/elsewhere', 'The Forge offsite budget lives elsewhere.');
    const auth = { token: 't', clientId: 'cloud-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] };
    const r = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 8 },
      { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
    const text = r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('moved to Missoula');
    expect(text).not.toContain('budget lives elsewhere');
    expect(text).not.toContain('private entry');
  });

  test('pagination keeps HydraDB ranking instead of switching to local search', async () => {
    await connectAll();
    cloudDoc(sourceId, 'notes/garden', 'Tomatoes need water.');
    cloudDoc(sourceId, 'notes/forge-offsite', 'The Forge offsite is booked in Santa Fe.');
    expect(pages(await query({ offset: 1 }))).toEqual([['page', 'notes/forge-offsite', sourceId]]);
    expect(cloud.queries).toHaveLength(1);
  });

  test('a committed page write is pushed to HydraDB', async () => {
    await connectAll();
    await putPage(engine, sourceId, 'notes/kiln', page('note', 'Kiln', 'Ship the kiln scheduler.'));
    await drainAllBackgroundWorkForCliExit();
    expect(cloud.docs.get(hydraDocId(sourceId, 'notes/kiln'))?.markdown).toContain('Ship the kiln scheduler.');
  });
});

describe('gbrain cloud', () => {
  const quiet = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_NON_INTERACTIVE: '1' }, fn);

  test('connect without consent writes nothing and calls nothing', async () => {
    await quiet(() => runCloud(engine, ['connect']));
    expect(currentExitCode()).toBe(1);
    expect(await engine.getConfig(HYDRADB_CONFIG.database)).toBeNull();
    expect(cloud.calls).toEqual([]);
  });

  test('connect --yes creates the database, mirrors and makes HydraDB primary; primary off; disconnect --purge-cloud deletes it', async () => {
    await quiet(() => runCloud(engine, ['connect', '--yes']));
    expect(currentExitCode()).toBe(0);
    expect(cloud.database).toBe('gbrain');
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/forge-offsite'))).toBe(true);
    expect(await engine.getConfig(HYDRADB_CONFIG.primary)).toBe('true');
    expect(await engine.getConfig(HYDRADB_CONFIG.mode)).toBe('fast');

    await quiet(() => runCloud(engine, ['primary', 'off']));
    expect(await engine.getConfig(HYDRADB_CONFIG.primary)).toBe('false');

    await quiet(() => runCloud(engine, ['disconnect', '--purge-cloud', '--yes']));
    expect(cloud.calls).toContain('DELETE /databases');
    expect(cloud.database).toBeNull();
    for (const key of Object.values(HYDRADB_CONFIG)) expect(await engine.getConfig(key)).toBeNull();
  });

  test('connect reuses an existing database, so a second device joins it', async () => {
    cloud.database = 'gbrain';
    await quiet(() => runCloud(engine, ['connect', '--yes', '--no-push', '--mode=thinking']));
    expect(currentExitCode()).toBe(0);
    expect(await engine.getConfig(HYDRADB_CONFIG.database)).toBe('gbrain');
    expect(cloud.calls).not.toContain('POST /context/ingest');
    expect(await engine.getConfig(HYDRADB_CONFIG.mode)).toBe('thinking');
  });

  test('a vault key is used when the environment has none', async () => {
    await withEnv({ [HYDRADB_API_KEY_ENV]: undefined }, async () => {
      await engine.setConfig(HYDRADB_CONFIG.database, 'gbrain');
      expect(await resolveHydraConnection(engine)).toBeNull();
      await engine.setConfig(HYDRADB_CONFIG.credentialId, await saveHydraApiKey('hk_vault.secret'));
      expect(await resolveHydraConnection(engine)).toEqual({ database: 'gbrain', apiKey: 'hk_vault.secret' });
    });
  });
});


test('archiving and restoring an already mirrored source reconciles unchanged pages', async () => {
  await mirrorBrain(engine, conn);
  const cursor = await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
  try {
    await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', [sourceId]);
    cloud.fail = true;
    await expect(mirrorBrain(engine, conn)).rejects.toThrow('HydraDB 503');
    cloud.fail = false;
    await mirrorBrain(engine, conn);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/forge-offsite'))).toBe(false);
    expect(cloud.docs.has(hydraDocId(otherSource, 'notes/elsewhere'))).toBe(true);
    expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).toBe(cursor);
    await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [sourceId]);
    await mirrorBrain(engine, conn);
    expect(cloud.docs.get(hydraDocId(sourceId, 'notes/forge-offsite'))?.markdown).toContain('Santa Fe');
  } finally {
    cloud.fail = false;
    await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [sourceId]);
  }
});

test('cloud type aliases admit both held and remote-only initiative pages', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hydra-alias-'));
  const dir = join(home, '.gbrain', 'schema-packs', 'hydra-alias-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ api_version: 'gbrain-schema-pack-v1', name: 'hydra-alias-test',
    version: '1.0.0', extends: 'gbrain-base', page_types: [{ name: 'initiative', primitive: 'entity', aliases: ['company'], path_prefixes: ['initiatives/'] }] }));
  await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
    await engine.setConfig(`schema_pack.source.${sourceId}`, 'hydra-alias-test');
    try {
      await putPage(engine, sourceId, 'initiatives/alias-held', page('initiative', 'Held initiative', 'Forge initiative in Santa Fe.'));
      await connectAll();
      await mirrorBrain(engine, conn, { full: true });
      cloud.docs.set('remote-alias', { id: 'remote-alias', title: 'Remote initiative', markdown: 'Remote Forge initiative.',
        meta: { gbrain_source: sourceId, gbrain_slug: 'initiatives/alias-remote', gbrain_type: 'initiative' } });
      for (const filters of [{ type: 'company' }, { types: ['company'] }]) {
        const rows = 'type' in filters ? (await hydraPrimarySearch(engine, Q, { ...filters, sourceId }, 8))! : await query(filters);
        expect(rows.some(row => row.slug === 'initiatives/alias-held')).toBe(true);
        expect(rows.some(row => row.result_type === 'cloud' && row.chunk_text.includes('Remote Forge'))).toBe(true);
        expect((cloud.queries.at(-1) as any).metadata_filters.additional_metadata.gbrain_type).toEqual(['company', 'initiative']);
      }
      cloud.queries = [];
      expect(await hydraPrimarySearch(engine, Q, { sourceId, type: 'company', types: ['note'] }, 8)).toEqual([]);
      expect(cloud.queries).toHaveLength(0);
    } finally { await engine.unsetConfig(`schema_pack.source.${sourceId}`); }
  });
  rmSync(home, { recursive: true, force: true });
});

test('disconnecting one brain preserves a shared vault key for another brain', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hydra-shared-vault-'));
  const other = new PGLiteEngine();
  await other.connect({}); await other.initSchema();
  try {
    await withEnv({ GBRAIN_HOME: home, [HYDRADB_API_KEY_ENV]: undefined }, async () => {
      const key = 'hk_shared.synthetic';
      const id = await saveHydraApiKey(key);
      expect(await saveHydraApiKey(key)).toBe(id);
      for (const brain of [engine, other]) {
        await brain.setConfig(HYDRADB_CONFIG.database, 'gbrain');
        await brain.setConfig(HYDRADB_CONFIG.credentialId, id);
      }
      await runCloud(engine, ['disconnect']);
      expect(await resolveHydraConnection(engine)).toBeNull();
      expect(await resolveHydraConnection(other)).toEqual({ database: 'gbrain', apiKey: key });
    });
  } finally { await other.disconnect(); rmSync(home, { recursive: true, force: true }); }
}, 120_000);


test('fast-mode Markdown reaches agents, while JSON remains available to thin clients', async () => {
  await connectAll(); await mirrorBrain(engine, conn, { full: true });
  const id = hydraDocId(sourceId, 'notes/forge-offsite');
  const doc = cloud.docs.get(id)!; cloud.docs.clear(); cloud.docs.set(id, doc);
  const markdown = '# HydraDB answer context\n\nThe offsite is in Santa Fe. Its owner is team-example.\n\n## Sources\n\n[1] Forge offsite';
  cloud.responseExtras = { llm_prompt: markdown };
  const options = { remote: true, transport: 'stdio' as const, sourceId,
    auth: { token: 't', clientId: 'markdown-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] },
    config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } };
  const result = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 8 }, options);
  expect(result.isError).not.toBe(true);
  expect(result.content[0]!.text).toBe(markdown);
  expect(unpackToolResult<SearchResult[]>(result)).toHaveLength(1);
  const { captureRetrievalMeta, formatResult } = await import('../src/cli/main.ts');
  captureRetrievalMeta('retrieval', result._meta!.retrieval);
  expect(formatResult('query', unpackToolResult(result))).toBe(markdown + '\n');
  expect(JSON.parse(formatResult('query', unpackToolResult(result), { json: true }))).toHaveLength(1);
  expect(cloud.queries.at(-1)).toMatchObject({ mode: 'fast', query_by: 'hybrid', graph_context: true });
  const http = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 8 }, { ...options, transport: 'http' });
  expect(JSON.parse(http.content[0]!.text)).toHaveLength(1);
  expect(http.content.some(c => c.text === markdown)).toBe(true);
  for (const op of ['search', 'recall']) {
    const delivered = await dispatchToolCall(engine, op, { query: Q, limit: 8 }, options);
    expect(delivered.isError).not.toBe(true);
    expect(delivered.content[0]!.text).toContain(markdown);
    expect(delivered.structuredContent).toBeDefined();
    if (op === 'recall') {
      captureRetrievalMeta('hydradb', delivered._meta!.hydradb);
      expect(formatResult('recall', unpackToolResult(delivered))).toContain(markdown);
    }
  }
});

test('SDK formatting retains authorized graph and temporal context and rejects foreign evidence', async () => {
  await connectAll(); await mirrorBrain(engine, conn, { full: true });
  const id = hydraDocId(sourceId, 'notes/forge-offsite'), chunk = id + '_chunk_0000';
  const doc = cloud.docs.get(id)!; cloud.docs.clear(); cloud.docs.set(id, doc);
  const triplet = { source: { name: 'Offsite' }, relation: { canonical_predicate: 'owned_by', temporal_details: '2026-01-01', context: 'Verified owner.' }, target: { name: 'team-example' } };
  cloud.responseExtras = { llm_prompt: 'FOREIGN_CANONICAL_MUST_NOT_LEAK', graph_context: {
    query_paths: [{ source_chunk_ids: [chunk], triplets: [triplet], combined_context: 'Authorized graph synthesis.' },
      { source_chunk_ids: [chunk, 'foreign-chunk'], triplets: [], combined_context: 'FOREIGN_GRAPH_MUST_NOT_LEAK' }],
    chunk_relations: [], chunk_id_to_group_ids: {} }, temporal_filter: { applied: true },
    temporal_facts: [{ chunk_id: chunk, source_id: id, subject: 'Offsite', relation: 'scheduled_for', object: 'Thursday', event_start: 1767225600 },
      { chunk_id: 'foreign-chunk', subject: 'FOREIGN_TEMPORAL_MUST_NOT_LEAK' }] };
  const rows = await query();
  const text = JSON.stringify(rows);
  expect(text).toContain('Authorized graph synthesis.');
  expect(text).toContain('team-example');
  expect(text).toContain('Dated Facts');
  expect(text).toContain('2026-01-01');
  expect(text).not.toContain('FOREIGN_');
  const oldRevision = doc.meta.gbrain_revision;
  await putPage(engine, sourceId, 'notes/forge-offsite', page('note', 'Forge offsite', 'Updated public offsite plan.'), (await engine.getPage('notes/forge-offsite', { sourceId }))!.knowledge_revision);
  expect((await engine.getPage('notes/forge-offsite', { sourceId }))!.knowledge_revision).not.toBe(oldRevision);
  const stale = JSON.stringify(await query());
  expect(stale).toContain('Updated public offsite plan.');
  expect(stale).not.toContain('Authorized graph synthesis.');
  expect(stale).not.toContain('team-example');
});


test('users can configure thinking and switch back to the default fast mode', async () => {
  await connectAll(); cloudDoc(sourceId, 'notes/mode-probe', 'A mode selection probe.');
  await runCloud(engine, ['mode', 'thinking']);
  expect(currentExitCode()).toBe(0);
  expect(await engine.getConfig(HYDRADB_CONFIG.mode)).toBe('thinking');
  await query(); expect(cloud.queries.at(-1)!.mode).toBe('thinking');
  await runCloud(engine, ['mode', 'fast']);
  await query(); expect(cloud.queries.at(-1)!.mode).toBe('fast');
  const count = cloud.queries.length;
  await runCloud(engine, ['mode', 'turbo']);
  expect(currentExitCode()).toBe(1);
  expect(await engine.getConfig(HYDRADB_CONFIG.mode)).toBe('fast');
  expect(cloud.queries).toHaveLength(count);
});

test('invalid setup mode fails before connecting or sending memory', async () => {
  await runCloud(engine, ['connect', '--yes', '--mode', 'turbo']);
  expect(currentExitCode()).toBe(1);
  expect(cloud.calls).toEqual([]);
  expect(await engine.getConfig(HYDRADB_CONFIG.database)).toBeNull();
});

test('unified graph supporting contexts resolve source metadata before admission', async () => {
  await connectAll(); await mirrorBrain(engine, conn, { full: true });
  const id = hydraDocId(sourceId, 'notes/forge-offsite');
  const doc = cloud.docs.get(id)!; cloud.docs.clear(); cloud.docs.set(id, doc);
  cloudDoc(sourceId, 'notes/support', 'The owner is team-example.');
  const supportId = hydraDocId(sourceId, 'notes/support');
  cloud.responseExtras = { chunks: [{ context_id: id, chunk_id: 'primary-chunk', content: doc.markdown }],
    forceful_relations: [{ chunk: { context_id: supportId, chunk_id: 'support-chunk', content: 'The owner is team-example.' } }],
    graph: [{ path_summary: 'Unified authorized synthesis.', triplets: [
      { source: { name: 'Offsite' }, target: { name: 'Thursday' }, relation: { chunk_id: 'primary-chunk', predicate: 'scheduled_for' } },
      { source: { name: 'Offsite' }, target: { name: 'team-example' }, relation: { chunk_id: 'support-chunk', predicate: 'owned_by' } }] }] };
  const rows = await query();
  expect(cloud.calls).toContain('POST /context/list');
  expect(JSON.stringify(rows)).toContain('Unified authorized synthesis.');
  expect(JSON.stringify(rows)).toContain('The owner is team-example.');
});

test('benchmark uploads use the same page projection and metadata as production mirroring', async () => {
  const source = await newSource(engine);
  await putPage(engine, source, 'notes/public-session', page('note', 'Public session', 'The sample appointment starts Thursday.\n\n```text\nRepeated implementation text.\n```'));
  await connectAll(); await mirrorBrain(engine, conn, { full: true });
  const id = hydraDocId(source, 'notes/public-session');
  const expected = structuredClone(cloud.docs.get(id));
  expect(expected).toBeDefined();
  cloud.docs.delete(id);
  const receipt = await uploadBenchmarkCorpus(engine, conn, [source], 1, () => {});
  expect(receipt.upserted).toBe(1);
  expect(cloud.docs.get(id)).toEqual(expected);
});

test('cloud query, search and recall honor page, section and window delivery with readable graph context', async () => {
  const slug = 'notes/expanded-offsite';
  const pieces = ['WINDOW_EARLIER: travel is by train.', 'The Forge offsite is booked in Santa Fe.',
    'SECTION_DETAIL: the check-in desk opens at noon.', 'LATER_DETAIL: transport leaves at five.', 'PAGE_ONLY_DETAIL: refunds close next month.'];
  const body = '## Earlier\n' + pieces[0] + '\n\n## Plan\n' + pieces[1] + '\n\n' + pieces[2] + '\n\n## Later\n' + pieces[3] + '\n\n## Appendix\n' + pieces[4];
  await putPage(engine, sourceId, slug, page('note', 'Expanded offsite', body));
  await installFixtureChunks(engine, slug, pieces.map((chunk_text, chunk_index) => ({ chunk_text, chunk_index, chunk_source: 'compiled_truth' })), { sourceId });
  await connectAll(); await mirrorBrain(engine, conn, { full: true });
  const id = hydraDocId(sourceId, slug), doc = cloud.docs.get(id)!;
  cloud.docs.clear(); cloud.docs.set(id, doc);
  cloud.responseExtras = { llm_prompt: 'MATCH_ONLY_PROMPT', chunks: [{ id, chunk_uuid: 'expanded-chunk', source_title: doc.title,
    chunk_content: pieces[1], additional_metadata: doc.meta }], graph_context: { query_paths: [{ source_chunk_ids: ['expanded-chunk'],
    combined_context: 'AUTHORIZED_EXPANDED_GRAPH', triplets: [] }], chunk_relations: [], chunk_id_to_group_ids: {} } };
  for (const remote of [false, true]) for (const op of ['query', 'search', 'recall']) {
    for (const unit of ['page', 'section', 'window']) {
      const result = await dispatchToolCall(engine, op, { query: Q, source_id: sourceId, limit: 1, expand: false,
        return_unit: unit, return_window: 1, ...(remote ? {} : { fields: 'full' }), snippet_chars: 0 },
        { transport: 'stdio', remote, sourceId, ...(remote ? { auth: { token: 't', clientId: 'lean-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] } } : {}), config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
      expect(result.isError).not.toBe(true);
      const structured = unpackToolResult<any>(result);
      const rows = op === 'recall' ? structured.results : structured;
      expect(rows).toHaveLength(1);
      const delivered = rows[0], text = delivered.chunk_text ?? delivered.chunk;
      if (!remote || op === 'recall') expect(delivered.delivered?.unit).toBe(unit);
      else expect(delivered.delivered).toBeUndefined();
      expect(text).toContain('SECTION_DETAIL');
      expect(result.content[0]!.text).toContain('SECTION_DETAIL');
      expect(result.content[0]!.text).toContain('AUTHORIZED_EXPANDED_GRAPH');
      expect(result.content[0]!.text).not.toContain('MATCH_ONLY_PROMPT');
      if (unit === 'page') expect(text).toContain('PAGE_ONLY_DETAIL');
      else expect(text).not.toContain('PAGE_ONLY_DETAIL');
      if (unit === 'window') expect(text).toContain('WINDOW_EARLIER');
      if (unit === 'section') expect(text).not.toContain('WINDOW_EARLIER');
      for (const span of delivered.delivered?.match_spans ?? []) expect(text.slice(span.start, span.end)).toBe(pieces[1]);
    }
  }
});
