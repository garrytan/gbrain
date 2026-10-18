/**
 * #6778: doctor facts_extraction_health keeps accepted-but-pending facts writes
 * (`write_pending_accepted`) and retries after writer contention before
 * admission (`write_deferred_unadmitted`) out of the failure threshold, and
 * warns when that contention persists: a deferral no facts-absorb job for the
 * same page completed after, older than an hour, or more than 10 of them in 24 h.
 *
 * 1. Protects: deferrals that a completed job followed are information; a
 *    persistent one warns with a read-only `gbrain sources writer status` fix
 *    (`run` on the CLI, relayed to the user over MCP) whose verify clears once
 *    the job completes; accepted rows never warn.
 * 2. Fails if the info reasons count toward the threshold again, or if
 *    persistent contention stays silent or loses its fix.
 * 3. No existing test reads these reasons; test/facts-absorb-publish-wait-6778.test.ts
 *    covers how the rows are written.
 * 4. No production seam: rows are seeded in ingest_log and minion_jobs, and the
 *    journey runs the real CLI against an on-disk PGLite brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { WRITE_DEFERRED_UNADMITTED, WRITE_PENDING_ACCEPTED } from '../src/core/facts/absorb-log.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { factsExtractionEntry } from '../src/commands/doctor/checks/knowledge-health.ts';
import { finalizeCheckFixes } from '../src/commands/doctor/check-fix.ts';
import { cliRenderContext, type RenderContext } from '../src/core/agent-output.ts';
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

const DEFERRED = 'writer_lock_unavailable (OperationError): The canonical fact writer is busy; extraction has not started.';

async function absorbRow(db: BrainEngine, sourceId: string, slug: string, summary: string, hoursAgo = 0): Promise<void> {
  await db.logIngest({ source_id: sourceId, source_type: 'facts:absorb', source_ref: slug, pages_updated: [], summary });
  if (hoursAgo) await db.executeRaw(`UPDATE ingest_log SET created_at = now() - ($1::double precision * interval '1 hour')
    WHERE id = (SELECT max(id) FROM ingest_log)`, [hoursAgo]);
}

async function completedJob(db: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const job = await new MinionQueue(db).add('facts-absorb', { slug, sourceId }, { queue: 'default' });
  await db.executeRaw("UPDATE minion_jobs SET status='completed', finished_at=now() WHERE id=$1", [job.id]);
}

async function check(db: BrainEngine = engine): Promise<Check> {
  const checks = await factsExtractionEntry.run({ engine: db, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

const mcpRender = (transport: 'stdio' | 'http'): RenderContext => ({ transport, isCallable: op => op === 'run_doctor', preapproved: () => false });

describe('facts_extraction_health and writer contention (#6778)', () => {
  test('deferrals a completed job followed are information, not a warning', async () => {
    for (let i = 0; i < 7; i++) {
      await absorbRow(engine, 'default', `notes/page-${i}`, `${WRITE_DEFERRED_UNADMITTED}: ${DEFERRED}`);
      await completedJob(engine, 'default', `notes/page-${i}`);
    }
    const result = await check();
    expect(result.status).toBe('ok');
    expect(result.message).toContain(`default: 7 ${WRITE_DEFERRED_UNADMITTED}`);
    expect(result.message).toContain('busy before anything was admitted');
    expect(result.fix).toBeUndefined();
  });

  test('accepted writes still committing never reach the failure threshold', async () => {
    for (let i = 0; i < 12; i++) await absorbRow(engine, 'default', `notes/page-${i}`, `${WRITE_PENDING_ACCEPTED}: write_pending (OperationError) request_id 00000000-0000-4000-8000-00000000000${i % 10} (queued): The write is accepted and is still pending.`);
    await absorbRow(engine, 'default', 'notes/refused', 'write_refused: permission_denied (OperationError): The grant does not cover this source.');
    const result = await check();
    expect(result.status).toBe('ok');
    expect(result.message).toContain(`default: 12 ${WRITE_PENDING_ACCEPTED}, 1 write_refused`);
    expect(result.message).toContain('they are not failures');
  });

  test('a deferral with no later completed job, over an hour old, warns with the read-only writer status fix', async () => {
    await absorbRow(engine, 'notes-src', 'notes/stuck', `${WRITE_DEFERRED_UNADMITTED}: ${DEFERRED}`, 2);
    await absorbRow(engine, 'notes-src', 'notes/fresh', `${WRITE_DEFERRED_UNADMITTED}: ${DEFERRED}`);
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Writer contention persists (source notes-src: 2 facts write(s) deferred before admission');
    expect(result.details).toMatchObject({ persistent_writer_contention: [{ source_id: 'notes-src', deferred: 2 }] });
    expect(result.fix).toMatchObject({ argv: ['gbrain', 'sources', 'writer', 'status', '--source', 'notes-src', '--json'], consent: [], actor: 'agent',
      verify: { argv: ['gbrain', 'doctor', '--only', 'facts_extraction_health', '--json'] } });
    const [cli] = finalizeCheckFixes([result], cliRenderContext());
    expect(cli.fix).toMatchObject({ next: 'run', actor: 'agent' });
    const [stdio] = finalizeCheckFixes([result], mcpRender('stdio'));
    expect(stdio.fix).toMatchObject({ next: 'tell_user_to_run', actor: 'user' });
    const [http] = finalizeCheckFixes([result], mcpRender('http'));
    expect(http.fix).toMatchObject({ next: 'tell_user_to_run', actor: 'host_admin' });
  });

  test('more than 10 recent deferrals with no later completed job warn; ten do not', async () => {
    for (let i = 0; i < 10; i++) await absorbRow(engine, 'default', `notes/page-${i}`, `${WRITE_DEFERRED_UNADMITTED}: ${DEFERRED}`);
    expect((await check()).status).toBe('ok');
    await absorbRow(engine, 'default', 'notes/page-10', `${WRITE_DEFERRED_UNADMITTED}: ${DEFERRED}`);
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({ persistent_writer_contention: [{ source_id: 'default', deferred: 11 }] });
  });
});

describe('fix envelope: persistent contention to a verified clear through the real CLI', () => {
  let home: string;
  /** Opens the journey brain's on-disk PGLite between CLI runs (never while one runs). */
  let onDisk: (run: (db: PGLiteEngine) => Promise<void>) => Promise<void>;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-6778-journey-'));
    onDisk = run => withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const db = new PGLiteEngine();
      await db.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
      try { await run(db); } finally { await db.disconnect(); }
    });
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    await onDisk(db => absorbRow(db, 'default', 'notes/stuck', `${WRITE_DEFERRED_UNADMITTED}: ${DEFERRED}`, 2));
  }, 180_000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test('render the envelope, run its argv, run its verify once the retried job completed', async () => {
    const doc = oneDocument(await gb(home, ['doctor', '--only', 'facts_extraction_health', '--json']), 'doctor warn');
    const warned = (doc.checks as Array<Record<string, any>>).find(c => c.name === 'facts_extraction_health')!;
    expect(warned.status).toBe('warn');
    expect(warned.fix.next).toBe('run');
    expect(warned.fix.argv.slice(0, 7)).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
    const status = await gb(home, warned.fix.argv.slice(1));
    expect(status.exitCode).toBe(0);
    oneDocument(status, 'writer status');
    // The status read changes nothing; the contention clears when the page's facts-absorb job completes.
    await onDisk(db => completedJob(db, 'default', 'notes/stuck'));
    expect(warned.fix.verify.argv.slice(0, 5)).toEqual(['gbrain', 'doctor', '--only', 'facts_extraction_health', '--json']);
    const verified = oneDocument(await gb(home, warned.fix.verify.argv.slice(1)), 'doctor verify');
    const cleared = (verified.checks as Array<Record<string, any>>).find(c => c.name === 'facts_extraction_health')!;
    expect(cleared.status).toBe('ok');
    expect(cleared.fix).toBeUndefined();
    expect(cleared.details?.persistent_writer_contention).toBeUndefined();
  }, 300_000);
});
