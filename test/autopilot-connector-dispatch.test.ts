/**
 * #5673: connector sources (google, github) are synced on the autopilot
 * interval regardless of `local_path`, gated on a recorded sync attempt
 * (`first_attempt_at` in the per-source connector state row), never on
 * `last_sync_at`. The freshness loop dispatches their `sync` without a
 * repoPath; the per-source fan-out runs only their database phases with no
 * brain directory; a never-attempted connector stays idle in both loops and
 * autopilot prints the enable command once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { dispatchPerSource } from '../src/commands/autopilot-fanout.ts';
import { withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { attemptedConnectorSourceIds, recordConnectorSyncAttempt, seedConnectorDispatchAttempts } from '../src/core/persistence/connector-state.ts';
import { CONNECTOR_SOURCE_PHASES } from '../src/core/cycle/phase-scope.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
  dir = mkdtempSync(join(tmpdir(), 'gbrain-5673-'));
});

async function addSource(id: string, config: Record<string, unknown>, localPath: string | null = null): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
    [id, localPath, JSON.stringify(config)]);
}

async function jobs(): Promise<Array<{ name: string; data: Record<string, unknown> }>> {
  return engine.executeRaw("SELECT name, data FROM minion_jobs ORDER BY id");
}

async function freshness(lines: string[]): Promise<void> {
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  (process.stderr as { write: unknown }).write = (chunk: string) => { lines.push(String(chunk)); return true; };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await dispatchFreshnessSyncs(engine, new MinionQueue(engine), { baseInterval: 60, slot: `slot-${Math.random()}`, timeoutMs: 60_000, jsonMode: false });
  } finally {
    (process.stderr as { write: unknown }).write = write;
    console.log = log;
  }
}

describe('#5673 connector dispatch gate', () => {
  test('the freshness loop syncs an attempted connector with a stale local_path, without a repoPath', async () => {
    await addSource('gmail-stale', { kind: 'google' }, join(dir, 'missing-checkout'));
    await recordConnectorSyncAttempt(engine, 'gmail-stale');
    await freshness([]);
    const queued = await jobs();
    expect(queued.map(job => job.name)).toEqual(['sync']);
    expect(queued[0].data.sourceId).toBe('gmail-stale');
    expect(queued[0].data.repoPath).toBeUndefined();
  });

  test('a never-attempted connector stays idle in both loops and prints the enable command once', async () => {
    await addSource('gmail-new', { kind: 'google' });
    await addSource('notes', {}, dir);
    const lines: string[] = [];
    await freshness(lines);
    await freshness(lines);
    expect((await jobs()).filter(job => job.data.sourceId === 'gmail-new')).toEqual([]);
    const notices = lines.filter(line => line.includes('gbrain sync --source gmail-new'));
    expect(notices.length).toBe(1);

    await dispatchPerSource(engine, new MinionQueue(engine), { repoPath: dir, slot: 's', timeoutMs: 60_000, fanoutMax: 10, jsonMode: true, emit: () => {}, log: () => {} });
    expect((await jobs()).filter(job => job.data.source_id === 'gmail-new')).toEqual([]);
  });

  test('a connector whose first run aborts is dispatched on the next interval', async () => {
    await addSource('gh-abort', { kind: 'github' });
    await expect(withConnectorSync(engine, 'gh-abort', 'github', {}, {}, async () => { throw new Error('provider unreachable'); }))
      .rejects.toThrow('provider unreachable');
    expect((await attemptedConnectorSourceIds(engine)).has('gh-abort')).toBe(true);
    await freshness([]);
    expect((await jobs()).map(job => [job.name, job.data.sourceId])).toEqual([['sync', 'gh-abort']]);
  });

  test('a dry run does not open the dispatch gate', async () => {
    await addSource('gh-preview', { kind: 'github' });
    await withConnectorSync(engine, 'gh-preview', 'github', {}, { dryRun: true } as never, async () => null);
    expect((await attemptedConnectorSourceIds(engine)).has('gh-preview')).toBe(false);
  });

  test('the fan-out runs only database phases for an attempted connector, with no brain directory', async () => {
    await addSource('notes', {}, dir);
    await addSource('gmail-stale', { kind: 'google' }, join(dir, 'missing-checkout'));
    await addSource('gmail-cleared', { kind: 'google' });
    await recordConnectorSyncAttempt(engine, 'gmail-stale');
    await recordConnectorSyncAttempt(engine, 'gmail-cleared');
    await dispatchPerSource(engine, new MinionQueue(engine), { repoPath: dir, slot: 's', timeoutMs: 60_000, fanoutMax: 10, jsonMode: true, emit: () => {}, log: () => {} });
    const cycles = (await jobs()).filter(job => job.name === 'autopilot-cycle');
    const byId = Object.fromEntries(cycles.map(job => [job.data.source_id, job.data]));
    expect(Object.keys(byId).sort()).toEqual(['gmail-cleared', 'gmail-stale', 'notes']);
    for (const id of ['gmail-stale', 'gmail-cleared']) {
      expect(byId[id].phases).toEqual(CONNECTOR_SOURCE_PHASES);
      expect(byId[id].phases).not.toContain('sync');
      expect(byId[id].repoPath).toBeNull();
      expect(byId[id].pull).toBe(false);
    }
    expect(byId.notes.phases).toContain('sync');
  });

  test('connectors whose paths were all cleared still get their own cycles instead of the legacy one', async () => {
    await addSource('gmail-cleared', { kind: 'google' });
    await recordConnectorSyncAttempt(engine, 'gmail-cleared');
    const result = await dispatchPerSource(engine, new MinionQueue(engine), { repoPath: dir, slot: 's', timeoutMs: 60_000, fanoutMax: 10, jsonMode: true, emit: () => {}, log: () => {} });
    expect(result.legacy_fallback).toBe(false);
    const cycles = (await jobs()).filter(job => job.name === 'autopilot-cycle');
    expect(cycles.map(job => [job.data.source_id, job.data.repoPath])).toEqual([['gmail-cleared', null]]);
  });

  test('the upgrade migration records an attempt for every connector the pre-upgrade loop dispatched', async () => {
    await addSource('gmail-dispatched', { kind: 'google' }, dir);
    await addSource('gmail-disabled', { kind: 'google', syncEnabled: false }, dir);
    await addSource('gmail-pathless', { kind: 'google' });
    await addSource('notes', {}, dir);
    await seedConnectorDispatchAttempts(engine);
    await seedConnectorDispatchAttempts(engine);
    const attempted = await attemptedConnectorSourceIds(engine);
    expect(attempted.has('gmail-dispatched')).toBe(true);
    expect(attempted.has('gmail-disabled')).toBe(false);
    expect(attempted.has('gmail-pathless')).toBe(false);
    expect(attempted.has('notes')).toBe(false);
  });
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
