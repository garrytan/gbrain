/**
 * #6761: doctor facts_extraction_health reports its 24 h `facts:absorb`
 * incident count as history (a rolling window, with the time it ages out)
 * apart from current state: the facts-absorb jobs still dead, each with the
 * `gbrain jobs retry <id>` fix. Status thresholds are unchanged.
 *
 * 1. Protects: ten incidents with no dead job say there is nothing to retry and
 *    when the count ages out, without "tune the gate" advice; a dead job is
 *    named with its retry fix (asks first: it is a paid re-extraction) on the
 *    CLI and over MCP, and the verify clears once it is retried; a dead job a
 *    later completed job for the same page superseded is not counted.
 * 2. Fails if the message goes back to the bare count with threshold tuning,
 *    if dead jobs are not read, or if a superseded job is still reported.
 * 3. test/doctor-facts-absorb-contention-6778.test.ts covers the non-failure
 *    reasons; nothing read minion_jobs for this check before.
 * 4. No production seam: rows are seeded in ingest_log and minion_jobs, and the
 *    journey runs the real CLI against an on-disk PGLite brain (no worker runs,
 *    so the retried job makes no model call).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { factsExtractionEntry } from '../src/commands/doctor/checks/knowledge-health.ts';
import { finalizeCheckFixes } from '../src/commands/doctor/check-fix.ts';
import { cliRenderContext } from '../src/core/agent-output.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { gb, oneDocument } from './helpers/agent-journey.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', String(LATEST_VERSION)); });

const REFUSED = 'write_refused: revision_conflict (OperationError): The source page changed before fact extraction.';

async function incidents(db: BrainEngine, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.logIngest({ source_id: 'default', source_type: 'facts:absorb', source_ref: `notes/page-${i}`, pages_updated: [], summary: REFUSED });
  }
}

async function factsJob(db: BrainEngine, status: 'dead' | 'completed', pageId: number, hoursAgo = 0, withPageId = true): Promise<number> {
  const job = await new MinionQueue(db).add('facts-absorb', { slug: `notes/page-${pageId}`, sourceId: 'default', ...(withPageId ? { page_id: pageId } : {}) }, { queue: 'default' });
  await db.executeRaw(`UPDATE minion_jobs SET status=$2, finished_at=now() - ($3::double precision * interval '1 hour'),
    updated_at=now() - ($3::double precision * interval '1 hour'), error_text=CASE WHEN $2='dead' THEN 'revision_conflict' END WHERE id=$1`,
  [job.id, status, hoursAgo]);
  return job.id;
}

async function check(): Promise<Check> {
  const checks = await factsExtractionEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe('facts_extraction_health separates history from jobs still dead (#6761)', () => {
  test('ten incidents and no dead job: a historical warning that names no retry and says when it ages out', async () => {
    await incidents(engine, 10);
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('10 incidents in 24 h (rolling, ages out at ');
    expect(result.message).toContain('0 jobs still dead');
    expect(result.message).toContain('No facts-absorb job is unresolved');
    expect(result.message).not.toContain('tune the gate');
    expect(result.message).not.toContain('gbrain jobs retry');
    expect(result.fix).toBeUndefined();
    const facts = (result.details as Record<string, any>).facts_absorb;
    expect(facts).toMatchObject({ incidents_24h: 10, jobs_still_dead: 0, dead_jobs: [] });
    const agesOut = new Date(facts.ages_out_at).getTime();
    expect(Math.abs(agesOut - (Date.now() + 24 * 3600_000))).toBeLessThan(5 * 60_000);
  });

  test('one dead job: says so, names its retry, and the retry fix asks first on the CLI and over MCP', async () => {
    await incidents(engine, 10);
    const id = await factsJob(engine, 'dead', 7);
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('10 incidents in 24 h (rolling, ages out at ');
    expect(result.message).toContain('1 job still dead');
    expect(result.message).toContain(`gbrain jobs retry ${id}`);
    expect((result.details as Record<string, any>).facts_absorb).toMatchObject({ jobs_still_dead: 1,
      dead_jobs: [{ id, slug: 'notes/page-7', source_id: 'default', status: 'dead' }] });
    expect(result.fix).toMatchObject({ argv: ['gbrain', 'jobs', 'retry', String(id)], consent: ['paid'], actor: 'agent',
      mcp: { tool: 'retry_job', arguments: { id } }, verify: { argv: ['gbrain', 'doctor', '--only', 'facts_extraction_health', '--json'] } });
    expect(finalizeCheckFixes([result], cliRenderContext())[0].fix).toMatchObject({ next: 'ask_user', command: `gbrain jobs retry ${id}` });
    const callable = finalizeCheckFixes([result], { transport: 'stdio', isCallable: op => op === 'retry_job', preapproved: () => false })[0];
    expect(callable.fix).toMatchObject({ next: 'ask_user', mcp: { tool: 'retry_job', arguments: { id } } });
    const notCallable = finalizeCheckFixes([result], { transport: 'stdio', isCallable: () => false, preapproved: () => false })[0];
    expect(notCallable.fix).toMatchObject({ next: 'tell_user_to_run', actor: 'user' });
  });

  test('a dead job a later completed job for the same page superseded, or one that died over 24 h ago, is not still dead', async () => {
    await incidents(engine, 10);
    await factsJob(engine, 'dead', 3);
    await factsJob(engine, 'completed', 3);
    await factsJob(engine, 'dead', 4, 30);
    const result = await check();
    expect(result.message).toContain('0 jobs still dead');
    expect(result.fix).toBeUndefined();
  });

  test('a backstop-queued job (slug and source, no page_id) is superseded by a later completed job for the same page', async () => {
    await incidents(engine, 10);
    await factsJob(engine, 'dead', 6, 0, false);
    await factsJob(engine, 'completed', 6, 0, false);
    const result = await check();
    expect(result.message).toContain('0 jobs still dead');
    expect(result.fix).toBeUndefined();
  });

  test('thresholds are unchanged: one incident and one dead job stay ok and still name the job', async () => {
    await incidents(engine, 1);
    const id = await factsJob(engine, 'dead', 9);
    const result = await check();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('1 job still dead');
    expect(result.fix).toMatchObject({ argv: ['gbrain', 'jobs', 'retry', String(id)] });
  });
});

describe('fix envelope: a dead job to a verified clear through the real CLI', () => {
  let home: string;
  let jobId: number;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-6761-journey-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    await withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const db = new PGLiteEngine();
      await db.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
      try { await incidents(db, 1); jobId = await factsJob(db, 'dead', 5); } finally { await db.disconnect(); }
    });
  }, 180_000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test('render the envelope, run its argv once the user agrees, run its verify', async () => {
    const doc = oneDocument(await gb(home, ['doctor', '--only', 'facts_extraction_health', '--json']), 'doctor');
    const found = (doc.checks as Array<Record<string, any>>).find(c => c.name === 'facts_extraction_health')!;
    expect(found.message).toContain('1 job still dead');
    expect(found.fix.next).toBe('ask_user');
    expect(found.fix.user_message).toContain(`job ${jobId}`);
    expect(found.fix.argv.slice(0, 4)).toEqual(['gbrain', 'jobs', 'retry', String(jobId)]);
    const retried = await gb(home, found.fix.argv.slice(1));
    expect(retried.exitCode).toBe(0);
    expect(found.fix.verify.argv.slice(0, 5)).toEqual(['gbrain', 'doctor', '--only', 'facts_extraction_health', '--json']);
    const verified = oneDocument(await gb(home, found.fix.verify.argv.slice(1)), 'doctor verify');
    const cleared = (verified.checks as Array<Record<string, any>>).find(c => c.name === 'facts_extraction_health')!;
    expect(cleared.fix).toBeUndefined();
    expect(cleared.details.facts_absorb).toMatchObject({ jobs_still_dead: 0, dead_jobs: [] });
  }, 300_000);
});
