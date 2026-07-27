/**
 * Adversarial: simulated crash between SKILL.md write and history commit.
 *
 * D8 history-intent-first ordering means a crash mid-sequence is recoverable.
 * Tests stage a pending row + a snapshot, then verify revertAllPending
 * cleans up correctly without losing prior committed state.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acceptCandidate,
  bestPath,
  historyPath,
  loadHistory,
  revertAllPending,
  skillPath,
  versionsDir,
} from '../../../src/core/skillopt/version-store.ts';

const SKILL = 'crash-target';
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-crash-'));
  fs.mkdirSync(path.join(tmpDir, SKILL), { recursive: true });
  fs.writeFileSync(skillPath(tmpDir, SKILL), '---\nname: x\n---\nbaseline\n');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('adversarial: partial-write crash recovery', () => {
  test('crash after history-pending but before snapshot: revert removes pending', () => {
    fs.mkdirSync(versionsDir(tmpDir, SKILL), { recursive: true });
    fs.writeFileSync(
      historyPath(tmpDir, SKILL),
      JSON.stringify({
        schema: 1,
        rows: [{
          status: 'pending',
          run_id: 'crashed',
          version_n: 1,
          ts: '2026-05-27T12:00:00Z',
          edits: [],
          sel_score: 0.5,
          delta: 0.1,
        }],
      }),
    );
    // No snapshot, no best.md, no SKILL.md change.
    const reverted = revertAllPending(tmpDir, SKILL);
    expect(reverted).toBe(1);
    expect(loadHistory(tmpDir, SKILL)).toEqual([]);
    // SKILL.md is untouched.
    expect(fs.readFileSync(skillPath(tmpDir, SKILL), 'utf8')).toContain('baseline');
  });

  test('crash after snapshot but before best.md write: revert deletes snapshot', () => {
    fs.mkdirSync(versionsDir(tmpDir, SKILL), { recursive: true });
    const snap = path.join(versionsDir(tmpDir, SKILL), 'v0001_e1_s1.md');
    fs.writeFileSync(snap, 'pending candidate');
    fs.writeFileSync(
      historyPath(tmpDir, SKILL),
      JSON.stringify({
        schema: 1,
        rows: [{ status: 'pending', run_id: 'crashed', version_n: 1, ts: '2026-05-27T12:00:00Z', edits: [], sel_score: 0.5, delta: 0.1 }],
      }),
    );
    revertAllPending(tmpDir, SKILL);
    expect(fs.existsSync(snap)).toBe(false);
  });

  test('crash AFTER full success: revert is a no-op', () => {
    // Use the real acceptCandidate path so the trio (history committed,
    // snapshot, SKILL.md, best.md) is all present + consistent.
    const candidate = '---\nname: x\n---\nimproved\n';
    acceptCandidate({
      skillsDir: tmpDir, skillName: SKILL, runId: 'good', epoch: 1, step: 1,
      edits: [], candidateText: candidate, selScore: 0.7, delta: 0.2,
    });
    const reverted = revertAllPending(tmpDir, SKILL);
    expect(reverted).toBe(0);
    expect(loadHistory(tmpDir, SKILL)).toHaveLength(1);
    expect(fs.readFileSync(skillPath(tmpDir, SKILL), 'utf8')).toBe(candidate);
  });

  test('crash recovery preserves the prior committed version in best.md', () => {
    // Step 1: a clean accept.
    const v1 = '---\nname: x\n---\nclean v1\n';
    acceptCandidate({
      skillsDir: tmpDir, skillName: SKILL, runId: 'good', epoch: 1, step: 1,
      edits: [], candidateText: v1, selScore: 0.5, delta: 0.5,
    });
    // Step 2: stage a pending v2 from a crashed run.
    const snap2 = path.join(versionsDir(tmpDir, SKILL), 'v0002_e1_s2.md');
    fs.writeFileSync(snap2, 'corrupted pending');
    fs.writeFileSync(bestPath(tmpDir, SKILL), 'corrupted pending');
    const history = loadHistory(tmpDir, SKILL);
    history.push({
      status: 'pending', run_id: 'crashed', version_n: 2,
      ts: '2026-05-27T13:00:00Z', edits: [], sel_score: 0.6, delta: 0.1,
    });
    fs.writeFileSync(historyPath(tmpDir, SKILL), JSON.stringify({ schema: 1, rows: history }));
    // Revert.
    revertAllPending(tmpDir, SKILL);
    // best.md restored to v1.
    expect(fs.readFileSync(bestPath(tmpDir, SKILL), 'utf8')).toBe(v1);
    // Snapshot v0002_* gone.
    expect(fs.existsSync(snap2)).toBe(false);
    // History has only the committed v1 row.
    const final = loadHistory(tmpDir, SKILL);
    expect(final).toHaveLength(1);
    expect(final[0]!.status).toBe('committed');
    expect(final[0]!.version_n).toBe(1);
  });

  test('multiple pending rows revert in one pass', () => {
    fs.mkdirSync(versionsDir(tmpDir, SKILL), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(tmpDir, SKILL), 'v0001_e1_s1.md'), 'p1');
    fs.writeFileSync(path.join(versionsDir(tmpDir, SKILL), 'v0002_e1_s2.md'), 'p2');
    fs.writeFileSync(path.join(versionsDir(tmpDir, SKILL), 'v0003_e2_s1.md'), 'p3');
    fs.writeFileSync(
      historyPath(tmpDir, SKILL),
      JSON.stringify({
        schema: 1,
        rows: [
          { status: 'pending', run_id: 'a', version_n: 1, ts: '2026-05-27T11:00:00Z', edits: [], sel_score: 0.4, delta: 0.1 },
          { status: 'pending', run_id: 'a', version_n: 2, ts: '2026-05-27T12:00:00Z', edits: [], sel_score: 0.4, delta: 0.1 },
          { status: 'pending', run_id: 'a', version_n: 3, ts: '2026-05-27T13:00:00Z', edits: [], sel_score: 0.4, delta: 0.1 },
        ],
      }),
    );
    const reverted = revertAllPending(tmpDir, SKILL);
    expect(reverted).toBe(3);
    expect(loadHistory(tmpDir, SKILL)).toEqual([]);
    expect(fs.readdirSync(versionsDir(tmpDir, SKILL))).toEqual([]);
  });
});
