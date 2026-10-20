/**
 * #6712 PR 2 (L3): the `sync.*` keys in three kinds (src/core/sync-config-keys.ts).
 *
 * Protects:
 *   - `config set` of a retired key warns, names its GBRAIN_SYNC_* replacement and writes nothing (exit 0, not a refusal);
 *   - `config get` of a retired key prints the value a sync runs with (env, else the built-in default) and says a
 *     stored value is not applied; the readers really ignore the stored key;
 *   - a rollback key is written with a note naming its window, and `config get` prints the value in effect and
 *     where it comes from; `sync.foreground_priority` (named as the way back since 0.60.111.0) is accepted without
 *     --force, where it used to be refused as an unknown key;
 *   - `config get`'s resolution of each rollback key agrees with the reader the sync uses;
 *   - doctor `sync_config_keys` reports a stored retired key as unapplied, with the value in effect and its env.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runConfig } from '../src/commands/config.ts';
import { RETIRED_SYNC_KEYS, SYNC_ROLLBACK_KEYS, SYNC_TUNABLE_KEYS, effectiveSyncKey } from '../src/core/sync-config-keys.ts';
import { CONFIG_ROLLBACK_WINDOWS } from '../src/core/wire-skew.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { GIT_HOLD_CAP, GIT_HOLD_ESCALATE_COUNT, GIT_HOLD_ESCALATE_PCT, readSyncHoldPolicy } from '../src/core/persistence/sync-holds.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { waiverBatchEnabled } from '../src/core/persistence/sync-waivers.ts';
import { isFederatedV2Enabled } from '../src/core/feature-flags.ts';
import { readWriteSwitches, resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { syncConfigKeysEntry } from '../src/commands/doctor/checks/sync-config-keys.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const KEYS = [...Object.keys(RETIRED_SYNC_KEYS), ...SYNC_ROLLBACK_KEYS];
const CLEAR = { GBRAIN_SYNC_HOLD_CAP: undefined, GBRAIN_SYNC_HOLD_ESCALATE_COUNT: undefined, GBRAIN_SYNC_HOLD_ESCALATE_PCT: undefined, GBRAIN_SYNC_PARSER_REGRESSION: undefined,
  GBRAIN_SYNC_BULK_MAX_TXN_MS: undefined, GBRAIN_SYNC_BULK: undefined, GBRAIN_SYNC_WAIVE_BATCH: undefined, GBRAIN_SYNC_FOREGROUND_PRIORITY: undefined };
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { for (const key of KEYS) await engine.unsetConfig(key); });

async function config(args: string[]) {
  const logs: string[] = [], errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  try { await runConfig(engine, args); }
  catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; }
  finally { logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore(); }
  return { out: logs.join('\n'), err: errs.join('\n'), exit: exit as number | null };
}

test('the three kinds are disjoint; tunables and rollback keys are registered, retired keys are not; defaults match the readers', () => {
  const retired = Object.keys(RETIRED_SYNC_KEYS);
  for (const key of SYNC_TUNABLE_KEYS) { expect(KNOWN_CONFIG_KEYS).toContain(key); expect(retired).not.toContain(key); expect(SYNC_ROLLBACK_KEYS as string[]).not.toContain(key); }
  for (const key of SYNC_ROLLBACK_KEYS) { expect(KNOWN_CONFIG_KEYS).toContain(key); expect(retired).not.toContain(key); }
  for (const key of retired) expect(KNOWN_CONFIG_KEYS).not.toContain(key);
  expect(String(RETIRED_SYNC_KEYS['sync.hold_cap'].replacement.default)).toBe(String(GIT_HOLD_CAP));
  expect(String(RETIRED_SYNC_KEYS['sync.hold_escalate_count'].replacement.default)).toBe(String(GIT_HOLD_ESCALATE_COUNT));
  expect(String(RETIRED_SYNC_KEYS['sync.hold_escalate_pct'].replacement.default)).toBe(String(GIT_HOLD_ESCALATE_PCT));
  for (const window of Object.values(CONFIG_ROLLBACK_WINDOWS)) {
    expect(window.honored_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(window.floor).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  }
});

test('config set of a retired key warns, names its replacement and writes nothing', async () => withEnv(CLEAR, async () => {
  const set = await config(['set', 'sync.hold_cap', '200']);
  expect(set.exit).toBeNull();
  expect(set.err).toContain('sync.hold_cap was retired in 0.60.266.0');
  expect(set.err).toContain('GBRAIN_SYNC_HOLD_CAP=<value>');
  expect(set.err).toContain('nothing was written');
  expect(await engine.getConfig('sync.hold_cap')).toBeNull();
  const removed = await config(['set', 'sync.knock_on_run_limit', '5']);
  expect(removed.exit).toBeNull();
  expect(removed.err).toContain('nothing replaces it');
  expect(await engine.getConfig('sync.knock_on_run_limit')).toBeNull();
}));

test('config get of a retired key prints the value in effect, and a stored value is reported and not applied', async () => withEnv(CLEAR, async () => {
  await engine.setConfig('sync.hold_cap', '200');
  await engine.setConfig('sync.parser_regression', 'stop');
  const got = await config(['get', 'sync.hold_cap']);
  expect(got.out).toBe('500');
  expect(got.err).toContain('built-in default (GBRAIN_SYNC_HOLD_CAP unset)');
  expect(got.err).toContain('The stored sync.hold_cap=200 is not applied.');
  expect(await readSyncHoldPolicy(engine)).toMatchObject({ cap: 500, parserRegression: 'hold' });
  await withEnv({ GBRAIN_SYNC_HOLD_CAP: '7' }, async () => {
    const env = await config(['get', 'sync.hold_cap']);
    expect(env.out).toBe('7');
    expect(env.err).toContain('environment GBRAIN_SYNC_HOLD_CAP');
    expect((await readSyncHoldPolicy(engine)).cap).toBe(7);
  });
  await engine.setConfig('sync.bulk_max_txn_ms', '100');
  const settings = await resolveBulkSettings(engine, false);
  expect({ maxTxnMs: settings.maxTxnMs, explicit: settings.maxTxnExplicit }).toEqual({ maxTxnMs: 15_000, explicit: false });
}));

test('a rollback key is written with its window; get prints the value in effect and where it comes from', async () => withEnv(CLEAR, async () => {
  const set = await config(['set', 'sync.bulk', 'false']);
  expect(set.exit).toBeNull();
  expect(set.err).toContain('sync.bulk is a rollback key, not a tunable');
  expect(set.err).toContain(CONFIG_ROLLBACK_WINDOWS['sync.bulk'].honored_until);
  expect(await engine.getConfig('sync.bulk')).toBe('false');
  const got = await config(['get', 'sync.bulk']);
  expect(got.out).toBe('false');
  expect(got.err).toContain('brain config: sync.bulk is a rollback key');
  await withEnv({ GBRAIN_SYNC_BULK: '1' }, async () => {
    const env = await config(['get', 'sync.bulk']);
    expect(env.out).toBe('true');
    expect(env.err).toContain('environment GBRAIN_SYNC_BULK');
  });
  const unset = await config(['get', 'sync.job_drain']);
  expect(unset).toMatchObject({ out: 'true', exit: null });
  expect(unset.err).toContain('default: sync.job_drain is a rollback key');
}));

test('sync.foreground_priority is accepted without --force (it used to be refused as an unknown key)', async () => withEnv(CLEAR, async () => {
  const set = await config(['set', 'sync.foreground_priority', 'false']);
  expect(set.exit).toBeNull();
  expect(await engine.getConfig('sync.foreground_priority')).toBe('false');
  resetWriteSwitches();
  expect((await readWriteSwitches(engine)).foreground_priority).toBe(false);
}));

test('config get resolves every rollback key the way its reader does', async () => {
  const cases: Array<[string | null, string | undefined]> = [[null, undefined], ['false', undefined], ['0', undefined], ['true', undefined], ['FALSE', undefined],
    [null, '0'], [null, 'false'], [null, '1'], ['false', '1'], ['true', '0'], [null, '']];
  for (const [stored, envValue] of cases) {
    for (const key of SYNC_ROLLBACK_KEYS) { if (stored === null) await engine.unsetConfig(key); else await engine.setConfig(key, stored); }
    await withEnv({ ...CLEAR, GBRAIN_SYNC_BULK: envValue, GBRAIN_SYNC_WAIVE_BATCH: envValue, GBRAIN_SYNC_FOREGROUND_PRIORITY: envValue }, async () => {
      const said = (key: string) => effectiveSyncKey(key, stored)!.value === 'true';
      const bulk = await resolveBulkSettings(engine, false);
      // PGLite turns bulk off for its own reason; only an explicit off is the key's.
      expect(said('sync.bulk')).toBe(!(bulk.reason && /GBRAIN_SYNC_BULK|sync\.bulk/.test(bulk.reason)));
      expect(said('sync.waive_batch')).toBe(await waiverBatchEnabled(engine));
      expect(said('sync.federated_v2')).toBe(await isFederatedV2Enabled(engine));
      resetWriteSwitches();
      expect(said('sync.foreground_priority')).toBe((await readWriteSwitches(engine)).foreground_priority);
      expect(said('sync.job_drain')).toBe(stored !== 'false');
    });
  }
});

test('doctor sync_config_keys reports a stored retired key as unapplied, and is ok without one', async () => withEnv(CLEAR, async () => {
  const ctx = { engine, progress: { heartbeat: () => {} } } as never;
  const clean = await syncConfigKeysEntry.run(ctx);
  expect(clean).toMatchObject([{ name: 'sync_config_keys', status: 'ok' }]);
  await engine.setConfig('sync.hold_escalate_count', '10');
  await engine.setConfig('sync.waive_batch', 'false');
  const checks = await syncConfigKeysEntry.run(ctx);
  if (!Array.isArray(checks)) throw new Error('sync_config_keys returned no checks');
  const [check] = checks;
  expect(check).toMatchObject({ name: 'sync_config_keys', status: 'warn', fix: { argv: ['gbrain', 'config', 'get', 'sync.hold_escalate_count'], actor: 'agent' } });
  expect(check!.message).toContain('sync.hold_escalate_count=10 (in effect: 50; set GBRAIN_SYNC_HOLD_ESCALATE_COUNT');
  expect(check!.message).toContain('sync.waive_batch=false (until at least');
  // The documented way to clear it: config unset of the retired key.
  expect((await config(['unset', 'sync.hold_escalate_count'])).exit).toBeNull();
  expect(await syncConfigKeysEntry.run(ctx)).toMatchObject([{ name: 'sync_config_keys', status: 'ok' }]);
}));
