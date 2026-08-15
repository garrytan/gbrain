/**
 * Tests for src/core/skillpack/nag-state.ts — the brain-pack install nag policy.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  loadNagState,
  saveNagState,
  findNag,
  upsertNag,
  decideNagAction,
  recordNagDisplay,
  DEFAULT_NAG_CEILING,
  type NagEntry,
} from '../src/core/skillpack/nag-state.ts';

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-nag-'));
  statePath = join(dir, 'skillpack-nag-state.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KEY = { brain_id: 'git:repo', source_id: 'host', pack_name: 'deal-brain' };

function entry(over: Partial<NagEntry> = {}): NagEntry {
  return {
    ...KEY,
    pack_version: '0.1.0',
    prompted_at: '2026-06-16T00:00:00Z',
    declined_count: 1,
    suppressed: false,
    ...over,
  };
}

describe('atomic load/save', () => {
  test('round-trips and starts empty on missing file', () => {
    expect(loadNagState({ statePath }).entries).toEqual([]);
    saveNagState(upsertNag(loadNagState({ statePath }), entry()), { statePath });
    expect(existsSync(statePath)).toBe(true);
    expect(loadNagState({ statePath }).entries).toHaveLength(1);
  });

  test('fail-open on corrupt JSON (returns empty, never throws)', () => {
    writeFileSync(statePath, '{ not json');
    expect(loadNagState({ statePath }).entries).toEqual([]);
  });

  test('fail-open on unknown schema version', () => {
    writeFileSync(statePath, JSON.stringify({ schema_version: 'future-v9', entries: [entry()] }));
    expect(loadNagState({ statePath }).entries).toEqual([]);
  });
});

describe('findNag / upsertNag keyed by (brain_id, source_id, pack_name)', () => {
  test('upsert replaces the matching triple only', () => {
    let s = upsertNag(loadNagState({ statePath }), entry({ declined_count: 1 }));
    s = upsertNag(s, entry({ declined_count: 2 }));
    expect(s.entries).toHaveLength(1);
    expect(findNag(s, KEY)?.declined_count).toBe(2);
    s = upsertNag(s, entry({ source_id: 'other', declined_count: 5 }));
    expect(s.entries).toHaveLength(2);
  });
});

describe('decideNagAction policy matrix', () => {
  test('no entry → full/first', () => {
    expect(decideNagAction(undefined, { pack_version: '0.1.0' })).toEqual({
      show: true,
      level: 'full',
      reason: 'first',
    });
  });

  test('--no-skill-nag → hidden', () => {
    expect(decideNagAction(entry(), { pack_version: '0.1.0', noNagFlag: true }).show).toBe(false);
  });

  test('same version, under ceiling → short reminder', () => {
    expect(decideNagAction(entry({ declined_count: 1 }), { pack_version: '0.1.0' })).toEqual({
      show: true,
      level: 'short',
      reason: 'reminder',
    });
  });

  test('ceiling reached → hidden', () => {
    expect(
      decideNagAction(entry({ declined_count: DEFAULT_NAG_CEILING }), { pack_version: '0.1.0' }).show,
    ).toBe(false);
  });

  test('suppressed flag → hidden', () => {
    expect(decideNagAction(entry({ suppressed: true }), { pack_version: '0.1.0' }).show).toBe(false);
  });

  test('version bump while uninstalled → full/version_bump even past ceiling', () => {
    expect(
      decideNagAction(entry({ declined_count: 9, suppressed: true }), { pack_version: '0.2.0' }),
    ).toEqual({ show: true, level: 'full', reason: 'version_bump' });
  });
});

describe('recordNagDisplay', () => {
  test('increments on same version and suppresses at ceiling', () => {
    const e1 = recordNagDisplay(undefined, KEY, { pack_version: '0.1.0', nowIso: 'now' });
    expect(e1.declined_count).toBe(1);
    const e2 = recordNagDisplay(e1, KEY, { pack_version: '0.1.0', nowIso: 'now' });
    const e3 = recordNagDisplay(e2, KEY, { pack_version: '0.1.0', nowIso: 'now' });
    expect(e3.declined_count).toBe(DEFAULT_NAG_CEILING);
    expect(e3.suppressed).toBe(true);
  });

  test('version bump resets count to 1 and clears suppression', () => {
    const bumped = recordNagDisplay(
      entry({ declined_count: 5, suppressed: true }),
      KEY,
      { pack_version: '0.2.0', nowIso: 'now' },
    );
    expect(bumped.declined_count).toBe(1);
    expect(bumped.suppressed).toBe(false);
  });
});
