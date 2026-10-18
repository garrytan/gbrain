/**
 * #6451 (wave 15 P7.2): `autopilot.git_pull` is the brain-wide opt-out for the
 * Git pull that automatic sync (autopilot freshness + per-source fanout)
 * requests for an unmanaged source with a remote URL. Default on; an explicit
 * falsy value turns the pull off at the single policy point
 * (`automaticSyncPull`) without touching the rest of the cycle, and the
 * daemon tick says so once. Explicit `gbrain sync --pull` is unaffected.
 *
 * Protects: the `pull` flag on queued `sync` / `autopilot-cycle` jobs and the
 * tick's status line. Fails when: the key is ignored (pull stays true), when
 * the managed-brain refusal regresses, or when the knob reads persistence
 * metadata it no longer needs. Why new: `test/automatic-sync-pull-policy.test.ts`
 * covers the managed/unmanaged policy only. Seam: none beyond `engine.getConfig`.
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
import type { SqlEngine } from '../src/core/persistence/model.ts';

// The key name is part of the contract (`gbrain config set autopilot.git_pull false`), so it is spelled here, not imported.
const AUTOPILOT_GIT_PULL_KEY = 'autopilot.git_pull';
const REMOTE = { remote_url: 'https://example.invalid/acme-example.git' };
const source = { id: 'example', config: REMOTE };

function stub(gitPull: string | null, singleton: readonly unknown[] = [{ enabled: false }]): SqlEngine & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    getConfig: async (key: string) => (key === AUTOPILOT_GIT_PULL_KEY ? gitPull : null),
    executeRaw: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM persistence_brain')) return singleton;
      if (sql.includes('FROM persistence_source_bindings')) return [];
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as SqlEngine & { queries: string[] };
}

describe('automaticSyncPull honors autopilot.git_pull (#6451)', () => {
  test('unset, true and garbage-free truthy spellings keep the pull on', async () => {
    for (const raw of [null, 'true', 'on', ' Yes ', '1']) {
      expect(await automaticSyncPull(stub(raw), source)).toBe(true);
    }
  });

  test('an explicit falsy value turns the pull off before any persistence read', async () => {
    for (const raw of ['false', '0', 'off', 'no']) {
      const engine = stub(raw);
      expect(await automaticSyncPull(engine, source)).toBe(false);
      expect(engine.queries).toEqual([]);
    }
  });

  test('the knob never turns a pull ON for a managed brain or a local-only source', async () => {
    expect(await automaticSyncPull(stub('true', [{ enabled: true }]), source)).toBe(false);
    expect(await automaticSyncPull(stub('true'), { id: 'example', config: {} })).toBe(false);
  });

  test('an engine without a config reader keeps the default (pull on)', async () => {
    const bare = { executeRaw: async (sql: string) => (sql.includes('FROM persistence_brain') ? [{ enabled: false }] : []) } as unknown as SqlEngine;
    expect(await automaticSyncPull(bare, source)).toBe(true);
  });
});

describe('automatic dispatch with autopilot.git_pull=false on a real brain', () => {
  let engine: PGLiteEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('version', String(LATEST_VERSION));
    dir = mkdtempSync(join(tmpdir(), 'gbrain-6451-'));
    await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
      ['notes', dir, JSON.stringify(REMOTE)]);
  });

  const queued = () => engine.executeRaw<{ name: string; data: Record<string, unknown> }>('SELECT name, data FROM minion_jobs ORDER BY id');
  const freshness = async (jsonMode: boolean): Promise<string[]> => {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const log = console.log;
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await dispatchFreshnessSyncs(engine, new MinionQueue(engine), { baseInterval: 60, slot: `slot-${Math.random()}`, timeoutMs: 60_000, jsonMode });
    } finally {
      (process.stderr as { write: unknown }).write = write;
      console.log = log;
    }
    return lines;
  };
  const fanout = () => dispatchPerSource(engine, new MinionQueue(engine),
    { repoPath: dir, slot: 's', timeoutMs: 60_000, fanoutMax: 10, jsonMode: true, emit: () => {}, log: () => {} });

  test('both loops still sync the remote source but request no pull, and the tick says why', async () => {
    await engine.setConfig(AUTOPILOT_GIT_PULL_KEY, 'false');
    const lines = await freshness(false);
    await fanout();
    const jobs = await queued();
    expect(jobs.map(j => [j.name, j.data.pull])).toEqual([['sync', false], ['autopilot-cycle', false]]);
    expect(jobs[1].data.phases).toContain('sync');
    expect(lines.filter(l => l.includes('git_pull: off'))).toHaveLength(1);
  });

  test('under --json the status line is one NDJSON event on stderr', async () => {
    await engine.setConfig(AUTOPILOT_GIT_PULL_KEY, 'false');
    const events = (await freshness(true)).map(l => JSON.parse(l));
    expect(events.filter(e => e.event === 'git_pull_disabled')).toEqual([{ event: 'git_pull_disabled', key: AUTOPILOT_GIT_PULL_KEY }]);
  });

  test('with the key unset the pull is requested and no status line is printed', async () => {
    const lines = await freshness(false);
    await fanout();
    expect((await queued()).map(j => [j.name, j.data.pull])).toEqual([['sync', true], ['autopilot-cycle', true]]);
    expect(lines.filter(l => l.includes('git_pull'))).toEqual([]);
  });
});
