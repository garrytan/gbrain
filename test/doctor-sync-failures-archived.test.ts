import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { recordFailures } from '../src/core/sync-failure-ledger.ts';
import { recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { withEnv } from './helpers/with-env.ts';

// foresights#5452 — failures on an archived source cannot be cleared (sync
// refuses archived sources) and carry no live signal; doctor's
// sync_failures check must exclude them and say so.
const home = mkdtempSync(join(tmpdir(), 'gbrain-5452-'));
const env = { GBRAIN_SYNC_FAILURES_DIR: home };

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('TRUNCATE sources CASCADE');
  rmSync(join(home, 'sync-failures.jsonl'), { force: true });
});

describe('sync_failures ignores archived-source rows (#5452)', () => {
  test('failures on an archived source are excluded and reported as ignored', async () => withEnv(env, async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('src-active','src-active'),('src-archived','src-archived')`);
    await engine.executeRaw(`UPDATE sources SET archived=true, archived_at=now(), archive_expires_at=now()+interval '72 hours' WHERE id='src-archived'`);
    recordFailures('src-active', [{ path: 'a.md', error: 'YAML broke' }], 'c1');
    recordFailures('src-archived', [{ path: 'b.md', error: 'YAML broke' }], 'c2');

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check).not.toBeNull();
    expect(check!.status).not.toBe('ok');
    expect(check!.message).toContain('1 unresolved');
    expect(check!.message).toContain('1 failure(s) on archived source(s) ignored');
    expect(check!.message).toContain('src-active');
    expect(check!.message).not.toContain('src-archived');
  }));

  test('only-archived failures resolve to ok, not an unclearable fail', async () => withEnv(env, async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('src-archived','src-archived')`);
    await engine.executeRaw(`UPDATE sources SET archived=true, archived_at=now(), archive_expires_at=now()+interval '72 hours' WHERE id='src-archived'`);
    recordFailures('src-archived', [{ path: 'b.md', error: 'YAML broke' }], 'c2');

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check?.status).toBe('ok');
    expect(check!.message).toContain('1 failure(s) on archived source(s) ignored');
  }));

  test('managed-ledger failures on archived sources are excluded too', async () => withEnv(env, async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('src-m-arch','src-m-arch')`);
    await engine.executeRaw(`UPDATE sources SET archived=true, archived_at=now(), archive_expires_at=now()+interval '72 hours' WHERE id='src-m-arch'`);
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>(
      `SELECT incarnation::text AS incarnation FROM sources WHERE id='src-m-arch'`);
    // The managed ledger lives in op_checkpoints, not the JSONL file — this
    // row exercises readManagedSyncFailures' orphan path (failure recorded
    // for a source whose managed-sync cursor is gone).
    await recordManagedSyncFailure(engine, {
      source_id: 'src-m-arch', source_incarnation: incarnation, path: 'blocked.md',
      code: 'sync_incomplete', message: 'cursor unfinished', request_id: null,
      run_id: 'run-arch', target: null, cursor_key: 'ck-arch', phase: 'resume',
      state: 'unfinished', observation_id: 'obs-arch',
    });
    const check = await checkSyncFailures(engine, { remote: false });
    expect(check?.status).toBe('ok');
    expect(check!.message).toContain('1 failure(s) on archived source(s) ignored');
    expect(check!.message).not.toContain('src-m-arch');
    expect(check!.message).not.toContain('blocked.md');
  }));
});
