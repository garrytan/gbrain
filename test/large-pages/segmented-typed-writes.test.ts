/**
 * The streamed import, the segmented re-chunk and the segmented projector write through typed engine members, not raw SQL.
 *
 * 1. Protects: a streamed re-import that drops a frontmatter tag prunes it through `pruneFrontmatterTags`, the
 *    re-chunk stamps the page's chunker version through `setChunkerVersion`, and the projector's queue route claims,
 *    renews, releases, deletes and fails its job through `claimSegmentedProjection`, `renewSegmentedProjectionClaim`,
 *    `releaseSegmentedProjectionClaim`, `deleteProjectionJob` and `markProjectionRebuildFailed`. Every member has parity
 *    cases on all three arms (test/engine-parity/import-writes.test.ts, persistence.test.ts), so these callers now run on
 *    any engine that serves them.
 * 2. Fails when: a caller sends its statement through `executeRaw` again (the Rust engine refuses raw SQL).
 * PGLite only: a transaction engine inherits the instance's spies (`Object.create`); the members' own arms are the parity cases.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../../src/core/page-body/streamed-import.ts';
import { runSegmentedRechunk } from '../../src/core/page-body/rechunk.ts';
import { rebuildPendingSegmentedProjections } from '../../src/core/page-body/projection.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';
import { conversationBody } from '../helpers/conversation-page.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
  dir = mkdtempSync(join(tmpdir(), 'gbrain-segmented-typed-writes-'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

/** Records every raw statement and every call of each member while `run` runs, on the engine and its transaction engines. */
async function spiedAll<T>(members: readonly string[], run: () => Promise<T>) {
  const raw: string[] = [];
  const calls: Array<[string, unknown[]]> = [];
  const target = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
  const executeRaw = target.executeRaw!;
  target.executeRaw = function (this: unknown, ...args: unknown[]) { raw.push(String(args[0])); return executeRaw.apply(this, args); };
  for (const member of members) {
    const typed = target[member]!;
    target[member] = function (this: unknown, ...args: unknown[]) { calls.push([member, args]); return typed.apply(this, args); };
  }
  try { return { result: await run(), raw, calls }; }
  finally { delete target.executeRaw; for (const member of members) delete target[member]; }
}

async function spied<T>(member: 'pruneFrontmatterTags' | 'setChunkerVersion', run: () => Promise<T>) {
  const { result, raw, calls } = await spiedAll([member], run);
  return { result, raw, calls: calls.map(([, args]) => args) };
}

async function streamed(slug: string, tags: string[], body: string) {
  const file = join(dir, `${slug.replace('/', '-')}.md`);
  writeFileSync(file, `---\ntype: note\ntitle: ${slug}\ntags: [${tags.join(', ')}]\n---\n\n${body}\n`);
  const stat = statSync(file);
  return importStreamedMarkdownFile(engine, file, `${slug}.md`, { noEmbed: true }, stat, await readPageBodyPolicy(engine));
}

test('a streamed re-import prunes the frontmatter tag it dropped through pruneFrontmatterTags', async () => {
  const body = conversationBody(64 * 1024, { seed: 5 });
  expect((await streamed('notes/tagged', ['alpha', 'beta'], body)).status).toBe('imported');
  expect((await engine.getTags('notes/tagged')).sort()).toEqual(['alpha', 'beta']);
  const { result, raw, calls } = await spied('pruneFrontmatterTags', () => streamed('notes/tagged', ['alpha'], body));
  expect(result.status).toBe('imported');
  expect(await engine.getTags('notes/tagged')).toEqual(['alpha']);
  expect(calls).toEqual([['notes/tagged', ['alpha'], { sourceId: 'default' }]]);
  expect(raw.filter(sql => sql.includes('DELETE FROM tags'))).toEqual([]);
}, 120_000);

test('the segmented re-chunk stamps the chunker version through setChunkerVersion', async () => {
  expect((await streamed('notes/rechunk', [], conversationBody(64 * 1024, { seed: 9 }))).status).toBe('imported');
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug='notes/rechunk'");
  await engine.executeRaw('UPDATE pages SET chunker_version=4 WHERE id=$1', [page!.id]);
  const { result, raw, calls } = await spied('setChunkerVersion', () => runSegmentedRechunk(engine, { apply: true, slug: 'notes/rechunk' }));
  expect(result.pages.map(p => [p.slug, p.state])).toEqual([['notes/rechunk', expect.stringMatching(/^(rechunked|stamped)$/)]]);
  expect(calls).toEqual([['notes/rechunk', SEGMENTED_CHUNKER_VERSION, { sourceId: 'default' }]]);
  expect(raw.filter(sql => /SET chunker_version/.test(sql))).toEqual([]);
  const [after] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE id=$1', [page!.id]);
  expect(after!.chunker_version).toBe(SEGMENTED_CHUNKER_VERSION);
}, 120_000);

const QUEUE_MEMBERS = ['claimSegmentedProjection', 'renewSegmentedProjectionClaim', 'releaseSegmentedProjectionClaim', 'deleteProjectionJob',
  'markProjectionRebuildFailed'] as const;
const RAW_QUEUE_WRITE = /(UPDATE|DELETE FROM) page_projection_jobs/;

/** A sealed segmented page made unsealed with its job queued at its revision, as an interrupted projection leaves it. */
async function queuedPage(slug: string, seed: number) {
  expect((await streamed(slug, [], conversationBody(64 * 1024, { seed }))).status).toBe('imported');
  const [page] = await engine.executeRaw<{ id: number; revision: string; incarnation: string }>(`SELECT p.id, p.knowledge_revision::text AS revision,
    s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='default' AND p.slug=$1`, [slug]);
  await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [page!.id]);
  await engine.executeRaw(`INSERT INTO page_projection_jobs (source_incarnation, slug, revision, reason) VALUES ($1::uuid, $2, $3::uuid, 'canonical_change')
    ON CONFLICT (source_incarnation, slug) DO UPDATE SET revision=EXCLUDED.revision, reason=EXCLUDED.reason`, [page!.incarnation, slug, page!.revision]);
  return { sourceIncarnation: page!.incarnation, slug, revision: page!.revision };
}

const jobOf = async (slug: string) =>
  (await engine.executeRaw<{ reason: string }>('SELECT reason FROM page_projection_jobs WHERE slug=$1', [slug]))[0]?.reason ?? null;

test('the queue route claims, renews and deletes its job through the typed queue members', async () => {
  const job = await queuedPage('notes/queued', 11);
  const { result, raw, calls } = await spiedAll(QUEUE_MEMBERS, () => rebuildPendingSegmentedProjections(engine, 10));
  expect(result).toMatchObject({ rebuilt: 1, failed: 0 });
  const ref = { sourceId: 'default', slug: 'notes/queued' };
  const claims = calls.filter(([m]) => m === 'claimSegmentedProjection');
  expect(claims).toEqual([['claimSegmentedProjection', [ref, expect.stringMatching(/^segmented_projecting:[0-9a-f-]{36}$/)]]]);
  const claim = claims[0]![1][1];
  const renews = calls.filter(([m]) => m === 'renewSegmentedProjectionClaim');
  expect(renews.length).toBeGreaterThan(0);
  expect(renews.every(([, args]) => JSON.stringify(args) === JSON.stringify([ref, claim]))).toBe(true);
  expect(calls.filter(([m]) => m === 'deleteProjectionJob')).toEqual([['deleteProjectionJob', [job]]]);
  expect(calls.filter(([m]) => m === 'releaseSegmentedProjectionClaim' || m === 'markProjectionRebuildFailed')).toEqual([]);
  expect(raw.filter(sql => RAW_QUEUE_WRITE.test(sql))).toEqual([]);
  expect(await jobOf('notes/queued')).toBeNull();
}, 120_000);

test('a failed build releases its claim and marks the job failed through the typed queue members', async () => {
  const job = await queuedPage('notes/failing', 13);
  installFaultHook(async (at) => { if (at === 'segmented:projection_staged') throw new Error('injected build failure'); });
  try {
    const { result, raw, calls } = await spiedAll(QUEUE_MEMBERS, () => rebuildPendingSegmentedProjections(engine, 10));
    expect(result).toMatchObject({ rebuilt: 0, failed: 1 });
    const ref = { sourceId: 'default', slug: 'notes/failing' };
    const claim = calls.find(([m]) => m === 'claimSegmentedProjection')![1][1];
    expect(calls.filter(([m]) => m === 'releaseSegmentedProjectionClaim')).toEqual([['releaseSegmentedProjectionClaim', [ref, claim]]]);
    expect(calls.filter(([m]) => m === 'markProjectionRebuildFailed')).toEqual([['markProjectionRebuildFailed', [job]]]);
    expect(calls.filter(([m]) => m === 'deleteProjectionJob')).toEqual([]);
    expect(raw.filter(sql => RAW_QUEUE_WRITE.test(sql))).toEqual([]);
    expect(await jobOf('notes/failing')).toBe('rebuild_failed');
  } finally { installFaultHook(undefined); }
}, 120_000);
