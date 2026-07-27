/**
 * SkillOpt rejected-buffer unit tests. Uses tempdir for fs ops.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  REJECTED_BUFFER_CAP,
  isRejected,
  loadRejectedBuffer,
  makeRejectedEntry,
  rejectedFilePath,
  rejectedKey,
  saveRejectedBuffer,
} from '../../src/core/skillopt/rejected-buffer.ts';
import type { EditOp } from '../../src/core/skillopt/types.ts';

let tmpDir: string;
const SKILL = 'test-skill';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-rejected-'));
  fs.mkdirSync(path.join(tmpDir, SKILL), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('rejectedKey', () => {
  test('same skill+edits produce same key (state-aware dedup)', () => {
    const text = 'skill text v1';
    const edits: EditOp[] = [{ op: 'add', anchor: '## X', content: 'hello' }];
    expect(rejectedKey(text, edits)).toBe(rejectedKey(text, edits));
  });

  test('different skill text → different key', () => {
    const edits: EditOp[] = [{ op: 'add', anchor: '## X', content: 'hello' }];
    expect(rejectedKey('v1', edits)).not.toBe(rejectedKey('v2', edits));
  });

  test('different edits → different key', () => {
    const text = 'v1';
    expect(rejectedKey(text, [{ op: 'add', anchor: 'A', content: '1' }]))
      .not.toBe(rejectedKey(text, [{ op: 'add', anchor: 'B', content: '1' }]));
  });
});

describe('loadRejectedBuffer + saveRejectedBuffer', () => {
  test('empty when file missing', () => {
    expect(loadRejectedBuffer(tmpDir, SKILL)).toEqual([]);
  });

  test('round-trips a single entry', () => {
    const entry = makeRejectedEntry('v1', [{ op: 'add', anchor: 'A', content: 'x' }], 'validation_gate_rejected');
    saveRejectedBuffer(tmpDir, SKILL, [entry]);
    const loaded = loadRejectedBuffer(tmpDir, SKILL);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.key).toBe(entry.key);
    expect(loaded[0]!.reason).toBe('validation_gate_rejected');
  });

  test('LRU cap evicts oldest entries beyond REJECTED_BUFFER_CAP', () => {
    const entries = [];
    for (let i = 0; i < REJECTED_BUFFER_CAP + 20; i++) {
      const e = makeRejectedEntry(`v${i}`, [{ op: 'add', anchor: 'A', content: String(i) }], 'reason');
      // Stagger timestamps so newer entries win the LRU sort.
      e.ts = new Date(2026, 0, 1, 0, 0, i).toISOString();
      entries.push(e);
    }
    saveRejectedBuffer(tmpDir, SKILL, entries);
    const loaded = loadRejectedBuffer(tmpDir, SKILL);
    expect(loaded).toHaveLength(REJECTED_BUFFER_CAP);
    // Newest entry (highest i) must be preserved.
    const newestKey = entries[entries.length - 1]!.key;
    expect(loaded.some((e) => e.key === newestKey)).toBe(true);
  });

  test('isRejected detects an exact key match', () => {
    const edits: EditOp[] = [{ op: 'add', anchor: 'A', content: 'x' }];
    const entry = makeRejectedEntry('v1', edits, 'r');
    saveRejectedBuffer(tmpDir, SKILL, [entry]);
    const buf = loadRejectedBuffer(tmpDir, SKILL);
    expect(isRejected(buf, 'v1', edits)).toBe(true);
    expect(isRejected(buf, 'different skill text', edits)).toBe(false);
  });
});

describe('rejectedFilePath', () => {
  test('returns canonical path', () => {
    const p = rejectedFilePath(tmpDir, 'foo');
    expect(p).toBe(path.join(tmpDir, 'foo', 'skillopt', 'rejected.json'));
  });
});
