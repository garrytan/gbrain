/**
 * #5673: `gbrain sources set-path <id> --clear` clears a connector source's
 * stale local_path. It takes no path, refuses a filesystem source (naming
 * set-path <id> <path> and remove), and refuses a connector bound to a
 * canonical owner (naming writer status). A cleared connector keeps its
 * interval sync and database phases.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { recordConnectorSyncAttempt } from '../src/core/persistence/connector-state.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { dispatchPerSource } from '../src/commands/autopilot-fanout.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { CONNECTOR_SOURCE_PHASES } from '../src/core/cycle/phase-scope.ts';

let engine: PGLiteEngine;

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
});

async function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  let code: number | null = null;
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c ?? 0; throw new Error(`EXIT:${c}`); }) as never);
  try { await runSources(engine, args); } catch (e) { if (!String(e).includes('EXIT:')) throw e; }
  finally { log.mockRestore(); error.mockRestore(); exit.mockRestore(); }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function localPath(id: string): Promise<string | null> {
  return (await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [id]))[0].local_path;
}

describe('#5673 sources set-path --clear', () => {
  test('clears a connector path; the connector keeps its interval sync and database phases', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('gmail-a', 'gmail-a', '/stale/checkout', '{\"kind\":\"google\"}'::jsonb)");
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('notes', 'notes', '/tmp', '{}'::jsonb)");
    await recordConnectorSyncAttempt(engine, 'gmail-a');
    const cleared = await run(['set-path', 'gmail-a', '--clear']);
    expect(cleared.code, cleared.err).toBeNull();
    expect(cleared.out).toContain('Cleared source "gmail-a" local_path (was /stale/checkout).');
    expect(await localPath('gmail-a')).toBeNull();

    const queue = new MinionQueue(engine);
    const quiet = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatchFreshnessSyncs(engine, queue, { baseInterval: 60, slot: 'a', timeoutMs: 60_000, jsonMode: false });
      await dispatchFreshnessSyncs(engine, queue, { baseInterval: 60, slot: 'a', timeoutMs: 60_000, jsonMode: false });
    } finally { quiet.mockRestore(); }
    await dispatchPerSource(engine, queue, { repoPath: '/tmp', slot: 'a', timeoutMs: 60_000, fanoutMax: 10, jsonMode: true, emit: () => {}, log: () => {} });
    const jobs = await engine.executeRaw<{ name: string; data: Record<string, unknown> }>('SELECT name, data FROM minion_jobs ORDER BY id');
    expect(jobs.filter(job => job.name === 'sync' && job.data.sourceId === 'gmail-a').length).toBe(1);
    const cycle = jobs.find(job => job.name === 'autopilot-cycle' && job.data.source_id === 'gmail-a');
    expect(cycle?.data.phases).toEqual(CONNECTOR_SOURCE_PHASES);
  });

  test('refuses a filesystem source, naming set-path with a path and remove', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('notes', 'notes', '/tmp', '{}'::jsonb)");
    const refused = await run(['set-path', 'notes', '--clear']);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('gbrain sources set-path notes <path>');
    expect(refused.err).toContain('gbrain sources remove notes');
    expect(await localPath('notes')).toBe('/tmp');
  });

  test('refuses --clear together with a path', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('gmail-a', 'gmail-a', '/stale', '{\"kind\":\"google\"}'::jsonb)");
    const refused = await run(['set-path', 'gmail-a', '/other', '--clear']);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('--clear takes no path');
    expect(await localPath('gmail-a')).toBe('/stale');
  });

  test('refuses a connector bound to a canonical owner, naming writer status', async () => {
    const [source] = await engine.executeRaw<{ incarnation: string }>(
      "INSERT INTO sources (id, name, local_path, config) VALUES ('gh-bound', 'gh-bound', '/checkout', '{\"kind\":\"github\"}'::jsonb) RETURNING incarnation");
    const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id');
    await engine.executeRaw('INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES ($1, $2::uuid, $3::uuid)',
      ['gh-bound', source.incarnation, worktree.id]);
    const refused = await run(['set-path', 'gh-bound', '--clear']);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('gbrain sources writer status gh-bound');
    expect(await localPath('gh-bound')).toBe('/checkout');
  });

  test('the sources help and the set-path usage line list --clear', async () => {
    const help = await run(['--help']);
    expect(help.out + help.err).toContain('set-path <id> --clear');
    const usage = await run(['set-path']);
    expect(usage.err).toContain('gbrain sources set-path <id> --clear');
  });
});
