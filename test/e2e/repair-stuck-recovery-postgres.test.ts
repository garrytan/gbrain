/**
 * #6650 §1.10 on real Postgres: a `gbrain repair stuck-recovery` apply SIGKILLed at each of its fault seams (while it
 * holds the native worktree lock) resumes to the same end state, a write abandoned by `--keep disk` keeps its recovery
 * record unchanged for the unchanged resident recovery pass to clear, and an identical apply replays.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { recoverPublication } from '../../src/core/persistence/coordinator.ts';
import type { FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';
import { AFTER, EDITED, PRIOR, stuckRecoveryFixture } from '../helpers/stuck-recovery-fixture.ts';

const url = process.env.DATABASE_URL;
const WORKER = resolve(import.meta.dir, '../fixtures/stuck-recovery-worker.ts');

describe.skipIf(!url)('gbrain repair stuck-recovery on Postgres', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-stuck-recovery-pg-'));
  const roots: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let database: string;
  let databaseUrl: string;
  let engine: PostgresEngine;
  const run = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
  const fixture = () => stuckRecoveryFixture(engine, roots);

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    admin = postgres(url!, { max: 1, prepare: false, onnotice() {} });
    database = `gbrain_test_stuck_recovery_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`; databaseUrl = target.toString();
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl, poolSize: 4 });
    await engine.initSchema();
    await run(() => registerLocalWriter(engine, 'cli'));
  }, 180_000);

  afterAll(async () => {
    await engine?.disconnect();
    if (database) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Runs the apply in a child that blocks at `point`, waits for it to get there, then SIGKILLs it. */
  async function killAt(sourceId: string, hash: string, keep: 'prior' | 'disk', point: FaultPoint): Promise<void> {
    const configPath = join(home, `worker-${randomUUID()}.json`);
    writeFileSync(configPath, JSON.stringify({ databaseUrl, sourceId, hash, keep, point }), { mode: 0o600 });
    const env = { ...process.env, GBRAIN_HOME: home } as Record<string, string>;
    delete env.DATABASE_URL;
    const child = Bun.spawn([process.execPath, '--no-env-file', WORKER, configPath], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const decoder = new TextDecoder();
    let output = '';
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 60_000;
    while (!output.includes('"event":"boundary"')) {
      if (output.includes('"event":"failure"') || output.includes('"event":"done"')) throw new Error(`worker ended before ${point}: ${output}`);
      if (Date.now() > deadline) throw new Error(`worker never reached ${point}: ${output}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`worker exited before ${point}: ${output}${await new Response(child.stderr).text()}`);
      output += decoder.decode(value, { stream: true });
    }
    expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
  }

  const KILLS: Array<[FaultPoint, 'prior' | 'disk', string, boolean]> = [
    ['stuck_recovery:backed_up', 'prior', EDITED, true], ['stuck_recovery:written', 'prior', PRIOR, true], ['stuck_recovery:recovered', 'prior', PRIOR, false],
    ['stuck_recovery:backed_up', 'disk', EDITED, true], ['stuck_recovery:abandoned', 'disk', EDITED, true], ['stuck_recovery:recovered', 'disk', EDITED, false],
  ];
  for (const [point, keep, fileAtKill, recoveryAtKill] of KILLS) {
    test(`SIGKILL at ${point} (--keep ${keep}) resumes to the same end state`, () => run(async () => {
      const s = await fixture().stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
      const hash = (await fixture().repair(s.sourceId)).preview_hash!;
      await killAt(s.sourceId, hash, keep, point);
      expect(readFileSync(s.path, 'utf8')).toBe(fileAtKill);
      expect((await getWriteRequestById(engine, s.id))!.recovery !== null).toBe(recoveryAtKill);
      const [shape] = await engine.executeRaw<{ kind: string | null }>('SELECT jsonb_typeof(recovery) AS kind FROM persistence_requests WHERE id=$1::uuid', [s.id]);
      expect(shape.kind).toBe(recoveryAtKill ? 'object' : null);
      const resumed = await fixture().repair(s.sourceId, { apply: true, expect: hash, keep });
      expect(resumed.outcomes).toEqual({ resolved: 1 });
      expect(readFileSync(s.path, 'utf8')).toBe(keep === 'prior' ? PRIOR : EDITED);
      expect(await getWriteRequestById(engine, s.id)).toMatchObject({ state: keep === 'prior' ? 'queued' : 'conflict', recovery: null });
      expect((await fixture().repair(s.sourceId, { apply: true, expect: hash, keep })).outcomes).toEqual({ replayed: 1 });
    }), 120_000);
  }

  test('mixed version: after a SIGKILL once the write is abandoned, the unchanged resident recovery pass ends the abandoned write conflict', () => run(async () => {
    const s = await fixture().stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const hash = (await fixture().repair(s.sourceId)).preview_hash!;
    await killAt(s.sourceId, hash, 'disk', 'stuck_recovery:abandoned');
    const [record] = await engine.executeRaw<{ before_hash: string; state: string }>("SELECT recovery->>'beforeHash' AS before_hash,state FROM persistence_requests WHERE id=$1::uuid", [s.id]);
    expect(record).toEqual({ before_hash: sha256(PRIOR), state: 'conflict' });
    expect(await recoverPublication(engine, s.id)).toMatchObject({ state: 'conflict', error_code: 'source_changed', recovery: null });
    expect(readFileSync(s.path, 'utf8')).toBe(EDITED);
    const resumed = await fixture().repair(s.sourceId, { apply: true, expect: hash, keep: 'disk' });
    expect(resumed.outcome_items![0]!.detail).toMatchObject({ finished_by: 'another_pass', request_state: 'conflict' });
  }), 120_000);
});
