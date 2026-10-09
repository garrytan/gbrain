/**
 * #5988 read-time hold signals. A page whose newer file sync holds keeps its
 * last good revision and a held new file has no page, so reads say so:
 * get_page carries `file_held` (the path for trusted local callers only),
 * search hits for such a page carry `stale`, and the retrieval meta carries
 * `held_files` per source plus a `held_files` degraded notice. Remote callers
 * get codes, counts and flags, never paths, with a fix addressed to the brain
 * host operator. Each read costs one indexed hold lookup and one summary read.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import { PER_CALL_NOTICE_CODES } from '../src/core/notice-ledger.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { readHeldCoverage, readHeldPages } from '../src/core/persistence/held-reads.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let engine: BrainEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-held-reads-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const getPage = operations.find(op => op.name === 'get_page')!;
const search = operations.find(op => op.name === 'search')!;
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic note about the quarterly widget roadmap and ${title}.\n`;
const BROKEN = '---\ntitle: alice-example first line\nalice-example second line\n---\nA synthetic note about the quarterly widget roadmap.\n';

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const each of engines) {
    await each.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await each.setConfig('search.mcp_keyword_only', 'true');
  }
}, 120_000);

afterAll(async () => {
  for (const each of engines) if (each.kind === 'pglite') await each.disconnect();
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const eachEngine = (fn: () => Promise<void>) => withEnv(env, async () => {
  for (const each of engines) { engine = each; await fn(); }
});

async function source(files: Record<string, string>): Promise<{ id: string; root: string }> {
  const id = `hr-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true }); await makeGitFixture(root);
  commit(root, files);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  return { id, root };
}

function commit(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture content');
}

const sync = (id: string, root: string) => performSync(engine, { repoPath: root, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });

/** A held source: notes/a.md imported then broken (stale), notes/new.md broken from the start (missing), notes/ok.md clean. */
async function heldSource() {
  const s = await source({ 'notes/a.md': note('Alpha'), 'notes/ok.md': note('Okay') });
  await sync(s.id, s.root);
  commit(s.root, { 'notes/a.md': BROKEN, 'notes/new.md': BROKEN });
  await sync(s.id, s.root);
  expect((await readGitSourceHolds(engine, { sourceIds: [s.id] }))[0]?.holds.map(hold => hold.path).sort()).toEqual(['notes/a.md', 'notes/new.md']);
  return s;
}

interface Call { ctx: OperationContext; notices: Notice[]; meta: Record<string, unknown> }
function call(sourceId: string, remote: boolean): Call {
  const notices: Notice[] = [], meta: Record<string, unknown> = {};
  const ctx = {
    engine, config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId,
    emitNotice: (notice: Notice) => { notices.push(notice); },
    emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
  } as unknown as OperationContext;
  return { ctx, notices, meta };
}

/** Counts the hold-store reads a call makes (an own-property shadow, so transaction handles keep their connection). */
async function countHoldReads<T>(run: () => Promise<T>): Promise<{ value: T; reads: number }> {
  const target = engine as unknown as { executeRaw: (this: unknown, sql: string, params?: unknown[]) => Promise<unknown> };
  const inherited = Object.getPrototypeOf(engine).executeRaw as typeof target.executeRaw;
  let reads = 0;
  target.executeRaw = function (sql, params) {
    if (Array.isArray(params) && (params[0] === 'sync-hold' || params[0] === 'sync-hold-summary')) reads++;
    return inherited.call(this, sql, params);
  };
  try { return { value: await run(), reads }; }
  finally { delete (target as Partial<typeof target>).executeRaw; }
}

test('the held-page read joins each hold to its page by key, not by a text cast of every page id', () => eachEngine(async () => {
  const s = await heldSource();
  const [page] = await engine.executeRaw<{ id: number; revision: string }>(`SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug='notes/a'`, [s.id]);
  const target = engine as unknown as { executeRaw: (this: unknown, sql: string, params?: unknown[]) => Promise<unknown> };
  const inherited = Object.getPrototypeOf(engine).executeRaw as typeof target.executeRaw;
  let read: { sql: string; params: unknown[] } | undefined;
  target.executeRaw = function (sql, params) {
    if (Array.isArray(params) && params[0] === 'sync-hold' && sql.includes('LEFT JOIN pages p')) read = { sql, params };
    return inherited.call(this, sql, params);
  };
  let held: Awaited<ReturnType<typeof readHeldPages>>;
  try { held = await readHeldPages(engine, [page.id, page.id + 100_000]); }
  finally { delete (target as Partial<typeof target>).executeRaw; }
  expect([...held.keys()]).toEqual([page.id]);
  expect(held.get(page.id)).toMatchObject({ revision: page.revision, record: { path: 'notes/a.md', page_id: page.id } });
  const plan = await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL enable_seqscan = off');
    return tx.executeRaw<Record<string, string>>(`EXPLAIN ${read!.sql}`, read!.params);
  });
  const text = plan.map(row => Object.values(row)[0]).join('\n');
  expect(text).toContain('pages_pkey');
  expect(text).not.toMatch(/Seq Scan on pages/);
}), 120_000);

test('get_page carries file_held with the path for local callers and without it for remote ones; it clears once the file imports', () => eachEngine(async () => {
  const s = await heldSource();
  const local = await getPage.handler(call(s.id, false).ctx, { slug: 'notes/a' }) as Record<string, any>;
  expect(local.title).toBe('Alpha');
  expect(local.file_held).toMatchObject({ code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 2, path: 'notes/a.md',
    docs: 'docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation',
    fix: { actor: 'agent', argv: ['gbrain', 'repair', 'frontmatter', '--source', s.id, '--include-ambiguous'] } });
  expect(Date.parse(local.file_held.since)).not.toBeNaN();

  const remote = await getPage.handler(call(s.id, true).ctx, { slug: 'notes/a' }) as Record<string, any>;
  expect(remote.file_held).toMatchObject({ code: 'invalid_frontmatter', reason: 'needs_interpretation', since: local.file_held.since,
    fix: { actor: 'host_admin', argv: ['gbrain', 'repair', 'frontmatter', '--source', s.id] } });
  expect(remote.file_held.path).toBeUndefined();
  expect(remote.file_held.fix.user_message).toContain(`'gbrain repair frontmatter --source ${s.id}' on the brain host`);
  expect(JSON.stringify(remote.file_held)).not.toContain('notes/a.md');
  expect(JSON.stringify(remote.file_held)).not.toContain('alice-example');

  expect((await getPage.handler(call(s.id, false).ctx, { slug: 'notes/ok' }) as Record<string, unknown>).file_held).toBeUndefined();

  commit(s.root, { 'notes/a.md': note('Alpha fixed') });
  await sync(s.id, s.root);
  const fixed = await getPage.handler(call(s.id, false).ctx, { slug: 'notes/a' }) as Record<string, unknown>;
  expect(fixed.title).toBe('Alpha fixed');
  expect(fixed.file_held).toBeUndefined();
  expect(await readHeldCoverage(engine, { sourceId: s.id })).toEqual([{ source_id: s.id, missing: 1, stale: 0 }]);
}), 120_000);

test('search marks hits of held pages stale, reports held_files per source and emits the held_files notice', () => eachEngine(async () => {
  const s = await heldSource();
  const revision = (await engine.readPageSnapshot('notes/a', { sourceId: s.id }))!.revision;
  const c = call(s.id, false);
  const results = await search.handler(c.ctx, { query: 'quarterly widget roadmap' }) as Array<Record<string, any>>;
  const bySlug = Object.fromEntries(results.map(row => [row.slug, row]));
  expect(bySlug['notes/a']?.stale).toMatchObject({ last_indexed_revision: revision });
  expect(Date.parse(bySlug['notes/a']!.stale.held_since)).not.toBeNaN();
  expect(bySlug['notes/ok']?.stale).toBe(false);
  expect((c.meta.retrieval as Record<string, unknown>).held_files).toEqual([{ source_id: s.id, missing: 1, stale: 1 }]);
  const notice = c.notices.find(n => n.code === 'held_files')!;
  expect(notice).toMatchObject({ kind: 'degraded', fix: { actor: 'agent', argv: ['gbrain', 'repair', 'frontmatter', '--source', s.id],
    verify: { argv: ['gbrain', 'sources', 'status', s.id, '--json'] } } });
  expect(notice.why).toContain('1 held new file(s) have no page');
  expect(notice.why).toContain('1 page(s) whose newer file is held');
  expect(NOTICE_CODES.held_files.kind).toBe('degraded');
  expect(PER_CALL_NOTICE_CODES.has('held_files')).toBe(true);
}), 120_000);

test('a remote search payload carries counts and flags, never paths, and names the host operator command', () => eachEngine(async () => {
  const s = await heldSource();
  const c = call(s.id, true);
  const results = await search.handler(c.ctx, { query: 'quarterly widget roadmap' }) as Array<Record<string, any>>;
  expect(results.find(row => row.slug === 'notes/a')?.stale).toMatchObject({ held_since: expect.any(String) });
  const notice = c.notices.find(n => n.code === 'held_files')!;
  expect(notice.fix).toMatchObject({ actor: 'host_admin', argv: ['gbrain', 'repair', 'frontmatter', '--source', s.id] });
  expect(notice.fix!.user_message).toContain(`'gbrain repair frontmatter --source ${s.id}' on the brain host`);
  expect(notice.why).toContain('Only the brain host operator can inspect and repair held files.');
  const payload = JSON.stringify({ results, meta: c.meta, notices: c.notices });
  for (const path of ['notes/a.md', 'notes/new.md', 'notes/ok.md']) expect(payload).not.toContain(path);
  expect(payload).not.toContain(home);
  expect(payload).not.toContain('alice-example');
  expect((c.meta.retrieval as Record<string, unknown>).held_files).toEqual([{ source_id: s.id, missing: 1, stale: 1 }]);
}), 120_000);

test('a clean source adds no held_files, no notice and no stale hit, with one summary read', () => eachEngine(async () => {
  const s = await source({ 'notes/a.md': note('Alpha'), 'notes/ok.md': note('Okay') });
  await sync(s.id, s.root);
  const c = call(s.id, false);
  const { value: results, reads } = await countHoldReads(() => search.handler(c.ctx, { query: 'quarterly widget roadmap' }) as Promise<Array<Record<string, unknown>>>);
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(row => row.stale === false)).toBe(true);
  expect((c.meta.retrieval as Record<string, unknown>).held_files).toBeUndefined();
  expect(c.notices.find(n => n.code === 'held_files')).toBeUndefined();
  expect(reads).toBe(1);
}), 120_000);

test('reads cost one indexed hold lookup and one summary read per request, never one per hit', () => eachEngine(async () => {
  const s = await heldSource();
  commit(s.root, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`notes/extra-${i}.md`, note(`Extra ${i}`)])));
  await sync(s.id, s.root);
  const c = call(s.id, false);
  const { value: results, reads } = await countHoldReads(() => search.handler(c.ctx, { query: 'quarterly widget roadmap' }) as Promise<Array<Record<string, unknown>>>);
  expect(results.length).toBeGreaterThan(5);
  expect(reads).toBe(2);
  expect((await countHoldReads(() => getPage.handler(call(s.id, false).ctx, { slug: 'notes/a' }))).reads).toBe(1);

  const request = {};
  const twice = await countHoldReads(async () => [await readHeldCoverage(engine, { sourceId: s.id }, request), await readHeldCoverage(engine, { sourceId: s.id }, request)]);
  expect(twice.reads).toBe(1);
  expect(twice.value[0]).toEqual(twice.value[1]);
  const plan = await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL enable_seqscan = off');
    return tx.executeRaw<Record<string, string>>(`EXPLAIN SELECT 1 FROM op_checkpoints h WHERE h.op='sync-hold' AND (h.completed_keys->0->>'page_id')=ANY($1::text[])`, [['1']]);
  });
  expect(plan.map(row => Object.values(row)[0]).join('\n')).toContain('op_checkpoints_sync_hold_page_idx');
}), 120_000);
