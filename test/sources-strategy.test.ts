/**
 * `gbrain sources set-strategy <id> <markdown|code|auto>` (#4899, PR #5955 by
 * @rokas-tarasevicius; fix wave 14 P2.7 ships the reviewed minimum surface).
 *
 * Protects: the one writer persists `sources.config.strategy` by a single-key
 * merge (other keys survive), `sources list --json` reads it back, and the
 * value is the one `sync --all` already passes to every per-source sync. An
 * invalid value or a connector source is refused. [R26]: a source with an
 * unfinished managed sync run refuses a change until the run finishes or is
 * retired, because its frozen manifest was classified under the old strategy.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { runSetStrategy, unfinishedManagedSyncRuns } from '../src/commands/sources-strategy.ts';
import { listSources } from '../src/core/sources-ops.ts';
import { isSyncStrategy, SYNC_STRATEGIES } from '../src/core/sync.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function cli(args: string[]): Promise<{ out: string; err: string; exit: number | null }> {
  const out: string[] = [], err: string[] = [];
  let exit: number | null = null;
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error('EXIT'); }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { err.push(parts.map(String).join(' ')); });
  try { await runSources(engine, args); } catch (error) { if (!(error instanceof Error && error.message === 'EXIT')) throw error; }
  finally { exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}
const config = async (id: string) => (await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [id]))[0]!.config;

test('the strategy enum is closed and shared', () => {
  expect([...SYNC_STRATEGIES]).toEqual(['markdown', 'code', 'auto']);
  expect(isSyncStrategy('code')).toBe(true);
  expect(isSyncStrategy('CODE')).toBe(false);
  expect(isSyncStrategy(undefined)).toBe(false);
});

test('set-strategy persists config.strategy by a single-key merge and sources list --json reads it back', async () => {
  const id = `strat-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/tmp/${id}','{"federated":true,"mirror_read_only":true}')`, [id]);
  expect((await listSources(engine)).find(source => source.id === id)).toMatchObject({ strategy: null, federated: true });

  const set = await cli(['set-strategy', id, 'code']);
  expect(set.exit).toBeNull();
  expect(set.out).toContain(`Source "${id}" now syncs with strategy code.`);
  expect(set.out).toContain(`gbrain sync --source ${id} --full`);
  expect(await config(id)).toEqual({ federated: true, mirror_read_only: true, strategy: 'code' });
  expect((await listSources(engine)).find(source => source.id === id)).toMatchObject({ strategy: 'code', federated: true });
  const listed = JSON.parse((await cli(['list', '--json'])).out) as { sources: Array<{ id: string; strategy: string | null }> };
  expect(listed.sources.find(source => source.id === id)).toMatchObject({ strategy: 'code' });

  // Same value again: no re-classification hint, nothing else changes.
  const same = await cli(['set-strategy', id, 'code']);
  expect(same.out).not.toContain('--full');
  expect(await config(id)).toEqual({ federated: true, mirror_read_only: true, strategy: 'code' });
});

test('an invalid strategy, a missing source and a connector source are refused without writing', async () => {
  const id = `strat-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/tmp/${id}','{}')`, [id]);
  const invalid = await cli(['set-strategy', id, 'yaml']);
  expect(invalid).toMatchObject({ exit: 2 });
  expect(invalid.err).toContain('invalid strategy "yaml"');
  expect(await config(id)).toEqual({});
  expect((await cli(['set-strategy', `missing-${randomUUID().slice(0, 6)}`, 'code'])).exit).toBe(4);
  expect((await cli(['set-strategy'])).exit).toBe(2);
  const connector = `gh-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"kind":"github"}')`, [connector]);
  const refused = await cli(['set-strategy', connector, 'code']);
  expect(refused.exit).toBe(2);
  expect(refused.err).toContain('github connector source');
  expect(await config(connector)).toEqual({ kind: 'github' });
});

test('[R26] an unfinished managed sync run refuses a strategy change and names how to finish or retire it', async () => {
  const id = `strat-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/tmp/${id}','{"strategy":"markdown"}')`, [id]);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)",
    [`ck-${id}`, JSON.stringify([{ sourceId: id, incarnation, runId: 'run-open', index: 3, target: 'abc', authority: { writer: { principal: { kind: 'local_cli', id: randomUUID() } } } }])]);
  expect(await unfinishedManagedSyncRuns(engine, id)).toEqual([{ cursor_key: `ck-${id}`, run_id: 'run-open', index: 3 }]);

  const refused = await cli(['set-strategy', id, 'code']);
  expect(refused.exit).toBe(1);
  expect(refused.err).toContain('sync_run_unfinished');
  expect(refused.err).toContain(`gbrain sync --source ${id} --no-pull`);
  expect(refused.err).toContain(`gbrain repair managed-sync-orphans --source ${id}`);
  expect(await config(id)).toEqual({ strategy: 'markdown' });
  // Re-stating the current value is a no-op, not a change, so it is allowed.
  expect((await cli(['set-strategy', id, 'markdown'])).exit).toBeNull();
  // Once the run completes, the change goes through.
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,done}','true'::jsonb) WHERE fingerprint=$1`, [`ck-${id}`]);
  expect((await cli(['set-strategy', id, 'code'])).exit).toBeNull();
  expect(await config(id)).toEqual({ strategy: 'code' });
});

test('runSetStrategy is the module sources dispatches to', () => {
  expect(typeof runSetStrategy).toBe('function');
});
