/**
 * #5216: adding `pages.knowledge_revision` NOT NULL with a volatile default
 * rewrote the whole pages table during schema replay / migration 150, reading
 * every TOAST value (a torn one blocked the upgrade). The column is now added
 * nullable with a separate default, existing rows are backfilled in committed
 * batches that resume after an interruption, a row still awaiting its revision
 * is never reported as revision "null", and the final constraints equal a
 * fresh install.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {BrainEngine} from '../src/core/engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_STATE_SCHEMA_STATEMENTS } from '../src/core/page-state/schema.ts';
import { REVISION_BACKFILL_STATE_KEY, resumePageRevisionBackfill } from '../src/core/page-state/revision-backfill-schema.ts';
import {assertRelationRevision as assertPageRevision,readRelationSnapshot} from '../src/core/pmbrain-adapters/relation-writer.ts';
const REVISION_BACKFILL_PENDING='backfill_pending';

let engine: BrainEngine;
let freshFlags: Array<{ notnull: boolean; hasdef: boolean; def: string | null }>;
const SLUGS = ['notes/rev-a', 'notes/rev-b', 'notes/rev-c'];
const quiet = { log: () => {} };
function injected(engine:BrainEngine,check:(sql:string,params?:unknown[])=>void):BrainEngine{
  return new Proxy(engine,{get(target,prop){
    if(prop==='executeRaw')return (sql:string,params?:unknown[])=>{check(sql,params);return target.executeRaw(sql,params);};
    if(prop==='transaction')return (fn:(tx:BrainEngine)=>Promise<unknown>)=>target.transaction(tx=>fn(injected(tx as BrainEngine,check)));
    const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
  }});
}

const columnFlags = (e: BrainEngine) => e.executeRaw<{ notnull: boolean; hasdef: boolean; def: string | null }>(
  `SELECT a.attnotnull AS notnull, a.atthasdef AS hasdef, pg_get_expr(d.adbin, d.adrelid) AS def
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'pages'::regclass AND a.attname = 'knowledge_revision'`);
const revisions = async () => Object.fromEntries((await engine.executeRaw<{ slug: string; r: string | null }>(
  'SELECT slug, knowledge_revision::text AS r FROM pages ORDER BY id')).map(row => [row.slug, row.r]));

/** Recreate the pre-v150 shape: populated pages without the revision column, then replay the page-state schema. */
async function preV150ThenReplay(): Promise<{ rewritten: boolean }> {
  await engine.executeRaw('ALTER TABLE pages DROP COLUMN IF EXISTS knowledge_revision CASCADE');
  const [before] = await engine.executeRaw<{ f: number }>("SELECT relfilenode AS f FROM pg_class WHERE relname = 'pages'");
  for (const statement of PAGE_STATE_SCHEMA_STATEMENTS) await engine.executeRaw(statement);
  const [after] = await engine.executeRaw<{ f: number }>("SELECT relfilenode AS f FROM pg_class WHERE relname = 'pages'");
  return { rewritten: before!.f !== after!.f };
}

beforeAll(async () => {
  const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new PGLiteEngine();
  if(url)await (engine as PostgresEngine).connect({database_url:url,poolSize:2});
  else await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('DELETE FROM pages');
  freshFlags = await columnFlags(engine);
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.unsetConfig(REVISION_BACKFILL_STATE_KEY);
  for (const slug of SLUGS) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${'body '.repeat(2000)}${slug}` }, { sourceId: 'default' });
});

describe('page revision rollout (#5216)', () => {
  test('replaying the page-state schema on a populated pre-v150 table adds the column without a table rewrite', async () => {
    const { rewritten } = await preV150ThenReplay();
    expect(rewritten).toBe(false);
    const [flags] = await columnFlags(engine);
    expect(flags).toMatchObject({ notnull: false, hasdef: true, def: 'gen_random_uuid()' });
    expect(Object.values(await revisions())).toEqual([null, null, null]);
  });

  test('a row awaiting its revision never reports "null"; revision-bound writes get revision_backfill_pending', async () => {
    await preV150ThenReplay();
    const snapshot = await readRelationSnapshot(engine,'notes/rev-a','default');
    expect(snapshot!.revision).toBe(REVISION_BACKFILL_PENDING);
    expect(snapshot!.revision).not.toBe('null');
    expect((await engine.executeRaw<{pending:boolean}>("SELECT knowledge_revision IS NULL AS pending FROM pages WHERE slug='notes/rev-a'"))[0].pending).toBe(true);
    let code: string | undefined;
    try { assertPageRevision(snapshot, { expectedRevision: '00000000-0000-4000-8000-000000000000' }); } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe('revision_backfill_pending');
  });

  test('an interrupted backfill resumes without reassigning revisions, keeps a concurrent write, and ends with fresh-install constraints', async () => {
    await preV150ThenReplay();
    const controller=new AbortController();
    let interrupted:unknown;
    try{await resumePageRevisionBackfill(engine,{batchSize:1,...quiet,signal:controller.signal,onProgress:()=>controller.abort(new Error('process killed'))});}catch(error){interrupted=error;}
    expect(String(interrupted)).toContain('process killed');
    const partial = await revisions();
    expect(partial['notes/rev-a']).toMatch(/^[0-9a-f-]{36}$/);
    expect(partial['notes/rev-b']).toBeNull();

    await engine.executeRaw("UPDATE pages SET title = 'edited during the pause' WHERE slug = 'notes/rev-c'");
    const written = (await revisions())['notes/rev-c'];
    expect(written).toMatch(/^[0-9a-f-]{36}$/);

    const result = await resumePageRevisionBackfill(engine, { batchSize: 1, ...quiet });
    expect(result.status).toBe('complete');
    const final = await revisions();
    expect(final['notes/rev-a']).toBe(partial['notes/rev-a']!);
    expect(final['notes/rev-c']).toBe(written!);
    expect(final['notes/rev-b']).toMatch(/^[0-9a-f-]{36}$/);

    expect(await columnFlags(engine)).toEqual(freshFlags);
    expect(freshFlags[0]!.notnull).toBe(true);
    expect(await engine.executeRaw("SELECT conname FROM pg_constraint WHERE conname = 'pages_knowledge_revision_backfilled'")).toEqual([]);
    expect(await engine.getConfig(REVISION_BACKFILL_STATE_KEY)).toBeNull();
    expect((await resumePageRevisionBackfill(engine, quiet)).status).toBe('not_needed');
  });

  test('a row that keeps failing is isolated and reported, retried a bounded number of times, and the rest completes later', async () => {
    await preV150ThenReplay();
    const [{ id: badId }] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'notes/rev-b'");
    let failing = true;
    const torn=injected(engine,(sql,params)=>{if(failing&&/^UPDATE pages SET knowledge_revision/.test(sql)&&JSON.stringify(params).includes(String(badId)))throw new Error('unexpected chunk number 21 (expected 1) for toast value 141869');});
    const logs: string[] = [];
    const first = await resumePageRevisionBackfill(torn, { batchSize: 10, log: line => logs.push(line) });
    expect(first.status).toBe('pending');
    expect(first.failed.map(f => f.id)).toEqual([Number(badId)]);
    expect(logs.join('\n')).toContain('gbrain repair orphan-children');
    const after = await revisions();
    expect(after['notes/rev-a']).toMatch(/^[0-9a-f-]{36}$/);
    expect(after['notes/rev-b']).toBeNull();
    for (let i = 0; i < 4; i++) await resumePageRevisionBackfill(torn, quiet);
    const capped = await resumePageRevisionBackfill(torn, quiet);
    expect(capped.failed[0]!.attempts).toBe(3);
    expect((await columnFlags(engine))[0]!.notnull).toBe(false);

    failing = false;
    await engine.executeRaw('DELETE FROM pages WHERE id = $1', [badId]);
    expect((await resumePageRevisionBackfill(engine, quiet)).status).toBe('complete');
    expect((await columnFlags(engine))[0]!.notnull).toBe(true);
  });
});
