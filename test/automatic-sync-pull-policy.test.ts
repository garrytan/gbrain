/**
 * #5463 (automatic-pull half): automatic sync never requests a Git pull for a
 * managed canonical source, and missing or malformed persistence metadata
 * refuses instead of granting one.
 *
 * Protects: autopilot freshness `sync` jobs and per-source fanout cycles on a
 * managed brain, which managed sync refuses outright when they carry a pull.
 * Fails when: the pull flag is derived from `remote_url` alone again.
 * Why new: the fanout's #5255 cycle-side skip never covered the freshness
 * `sync` job, and the activation-pending lookup fails open on bad metadata.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { dispatchPerSource } from '../src/commands/autopilot-fanout.ts';
import { automaticSyncPull } from '../src/core/persistence/automatic-sync-policy.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import type { SqlEngine } from '../src/core/persistence/model.ts';

const REMOTE = { remote_url: 'https://example.invalid/acme-example.git' };

function stub(singleton: readonly unknown[], claimed = false, fail = false): SqlEngine {
  return { executeRaw: async (sql: string) => {
    if (fail) throw new Error('synthetic metadata unavailable');
    if (sql.includes('FROM persistence_brain')) return singleton;
    if (sql.includes('FROM persistence_source_bindings')) return claimed ? [{ source_id: 'example' }] : [];
    throw new Error(`unexpected query: ${sql}`);
  } } as unknown as SqlEngine;
}

describe('automaticSyncPull', () => {
  test('pull needs a remote, an unmanaged brain and no binding; clone and immutable flags grant nothing', async () => {
    for (const encoded of [false, true]) {
      const config = { ...REMOTE, immutable: true, managed_clone: true, federated: false };
      const source = { id: 'example', config: encoded ? JSON.stringify(config) : config };
      expect(await automaticSyncPull(stub([{ enabled: false }]), source)).toBe(true);
      expect(await automaticSyncPull(stub([{ enabled: false }], true), source)).toBe(false);
      expect(await automaticSyncPull(stub([{ enabled: true }]), source)).toBe(false);
      expect(await automaticSyncPull(stub([{ enabled: true }], true), source)).toBe(false);
    }
    expect(await automaticSyncPull(stub([], false, true), { id: 'example', config: {} })).toBe(false);
  });

  test('a metadata read failure propagates instead of falling back to a pull', async () => {
    await expect(automaticSyncPull(stub([], false, true), { id: 'example', config: REMOTE })).rejects.toThrow('synthetic metadata unavailable');
  });

  for (const [label, singleton] of [
    ['missing', []], ['null row', [null]], ['missing enabled', [{}]], ['null enabled', [{ enabled: null }]],
    ['string false', [{ enabled: 'false' }]], ['numeric false', [{ enabled: 0 }]], ['ambiguous', [{ enabled: false }, { enabled: true }]],
  ] as const) {
    test(`refuses ${label} persistence metadata`, async () => {
      await expect(automaticSyncPull(stub(singleton), { id: 'example', config: REMOTE })).rejects.toMatchObject({ code: 'storage_error' });
    });
  }

  test('the refusal renders the agent contract with a read-only probe and verify', async () => {
    const error = await automaticSyncPull(stub([]), { id: 'example', config: REMOTE }).catch((e: unknown) => e);
    const json = renderCliError(error, { json: true, command: 'autopilot', tty: false });
    const env = JSON.parse(json.stdout!);
    expect(env.code).toBe('storage_error');
    expect(env.message).toBe('Automatic sync requires exactly one known boolean persistence state.');
    expect(env.why).toContain('rather than risk a Git pull');
    expect(env.fix).toMatchObject({
      next: 'run', command: 'gbrain sources writer status --probe --json', consent: [], actor: 'agent',
      verify: { argv: ['gbrain', 'doctor', '--json'] },
    });
    expect(renderCliError(error, { json: false, command: 'autopilot', tty: false }).stderr)
      .toContain('Fix: gbrain sources writer status --probe --json');
  });
});

describe('automatic dispatch on a real brain', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'gbrain-5463-'));
    await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
      ['notes', dir, JSON.stringify(REMOTE)]);
  });

  const setManaged = (enabled: boolean) => engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
  const queued = () => engine.executeRaw<{ name: string; data: Record<string, unknown> }>('SELECT name, data FROM minion_jobs ORDER BY id');
  const freshness = async () => {
    const write = process.stderr.write.bind(process.stderr);
    const log = console.log;
    (process.stderr as { write: unknown }).write = () => true;
    console.log = () => {};
    try {
      await dispatchFreshnessSyncs(engine, new MinionQueue(engine), { baseInterval: 60, slot: `slot-${Math.random()}`, timeoutMs: 60_000, jsonMode: true });
    } finally {
      (process.stderr as { write: unknown }).write = write;
      console.log = log;
    }
  };
  const fanout = (events: string[] = []) => dispatchPerSource(engine, new MinionQueue(engine),
    { repoPath: dir, slot: 's', timeoutMs: 60_000, fanoutMax: 10, jsonMode: true, emit: (line) => events.push(line), log: () => {} });

  test('an unmanaged brain still pulls a remote source in both loops', async () => {
    await freshness();
    await fanout();
    const jobs = await queued();
    expect(jobs.map(j => [j.name, j.data.pull])).toEqual([['sync', true], ['autopilot-cycle', true]]);
  });

  test('a managed brain still syncs the source in both loops, but never requests a pull', async () => {
    await setManaged(true);
    await freshness();
    await fanout();
    const jobs = await queued();
    expect(jobs.map(j => [j.name, j.data.pull])).toEqual([['sync', false], ['autopilot-cycle', false]]);
    expect(jobs[1].data.phases).toContain('sync');
  });

  test('missing persistence metadata queues nothing for the remote source and reports why', async () => {
    await engine.executeRaw('DELETE FROM persistence_brain');
    const events: string[] = [];
    await freshness();
    const result = await fanout(events);
    expect(await queued()).toEqual([]);
    expect(result.dispatched).toEqual([]);
    expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'fanout_submit_failed', source_id: 'notes', error: 'Automatic sync requires exactly one known boolean persistence state.',
    }));
  });
});
