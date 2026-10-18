/**
 * MinionQueue.prune archives completed synthesis jobs into
 * dream_synthesis_completions, then deletes them. Before this fix the archive
 * kept only (source_id, idempotency_key, completed_at): the job id, its
 * submission time and the source row it was submitted under were lost, so a
 * managed run could no longer prove a pruned classic completion belonged to
 * the current source incarnation and synthesized the transcript again.
 *
 * Prune now forwards the job id, submission time and the source's
 * created_at/incarnation at prune time. Rows archived before the migration
 * stay NULL (unknown) and still do not count; nothing is backfilled.
 */

import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const { MinionQueue } = await import('../src/core/minions/queue.ts');
const { partitionCompletedSynthesis } = await import('../src/core/cycle/synthesize-completion.ts');

let db: PGlite;
const engine = { executeRaw: async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows };
const current = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const sourceTime = '2026-01-01T00:00:00.000Z';
const submitted = '2026-02-01T00:00:00.000Z';
const jobId = 11;
const hash = 'a'.repeat(64);
const transcript = { filePath: '/synthetic/talk.md', contentHash: hash };
const key = `dream:synth-v2:demo:filename:talk.md:${hash.slice(0, 16)}`;
const legacyKey = `dream:synth:/synthetic/talk.md:${hash.slice(0,16)}`;
const cutoff = { olderThan: new Date('2027-01-01T00:00:00Z') };
const queue = () => new MinionQueue(engine as never);
const completed = async () => (await partitionCompletedSynthesis(engine as never, [transcript] as never, 'demo', { writer: { sourceIncarnation: current } } as never, false)).completed.size;
const insertJob = async (k = key, created = submitted, status = 'completed', source = 'demo') => {
  await db.query(`INSERT INTO minion_jobs(id,name,status,data,idempotency_key,created_at,updated_at,finished_at)
    VALUES ($1,'subagent',$2,$3,$4,$5,'2026-03-01',NULL)`, [jobId,status,JSON.stringify({ source_id: source }),k,created]);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE sources(id text PRIMARY KEY, created_at timestamptz NOT NULL, incarnation uuid NOT NULL);
    CREATE TABLE minion_jobs(id integer PRIMARY KEY, name text, status text, data jsonb, idempotency_key text,
      created_at timestamptz, updated_at timestamptz, finished_at timestamptz);
    CREATE TABLE dream_synthesis_completions(source_id text, idempotency_key text, completed_at timestamptz DEFAULT now(),
      job_id integer, submitted_at timestamptz, source_created_at timestamptz, source_incarnation uuid,
      PRIMARY KEY(source_id,idempotency_key));`);
}, 60000);
beforeEach(async () => {
  await db.exec('TRUNCATE minion_jobs, dream_synthesis_completions, sources');
  await db.query('INSERT INTO sources VALUES ($1,$2,$3)', ['demo',sourceTime,current]);
});
afterAll(async () => { await db.close(); });

test('current completion survives prune with exact original submission and source identity; retry is empty', async () => {
  await insertJob(); expect(await completed()).toBe(1);
  expect(await queue().prune(cutoff)).toBe(1);
  const [row] = await engine.executeRaw('SELECT * FROM dream_synthesis_completions');
  expect(row.job_id).toBe(jobId); expect(new Date(row.submitted_at as string).toISOString()).toBe(submitted);
  expect(new Date(row.source_created_at as string).toISOString()).toBe(sourceTime); expect(row.source_incarnation).toBe(current);
  expect(await completed()).toBe(1);
  expect(await queue().prune(cutoff)).toBe(0); expect(await completed()).toBe(1);
});
test('legacy current completion also survives prune', async () => {
  await insertJob(legacyKey); expect(await queue().prune(cutoff)).toBe(1); expect(await completed()).toBe(1);
});
test('old submission finishing late never gains current provenance', async () => {
  await insertJob(key,'2025-01-01');
  await db.exec("UPDATE minion_jobs SET finished_at='2026-12-01'");
  expect(await completed()).toBe(0); await queue().prune(cutoff); expect(await completed()).toBe(0);
  const [r] = await engine.executeRaw('SELECT * FROM dream_synthesis_completions');
  expect(r.source_incarnation).toBeNull(); expect(r.source_created_at).toBeNull();
});
test('archived source incarnation or row creation mismatch is excluded', async () => {
  await insertJob(); await queue().prune(cutoff);
  await db.query('UPDATE sources SET incarnation=$1',[other]); expect(await completed()).toBe(0);
  await db.query("UPDATE sources SET incarnation=$1,created_at='2026-01-02'",[current]); expect(await completed()).toBe(0);
});
test('historical NULL provenance and partial provenance never count', async () => {
  await db.query('INSERT INTO dream_synthesis_completions(source_id,idempotency_key) VALUES ($1,$2)',['demo',key]);
  expect(await completed()).toBe(0);
  await db.query('UPDATE dream_synthesis_completions SET submitted_at=$1,source_created_at=$2,source_incarnation=$3',[submitted,sourceTime,current]);
  expect(await completed()).toBe(0); // missing original job ID
});
test('new proven job may replace an unknown same-key archive, never by backfilling history', async () => {
  await db.query('INSERT INTO dream_synthesis_completions(source_id,idempotency_key) VALUES ($1,$2)',['demo',key]);
  await insertJob(); await queue().prune(cutoff); expect(await completed()).toBe(1);
  const [r] = await engine.executeRaw('SELECT * FROM dream_synthesis_completions'); expect(r.job_id).toBe(jobId);
});
test('old late-finishing same-key job cannot clobber current proven archive', async () => {
  await insertJob(); await queue().prune(cutoff);
  await insertJob(key,'2026-01-15'); await queue().prune(cutoff); expect(await completed()).toBe(1);
  const [r] = await engine.executeRaw('SELECT * FROM dream_synthesis_completions');
  expect(new Date(r.submitted_at as string).toISOString()).toBe(submitted);
});
test('archive failure rolls back deletion; retry preserves completion', async () => {
  await insertJob(); await db.exec("ALTER TABLE dream_synthesis_completions ADD CONSTRAINT reject_fixture CHECK (source_id <> 'demo')");
  try { await expect(queue().prune(cutoff)).rejects.toThrow();
    expect((await engine.executeRaw('SELECT count(*)::int AS n FROM minion_jobs'))[0].n).toBe(1);
  } finally { await db.exec('ALTER TABLE dream_synthesis_completions DROP CONSTRAINT reject_fixture'); }
  expect(await queue().prune(cutoff)).toBe(1); expect(await completed()).toBe(1);
});
test('dry run, noncompleted jobs, and another source do not create a completion', async () => {
  await insertJob(); expect(await queue().prune({...cutoff,dryRun:true})).toBe(1);
  expect((await engine.executeRaw('SELECT count(*)::int AS n FROM dream_synthesis_completions'))[0].n).toBe(0);
  await db.exec("UPDATE minion_jobs SET status='dead'"); await queue().prune(cutoff); expect(await completed()).toBe(0);
  await insertJob(key,submitted,'completed','elsewhere'); await queue().prune(cutoff); expect(await completed()).toBe(0);
});
test('partial chunks and old managed-incarnation keys remain excluded', async () => {
  await insertJob(key+':c0of2'); await queue().prune(cutoff); expect(await completed()).toBe(0);
  await insertJob(`dream:synth-v2:${encodeURIComponent('demo/'+other)}:filename:talk.md:${hash.slice(0,16)}`);
  await queue().prune(cutoff); expect(await completed()).toBe(0);
});
test('complete chunk set survives pruning without weakening partial-set guard', async () => {
  await insertJob(key+':c0of2'); await queue().prune(cutoff); expect(await completed()).toBe(0);
  await insertJob(key+':c1of2'); await queue().prune(cutoff); expect(await completed()).toBe(1);
});
test('current managed keys and classic unknown-archive behavior remain unchanged', async () => {
  const managedKey=`dream:synth-v2:${encodeURIComponent('demo/'+current)}:filename:talk.md:${hash.slice(0,16)}`;
  await insertJob(managedKey); expect(await completed()).toBe(1); await queue().prune(cutoff); expect(await completed()).toBe(1);
  await db.exec('TRUNCATE dream_synthesis_completions');
  await db.query('INSERT INTO dream_synthesis_completions(source_id,idempotency_key) VALUES ($1,$2)',['demo',legacyKey]);
  const result=await partitionCompletedSynthesis(engine as never,[transcript] as never,'demo',null,false);
  expect(result.completed.size).toBe(1); expect(await completed()).toBe(0);
});
test('native forward migration is idempotent and preserves unknown history as NULL', async () => {
  const { v257 }=await import('../src/core/schema-migrations/v257-dream-synthesis-archive-provenance.ts');
  await db.exec('DROP TABLE dream_synthesis_completions');
  const { v168 }=await import('../src/core/schema-migrations/v168-dream-synthesis-completions.ts');
  await db.exec(v168.sql);
  await db.query('INSERT INTO dream_synthesis_completions(source_id,idempotency_key) VALUES ($1,$2)',['demo',key]);
  expect(await v257.verify!(engine as never)).toBe(false);
  await db.exec(v257.sql); await db.exec(v257.sql);
  expect(await v257.verify!(engine as never)).toBe(true);
  const [r]=await engine.executeRaw('SELECT * FROM dream_synthesis_completions');
  for (const field of ['job_id','submitted_at','source_created_at','source_incarnation']) expect(r[field]).toBeNull();
  expect(await completed()).toBe(0);
});
test('canonical schema and both embedded bootstrap table definitions match migrated columns', async () => {
  const table=/CREATE TABLE IF NOT EXISTS dream_synthesis_completions \([\s\S]+?\n\);/;
  for (const file of ['src/schema.sql','src/core/schema-embedded.generated.ts','src/core/pglite-schema.generated.ts']) {
    const ddl=table.exec(readFileSync(resolve(import.meta.dir,'..',file),'utf8'))![0];
    await db.exec('DROP TABLE dream_synthesis_completions'); await db.exec(ddl);
    const rows=await engine.executeRaw("SELECT column_name FROM information_schema.columns WHERE table_name='dream_synthesis_completions'");
    expect(rows.map(r=>r.column_name).sort()).toEqual(['source_id','idempotency_key','completed_at','job_id','submitted_at','source_created_at','source_incarnation'].sort());
  }
});
