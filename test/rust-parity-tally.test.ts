/**
 * The Rust arm's pinned tally (test/engine-parity/rust-tally.ts): a parity file that loses equal cases or gains stopped
 * cases against its pin fails; one that does better passes and names the new counts; an incomplete run is not checked.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRustTally, keepStopReasons, parsePins, renderPins, RUST_MANAGED_TALLY_PATH, RUST_TALLY_PATH, tallyTarget } from './engine-parity/rust-tally.ts';

const FILE = 'test/engine-parity/search.test.ts';
const pins = parsePins(renderPins([[FILE, { equal: 14, stopped: 2 }]]));
const tally = (compared: number, refused: number, extra: Partial<{ diverged: number; skipped: number }> = {}) =>
  ({ compared, refused, diverged: extra.diverged ?? 0, skipped: extra.skipped ?? 0 });
const outcome = (run: () => unknown) => {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: (error as Error).message.includes('tally.tsv pins') || (error as Error).message.includes('has no row') };
  }
};

describe('Rust parity tally pin', () => {
  test('a file at its pin passes quietly; fewer equal or more stopped fails', () => {
    expect([
      outcome(() => checkRustTally(FILE, tally(14, 2), 16, pins, {})),
      outcome(() => checkRustTally(FILE, tally(13, 3), 16, pins, {})),
      outcome(() => checkRustTally(FILE, tally(13, 2, { diverged: 1 }), 16, pins, {})),
      outcome(() => checkRustTally(FILE, tally(14, 3), 17, pins, {})),
    ]).toEqual([{ value: null }, { threw: true }, { threw: true }, { threw: true }]);
  });

  test('a file that does better passes and prints the counts to pin', () => {
    const line = checkRustTally(FILE, tally(15, 1), 16, pins, {});
    expect(line).toContain(`${FILE} 15 1`);
  });

  test('an incomplete run (a filter or a failed case) is not checked, and a file with no pin fails', () => {
    expect([
      outcome(() => checkRustTally(FILE, tally(3, 0), 16, pins, {})),
      outcome(() => checkRustTally('test/engine-parity/new.test.ts', tally(1, 0), 1, pins, {})),
      outcome(() => checkRustTally(FILE, tally(13, 2, { skipped: 1 }), 16, pins, {})),
    ]).toEqual([{ value: null }, { threw: true }, { threw: true }]);
  });

  test('a Rust-arm file outside test/engine-parity/ (no parity file name) is not checked', () => {
    // doctor-catalog-probes.test.ts runs the parity harness from test/; the harness finds no parity file name for it.
    expect(outcome(() => checkRustTally('', tally(8, 0), 8, pins, {}))).toEqual({ value: null });
  });

  test('a stop reason round-trips, and a regenerate keeps it only while the file still has stopped cases', () => {
    const earlier = parsePins(renderPins([[FILE, { equal: 14, stopped: 2, reason: 'by design' }], ['test/engine-parity/other.test.ts', { equal: 3, stopped: 1, reason: 'gone' }]]));
    expect(earlier.get(FILE)).toEqual({ equal: 14, stopped: 2, reason: 'by design' });
    const fresh = new Map([[FILE, { equal: 15, stopped: 1 }], ['test/engine-parity/other.test.ts', { equal: 4, stopped: 0 }]]);
    expect(Object.fromEntries(keepStopReasons(fresh, earlier))).toEqual({
      [FILE]: { equal: 15, stopped: 1, reason: 'by design' }, 'test/engine-parity/other.test.ts': { equal: 4, stopped: 0 },
    });
  });

  test('the lifted-hold mode (GBRAIN_TEST_RUST_MANAGED=1) checks and names its own pin file', () => {
    expect([tallyTarget({}).path, tallyTarget({ GBRAIN_TEST_RUST_MANAGED: '1' }).path]).toEqual([RUST_TALLY_PATH, RUST_MANAGED_TALLY_PATH]);
    const managed = { GBRAIN_TEST_RUST_MANAGED: '1' };
    let message = '';
    try { checkRustTally(FILE, tally(13, 3), 16, pins, managed); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('but rust-managed-tally.tsv pins 14 equal and 2 stopped');
    expect(message).toContain('GBRAIN_TEST_RUST_MANAGED=1 bun test/engine-parity/rust-tally.ts --write');
  });

  test.each([['rust-tally.tsv', RUST_TALLY_PATH], ['rust-managed-tally.tsv', RUST_MANAGED_TALLY_PATH]])('the checked-in pin %s has one row per parity file and round-trips', (_name, path) => {
    const text = readFileSync(path, 'utf8');
    const files = readdirSync(join(import.meta.dir, 'engine-parity')).filter((f) => f.endsWith('.test.ts') && f !== 'coverage.test.ts')
      .map((f) => `test/engine-parity/${f}`).sort();
    const pinned = [...parsePins(text).keys()].sort();
    expect({ missing: files.filter((f) => !pinned.includes(f)), stale: pinned.filter((f) => !files.includes(f)) })
      .toEqual({ missing: [], stale: [] });
    expect(renderPins(parsePins(text))).toBe(text);
  });
});
