/**
 * BrainEngine parity: the config rows the dream breaker and the write deferrals keep their maps in
 * (ensureDreamMapConfigRow, lockDreamMapConfigRow, writeDreamMapConfigRow, recordDreamBreakerReset) and the dream
 * cycle's source incarnation read (readDreamSourceIncarnation), src/core/engine-sql/dream-cycle.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `ensure` inserts `{}` only for a key with no row; `lock` answers `{ value, now }` (the store clock as an
 *    ISO instant with milliseconds) or null for a missing row; `write` updates a row that exists and writes nothing for
 *    a missing key. `recordDreamBreakerReset` keeps only the other entries whose value starts with four digits and `-`
 *    and is newer than 24 hours, reads a missing row or a value that is not a JSON object as empty, sets the base key
 *    to the clock plus one millisecond and writes the map in jsonb text form (keys by length then bytes). A kept entry
 *    that starts like a date but is not an instant fails the call, as the timestamptz cast does.
 *    `readDreamSourceIncarnation` answers `{ incarnation }` for a stored source (archived too) and null for none.
 *  - Regression: without these members the Rust engine drops the `config` capability and a dream cycle on a Rust brain
 *    cannot arm its breaker or defer a write. An engine that keeps stale resets would trip the breaker on week-old
 *    failures; one that reads a damaged value as a map loses the new reset.
 *  - Why existing coverage misses it: dream-cycle-sites.test.ts checks the map only by its key set and a clock shape,
 *    never what an old or damaged entry becomes or the stored text.
 *  - Seam: none. Rows are seeded with setConfig; clocks are compared inside a window of the JavaScript clock.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** The stored map with every stamp replaced by its age in whole hours, once the base stamp is checked against the JavaScript clock plus one millisecond. */
async function resetText(engine: import('../../src/core/engine.ts').BrainEngine, resets: string, base: string) {
  const text = (await engine.getConfig(resets)) ?? '';
  const stamp = (JSON.parse(text) as Record<string, string>)[base]!;
  expect(STAMP.test(stamp)).toBe(true);
  expect(Math.abs(Date.parse(stamp) - Date.now())).toBeLessThan(10_000);
  return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, at => `${Math.round((Date.now() - Date.parse(at)) / HOUR)}h ago`);
}

describe('engine parity: the dream map config rows', () => {
  parityTest('ensure creates an empty map once, write updates only a stored row and lock reads it with the clock', {
    methods: ['getConfig', 'transaction', 'ensureDreamMapConfigRow', 'lockDreamMapConfigRow', 'writeDreamMapConfigRow'],
  }, async (engine) => {
    const key = 'dream.test.map';
    await engine.transaction(tx => tx.writeDreamMapConfigRow(key, '{"ignored":true}'));
    const afterBlindWrite = await engine.getConfig(key);
    const missing = await engine.transaction(tx => tx.lockDreamMapConfigRow(key));
    const before = Date.now();
    const created = await engine.transaction(async tx => {
      await tx.ensureDreamMapConfigRow(key);
      return tx.lockDreamMapConfigRow(key);
    });
    await engine.transaction(tx => tx.writeDreamMapConfigRow(key, '{"a": ["x"]}'));
    const kept = await engine.transaction(async tx => {
      await tx.ensureDreamMapConfigRow(key);
      return (await tx.lockDreamMapConfigRow(key))?.value;
    });
    const out = { afterBlindWrite, missing, createdValue: created?.value, clockShape: STAMP.test(created?.now ?? ''), kept, stored: await engine.getConfig(key) };
    expect(Math.abs(Date.parse(created!.now) - before)).toBeLessThan(10_000);
    expect(out).toEqual({ afterBlindWrite: null, missing: null, createdValue: '{}', clockShape: true, kept: '{"a": ["x"]}', stored: '{"a": ["x"]}' });
    return out;
  });

  parityTest('a reset keeps the other entries dated within 24 hours, drops the rest and writes the map in jsonb order', {
    methods: ['getConfig', 'setConfig', 'recordDreamBreakerReset'],
  }, async (engine) => {
    const resets = 'dream.test.resets';
    const base = 'dream:phase:synthesize:default';
    await engine.setConfig(resets, JSON.stringify({
      zz: ago(HOUR), aaa: ago(2 * HOUR), b: ago(25 * HOUR), plain: 'x', number: 5, nested: { at: ago(HOUR) }, empty: '', [base]: ago(3 * HOUR),
    }));
    await engine.recordDreamBreakerReset(resets, base);
    const first = await resetText(engine, resets, base);
    // A second reset of another base keeps the first one, which is now newer than the window.
    await engine.recordDreamBreakerReset(resets, 'dream:phase:patterns:default');
    const second = Object.keys(JSON.parse((await engine.getConfig(resets))!) as object);
    const out = { first, second };
    expect(first).toBe(`{"zz": "1h ago", "aaa": "2h ago", "${base}": "0h ago"}`);
    expect(second).toEqual(['zz', 'aaa', 'dream:phase:patterns:default', 'dream:phase:synthesize:default']);
    return out;
  });

  parityTest('a reset reads a missing row and a value that is not a JSON object as empty', {
    methods: ['getConfig', 'setConfig', 'recordDreamBreakerReset'],
  }, async (engine) => {
    const out: Record<string, string> = {};
    await engine.recordDreamBreakerReset('dream.test.none', 'base');
    out.missing = await resetText(engine, 'dream.test.none', 'base');
    for (const [name, value] of [['array', '[1,2]'], ['text', 'not json'], ['scalar', '"2030-01-01T00:00:00.000Z"'], ['null', 'null'], ['empty', ''], ['nul', '{"k":"\\u0000"}']] as const) {
      await engine.setConfig(`dream.test.${name}`, value);
      await engine.recordDreamBreakerReset(`dream.test.${name}`, 'base');
      out[name] = await resetText(engine, `dream.test.${name}`, 'base');
    }
    for (const text of Object.values(out)) expect(text).toBe('{"base": "0h ago"}');
    return out;
  });

  parityTest('a dated entry that is not an instant fails the reset and leaves the row as it was', {
    methods: ['getConfig', 'setConfig', 'recordDreamBreakerReset'],
  }, async (engine) => {
    await engine.setConfig('dream.test.bad', '{"x": "2026-garbage"}');
    // A typed refusal is not the failure under test: it ends the case.
    const failed = await engine.recordDreamBreakerReset('dream.test.bad', 'base').then(() => false, (e: { code?: string }) => {
      if (e?.code === 'engine_capability_missing') throw e;
      return true;
    });
    const out = { failed, stored: await engine.getConfig('dream.test.bad') };
    expect(out).toEqual({ failed: true, stored: '{"x": "2026-garbage"}' });
    return out;
  });

  parityTest('readDreamSourceIncarnation answers a stored source, archived or not, and null for an unknown one', {
    methods: ['readDreamSourceIncarnation'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'retired');
    await archiveSource(engine, backend, 'retired');
    const read = async (id: string) => {
      const row = await engine.readDreamSourceIncarnation(id);
      return row === null ? null : { keys: Object.keys(row), incarnation: typeof row.incarnation === 'string' && row.incarnation !== '' };
    };
    const out = { default: await read('default'), other: await read('other'), retired: await read('retired'), unknown: await read('no-such-source') };
    const same = { keys: ['incarnation'], incarnation: true };
    expect(out).toEqual({ default: same, other: same, retired: same, unknown: null });
    expect((await engine.readDreamSourceIncarnation('other'))!.incarnation).not.toBe((await engine.readDreamSourceIncarnation('default'))!.incarnation);
    return out;
  });
});
