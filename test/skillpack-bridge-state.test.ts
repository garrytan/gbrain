/**
 * bridge-state.ts — the harness-bridge install ledger.
 *
 * Written-only ownership with install-time hashes, (harness, dest) keying,
 * fail-open load (state loss degrades the lens, never blocks), atomic
 * .tmp+rename writes.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  SKILLPACK_BRIDGE_SCHEMA_VERSION,
  BridgeStateError,
  loadBridgeState,
  saveBridgeState,
  findBridgeEntry,
  recordBridgeWrites,
  removeBridgeSlugs,
} from '../src/core/skillpack/bridge-state.ts';

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gb-bridge-state-'));
  cleanups.push(dir);
  return join(dir, 'skillpack-bridge-state.json');
}

const KEY = {
  harness: 'claude-code',
  dest: '/tmp/fake-skills',
  persona: 'coding-agent',
  mode: 'full' as const,
  gbrainVersion: '0.0.0-test',
  nowIso: '2026-08-16T00:00:00Z',
};

describe('load/save', () => {
  test('missing file → empty state', () => {
    const state = loadBridgeState({ statePath: tmpState() });
    expect(state.schema_version).toBe(SKILLPACK_BRIDGE_SCHEMA_VERSION);
    expect(state.entries).toEqual([]);
  });

  test('round-trip; atomic write leaves no .tmp behind', () => {
    const path = tmpState();
    const next = recordBridgeWrites(loadBridgeState({ statePath: path }), KEY, [
      { slug: 'alpha', mode: 'full', files: { 'alpha/SKILL.md': 'abc123' } },
    ]);
    saveBridgeState(next, { statePath: path });
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(join(path, '..')).filter(f => f.endsWith('.tmp'))).toEqual([]);
    const loaded = loadBridgeState({ statePath: path });
    expect(findBridgeEntry(loaded, KEY)?.written.alpha.files['alpha/SKILL.md']).toBe('abc123');
  });

  test('fail-open: corrupt JSON and unknown schema both load as empty', () => {
    const path = tmpState();
    writeFileSync(path, '{not json');
    expect(loadBridgeState({ statePath: path }).entries).toEqual([]);
    writeFileSync(path, JSON.stringify({ schema_version: 'gbrain-skillpack-bridge-v999', entries: [{}] }));
    expect(loadBridgeState({ statePath: path }).entries).toEqual([]);
  });
});

describe('recordBridgeWrites', () => {
  test('additive union across runs; hash updates on re-write; last_* track the latest run', () => {
    let state = loadBridgeState({ statePath: tmpState() });
    state = recordBridgeWrites(state, KEY, [
      { slug: 'alpha', mode: 'full', files: { 'alpha/SKILL.md': 'h1', 'alpha/aux.md': 'h2' } },
    ]);
    state = recordBridgeWrites(
      state,
      { ...KEY, persona: null, mode: 'stub' },
      [
        { slug: 'beta', mode: 'stub', files: { 'beta/SKILL.md': 'h3' } },
        { slug: 'alpha', mode: 'stub', files: { 'alpha/SKILL.md': 'h1-new' } },
      ],
    );
    const entry = findBridgeEntry(state, KEY)!;
    expect(Object.keys(entry.written).sort()).toEqual(['alpha', 'beta']);
    expect(entry.written.alpha.files['alpha/SKILL.md']).toBe('h1-new'); // updated
    expect(entry.written.alpha.files['alpha/aux.md']).toBe('h2'); // preserved
    expect(entry.written.alpha.mode).toBe('stub');
    expect(entry.last_persona).toBeNull();
    expect(entry.last_mode).toBe('stub');
    expect(state.entries).toHaveLength(1); // same (harness, dest) upserts
  });

  test('distinct (harness, dest) pairs are independent entries', () => {
    let state = loadBridgeState({ statePath: tmpState() });
    state = recordBridgeWrites(state, KEY, [{ slug: 'alpha', mode: 'full', files: { a: 'h' } }]);
    state = recordBridgeWrites(state, { ...KEY, dest: '/tmp/other' }, [{ slug: 'beta', mode: 'full', files: { b: 'h' } }]);
    expect(state.entries).toHaveLength(2);
  });
});

describe('removeBridgeSlugs', () => {
  test('drops slugs; the entry itself goes once its ledger empties', () => {
    let state = loadBridgeState({ statePath: tmpState() });
    state = recordBridgeWrites(state, KEY, [
      { slug: 'alpha', mode: 'full', files: { a: 'h' } },
      { slug: 'beta', mode: 'full', files: { b: 'h' } },
    ]);
    state = removeBridgeSlugs(state, { ...KEY }, ['alpha']);
    expect(Object.keys(findBridgeEntry(state, KEY)!.written)).toEqual(['beta']);
    state = removeBridgeSlugs(state, { ...KEY }, ['beta']);
    expect(findBridgeEntry(state, KEY)).toBeUndefined();
    expect(state.entries).toEqual([]);
  });
});

describe('per-entry fail-open (shape-corrupt entries degrade, never crash)', () => {
  test('entries with the right schema but wrong shape are dropped on load', () => {
    const path = tmpState();
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION,
        entries: [
          {}, // no harness/dest/written
          { harness: 'claude-code', dest: '/x' }, // missing written
          { harness: 'claude-code', dest: '/y', written: [] }, // written not an object
          { harness: 'claude-code', dest: '/z', written: { alpha: { mode: 'full' } } }, // record missing files
          { harness: 'claude-code', dest: '/ok', written: { alpha: { mode: 'full', files: { a: 'h' } } }, last_persona: null, last_mode: 'full', gbrain_version: 'v', installed_at: 't', updated_at: 't' },
        ],
      }),
    );
    const state = loadBridgeState({ statePath: path });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].dest).toBe('/ok');
    // The status-lens shape access that crashed on corrupt entries:
    for (const e of state.entries) expect(() => Object.keys(e.written)).not.toThrow();
  });

  test('a failed atomic write throws BridgeStateError and leaves no .tmp behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-bridge-state-'));
    cleanups.push(dir);
    // Parent "directory" is a FILE → mkdir/rename must fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const path = join(blocker, 'state.json');
    expect(() =>
      saveBridgeState({ schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION, entries: [] }, { statePath: path }),
    ).toThrow(BridgeStateError);
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});
