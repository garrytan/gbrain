/**
 * v0.37.x — doctor --remediate checkpoint round-trip (A4 amended).
 *
 * Pins:
 *   - computePlanHash is deterministic + invariant to id-array sort order.
 *   - saveRemediationCheckpoint atomic via .tmp + rename.
 *   - loadRemediationCheckpoint returns null on missing file + schema
 *     mismatch.
 *   - listRemediationCheckpoints is mtime-ordered.
 *   - clearRemediationCheckpoint is idempotent on missing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computePlanHash,
  saveRemediationCheckpoint,
  loadRemediationCheckpoint,
  listRemediationCheckpoints,
  clearRemediationCheckpoint,
  checkpointPath,
  type RemediationCheckpoint,
} from '../../src/core/remediation-checkpoint.ts';

let homeBackup: string | undefined;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-remediate-cp-'));
  homeBackup = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = homeBackup;
  rmSync(tmp, { recursive: true, force: true });
});

function makeCheckpoint(planHash: string, completed: Array<{ id: string; status: string }> = []): RemediationCheckpoint {
  return {
    schema_version: 1,
    plan_hash: planHash,
    doctor_run_id: 'test-run-id',
    target_score: 90,
    started_at: new Date().toISOString(),
    completed: completed.map((c) => ({ id: c.id, job: '', status: c.status })),
    aborted_at: new Date().toISOString(),
    abort_reason: 'budget_exhausted',
    budget_snapshot: { spent: 0.42, cap: 0.10, reason: 'cost' },
  };
}

describe('computePlanHash', () => {
  test('deterministic for the same id set', () => {
    expect(computePlanHash(['a', 'b', 'c'])).toBe(computePlanHash(['a', 'b', 'c']));
  });

  test('invariant to input array order', () => {
    expect(computePlanHash(['a', 'b', 'c'])).toBe(computePlanHash(['c', 'a', 'b']));
  });

  test('differs across different id sets', () => {
    expect(computePlanHash(['a', 'b'])).not.toBe(computePlanHash(['a', 'b', 'c']));
  });

  test('produces a stable 16-char hex prefix', () => {
    const h = computePlanHash(['a']);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('save + load round-trip', () => {
  test('preserves every field including budget_snapshot', () => {
    const cp = makeCheckpoint('deadbeefcafe1234', [
      { id: 'sync', status: 'completed' },
      { id: 'embed', status: 'completed' },
    ]);
    saveRemediationCheckpoint(cp);

    const loaded = loadRemediationCheckpoint(cp.plan_hash);
    expect(loaded).not.toBeNull();
    expect(loaded!.plan_hash).toBe(cp.plan_hash);
    expect(loaded!.completed.length).toBe(2);
    expect(loaded!.completed[0].id).toBe('sync');
    expect(loaded!.budget_snapshot?.spent).toBe(0.42);
  });

  test('atomic write via .tmp + rename: no .tmp left behind on success', () => {
    const cp = makeCheckpoint('atomicrenametest');
    saveRemediationCheckpoint(cp);
    const finalPath = checkpointPath(cp.plan_hash);
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(`${finalPath}.tmp`)).toBe(false);
  });

  test('loadRemediationCheckpoint returns null on missing file', () => {
    expect(loadRemediationCheckpoint('not_a_real_hash')).toBeNull();
  });

  test('loadRemediationCheckpoint returns null on schema mismatch', () => {
    const cp = makeCheckpoint('schemamismatchhash');
    saveRemediationCheckpoint(cp);
    // Corrupt the schema_version
    const path = checkpointPath(cp.plan_hash);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    raw.schema_version = 99;
    writeFileSync(path, JSON.stringify(raw));
    expect(loadRemediationCheckpoint(cp.plan_hash)).toBeNull();
  });

  test('loadRemediationCheckpoint returns null on corrupt JSON', () => {
    const cp = makeCheckpoint('corruptjsonhash');
    saveRemediationCheckpoint(cp);
    writeFileSync(checkpointPath(cp.plan_hash), '{not json}');
    expect(loadRemediationCheckpoint(cp.plan_hash)).toBeNull();
  });
});

describe('listRemediationCheckpoints', () => {
  test('returns empty array when dir missing', () => {
    expect(listRemediationCheckpoints()).toEqual([]);
  });

  test('lists checkpoints mtime-newest-first', async () => {
    const cp1 = makeCheckpoint('hash000000000001');
    saveRemediationCheckpoint(cp1);
    await new Promise((r) => setTimeout(r, 20));
    const cp2 = makeCheckpoint('hash000000000002');
    saveRemediationCheckpoint(cp2);

    const list = listRemediationCheckpoints();
    expect(list.length).toBe(2);
    // Newer first
    expect(list[0].plan_hash).toBe('hash000000000002');
    expect(list[1].plan_hash).toBe('hash000000000001');
  });
});

describe('clearRemediationCheckpoint', () => {
  test('removes file when present', () => {
    const cp = makeCheckpoint('cleartesthash000');
    saveRemediationCheckpoint(cp);
    expect(existsSync(checkpointPath(cp.plan_hash))).toBe(true);
    clearRemediationCheckpoint(cp.plan_hash);
    expect(existsSync(checkpointPath(cp.plan_hash))).toBe(false);
  });

  test('idempotent on missing file', () => {
    expect(() => clearRemediationCheckpoint('never_written')).not.toThrow();
  });
});
