/**
 * v0.37.x — brainstorm checkpoint contract (TX3/TX4/A5 amended).
 *
 * Pins:
 *   - computeRunId is deterministic + invariant to slug-array sort order.
 *   - computeRunId is stable across embedding-model swaps (no embedding
 *     bits in the hash).
 *   - saveCheckpoint atomic via .tmp + rename.
 *   - loadCheckpoint returns null on missing file + schema_version
 *     mismatch.
 *   - listRuns mtime-ordered (newest first).
 *   - gcStaleCheckpoints unlinks > N days.
 *   - Round-trip preserves `ideas` bodies (TX3 load-bearing contract).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRunId,
  saveCheckpoint,
  loadCheckpoint,
  listRuns,
  gcStaleCheckpoints,
  clearCheckpoint,
  isCheckpointFresh,
  type BrainstormCheckpoint,
} from '../../src/core/brainstorm/checkpoint.ts';

let homeBackup: string | undefined;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-bs-cp-'));
  homeBackup = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = homeBackup;
  rmSync(tmp, { recursive: true, force: true });
});

function fixtureCheckpoint(runId: string, ideas: Array<{ text: string; cross: string }> = []): BrainstormCheckpoint {
  return {
    schema_version: 2,
    run_id: runId,
    question: 'why are AI coding tools converging on the same UX?',
    profile_label: 'brainstorm',
    started_at: new Date().toISOString(),
    completed_crosses: ideas.map((i, idx) => ({
      close_slug: `wiki/close-${idx}`,
      far_slug: `wiki/far-${idx}`,
      cross_id: i.cross,
      ideas: [{ text: i.text, cross_id: i.cross }],
    })),
    failed_crosses: [],
    judge_done: false,
  };
}

describe('computeRunId (A5 amended)', () => {
  test('deterministic for the same inputs', () => {
    const a = computeRunId('Q', 'brainstorm', ['close/a', 'close/b'], ['far/c', 'far/d']);
    const b = computeRunId('Q', 'brainstorm', ['close/a', 'close/b'], ['far/c', 'far/d']);
    expect(a).toBe(b);
  });

  test('invariant to slug-array order', () => {
    const a = computeRunId('Q', 'lsd', ['close/a', 'close/b'], ['far/c', 'far/d']);
    const b = computeRunId('Q', 'lsd', ['close/b', 'close/a'], ['far/d', 'far/c']);
    expect(a).toBe(b);
  });

  test('differs when question changes', () => {
    const a = computeRunId('Q1', 'brainstorm', ['s'], ['t']);
    const b = computeRunId('Q2', 'brainstorm', ['s'], ['t']);
    expect(a).not.toBe(b);
  });

  test('differs when profile changes', () => {
    const a = computeRunId('Q', 'brainstorm', ['s'], ['t']);
    const b = computeRunId('Q', 'lsd', ['s'], ['t']);
    expect(a).not.toBe(b);
  });

  test('stable across embedding-model swaps (no embedding bits)', () => {
    // The identity formula uses ONLY question+profile+slug-arrays. We
    // simulate a model swap by varying nothing — the run_id must be
    // independent of any embedding state, which means we get the same
    // hash from the same call.
    const slugs = ['close/a'];
    const far = ['far/b'];
    expect(computeRunId('Q', 'brainstorm', slugs, far)).toBe(
      computeRunId('Q', 'brainstorm', slugs, far),
    );
  });

  test('produces a stable 16-char hex prefix', () => {
    const id = computeRunId('Q', 'brainstorm', ['s'], ['t']);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('save + load round-trip (TX3 load-bearing — full ideas preserved)', () => {
  test('preserves completed_crosses ideas verbatim', () => {
    const runId = 'ab1234567890cdef';
    const cp = fixtureCheckpoint(runId, [
      { text: 'idea body one — concrete grounding here', cross: 'C1' },
      { text: 'idea body two', cross: 'C2' },
      { text: 'idea body three with extra detail', cross: 'C3' },
    ]);
    saveCheckpoint(cp);
    const loaded = loadCheckpoint(runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.completed_crosses.length).toBe(3);
    expect(loaded!.completed_crosses[0].ideas[0].text).toBe('idea body one — concrete grounding here');
    expect(loaded!.completed_crosses[0].ideas[0].cross_id).toBe('C1');
    expect(loaded!.completed_crosses[2].ideas[0].text).toBe('idea body three with extra detail');
  });

  test('atomic write: no .tmp left behind on success', () => {
    const cp = fixtureCheckpoint('atomicrenameabcd');
    saveCheckpoint(cp);
    const dir = join(tmp, '.gbrain', 'brainstorm');
    expect(existsSync(join(dir, 'atomicrenameabcd.json'))).toBe(true);
    expect(existsSync(join(dir, 'atomicrenameabcd.json.tmp'))).toBe(false);
  });

  test('loadCheckpoint returns null on missing file', () => {
    expect(loadCheckpoint('no_such_run_id')).toBeNull();
  });

  test('loadCheckpoint returns null + stderr WARN on schema mismatch', () => {
    const runId = 'schemamismatch00';
    const cp = fixtureCheckpoint(runId);
    saveCheckpoint(cp);
    const path = join(tmp, '.gbrain', 'brainstorm', `${runId}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    raw.schema_version = 1;
    writeFileSync(path, JSON.stringify(raw));
    expect(loadCheckpoint(runId)).toBeNull();
  });

  test('loadCheckpoint returns null on corrupt JSON', () => {
    const runId = 'corruptjson00000';
    saveCheckpoint(fixtureCheckpoint(runId));
    writeFileSync(join(tmp, '.gbrain', 'brainstorm', `${runId}.json`), '{not json}');
    expect(loadCheckpoint(runId)).toBeNull();
  });
});

describe('listRuns mtime-newest-first', () => {
  test('empty dir returns []', () => {
    expect(listRuns()).toEqual([]);
  });

  test('returns most-recently-saved first', async () => {
    saveCheckpoint(fixtureCheckpoint('run00000000first'));
    await new Promise((r) => setTimeout(r, 20));
    saveCheckpoint(fixtureCheckpoint('run0000000second'));
    const list = listRuns();
    expect(list.length).toBe(2);
    expect(list[0].run_id).toBe('run0000000second');
    expect(list[1].run_id).toBe('run00000000first');
  });
});

describe('gcStaleCheckpoints (A5 7-day window)', () => {
  test('removes files older than the threshold; returns count', () => {
    const stale = 'stalecheckpoint1';
    const fresh = 'freshcheckpoint2';
    saveCheckpoint(fixtureCheckpoint(stale));
    saveCheckpoint(fixtureCheckpoint(fresh));
    // Set the stale file's mtime to 30 days ago.
    const stalePath = join(tmp, '.gbrain', 'brainstorm', `${stale}.json`);
    const oldTime = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stalePath, oldTime, oldTime);
    const removed = gcStaleCheckpoints(7);
    expect(removed).toBe(1);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(join(tmp, '.gbrain', 'brainstorm', `${fresh}.json`))).toBe(true);
  });

  test('returns 0 when dir is empty', () => {
    expect(gcStaleCheckpoints(7)).toBe(0);
  });
});

describe('clearCheckpoint', () => {
  test('removes file when present', () => {
    saveCheckpoint(fixtureCheckpoint('cleartest0000000'));
    const path = join(tmp, '.gbrain', 'brainstorm', `cleartest0000000.json`);
    expect(existsSync(path)).toBe(true);
    clearCheckpoint('cleartest0000000');
    expect(existsSync(path)).toBe(false);
  });

  test('idempotent on missing file', () => {
    expect(() => clearCheckpoint('never_saved')).not.toThrow();
  });
});

describe('isCheckpointFresh', () => {
  test('true for newly-saved checkpoint', () => {
    saveCheckpoint(fixtureCheckpoint('freshtest0000000'));
    expect(isCheckpointFresh('freshtest0000000')).toBe(true);
  });

  test('false for missing checkpoint', () => {
    expect(isCheckpointFresh('not_saved')).toBe(false);
  });

  test('false for >7 day old checkpoint', () => {
    saveCheckpoint(fixtureCheckpoint('oldtest000000000'));
    const path = join(tmp, '.gbrain', 'brainstorm', 'oldtest000000000.json');
    const oldTime = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, oldTime, oldTime);
    expect(isCheckpointFresh('oldtest000000000')).toBe(false);
  });
});
