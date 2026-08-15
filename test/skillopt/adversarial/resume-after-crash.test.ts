/**
 * Adversarial: full crash-replay scenario.
 *
 * Steps:
 *  1. Start a run, accept step 1 (commits v1).
 *  2. Stage a pending v2 (simulates crash after history pending but before commit).
 *  3. Load checkpoint + revert pending; verify v1 best is restored.
 *  4. Resume the run with the same run_id; checkpoint resumes from
 *     last_completed=1 and best_skill_text is the committed v1.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deleteCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type RunCheckpoint,
} from '../../../src/core/skillopt/checkpoint.ts';
import {
  acceptCandidate,
  bestPath,
  historyPath,
  loadHistory,
  revertAllPending,
  skillPath,
  versionsDir,
} from '../../../src/core/skillopt/version-store.ts';

const SKILL = 'resume-target';
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-resume-'));
  fs.mkdirSync(path.join(tmpDir, SKILL), { recursive: true });
  fs.writeFileSync(skillPath(tmpDir, SKILL), '---\nname: x\n---\nbaseline body\n');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('adversarial: full crash + resume', () => {
  test('crash after v1 accept, mid v2 attempt: resume restores v1, drops v2 pending', () => {
    // Step 1: accept v1 cleanly.
    const v1 = '---\nname: x\n---\nv1 body\n';
    acceptCandidate({
      skillsDir: tmpDir, skillName: SKILL, runId: 'run-A', epoch: 1, step: 1,
      edits: [], candidateText: v1, selScore: 0.6, delta: 0.6,
    });

    // Save a checkpoint reflecting v1 as best.
    const cp: RunCheckpoint = {
      schema: 1,
      run_id: 'run-A',
      skill: SKILL,
      skill_sha8: 'abcd1234',
      benchmark_sha8: 'deadbeef',
      optimizer_model: 'anthropic:claude-opus-4-7',
      target_model: 'anthropic:claude-sonnet-4-6',
      judge_model: 'anthropic:claude-sonnet-4-6',
      epochs: 4,
      batch_size: 8,
      lr: 4,
      lr_schedule: 'cosine',
      best_sel_score: 0.6,
      best_skill_text: v1,
      last_completed_epoch: 1,
      last_completed_step: 1,
      cumulative_cost_usd: 0.42,
      started_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
    };
    saveCheckpoint(tmpDir, SKILL, cp);

    // Step 2: stage a pending v2 (simulates crash).
    fs.mkdirSync(versionsDir(tmpDir, SKILL), { recursive: true });
    fs.writeFileSync(path.join(versionsDir(tmpDir, SKILL), 'v0002_e1_s2.md'), 'v2 candidate that crashed');
    fs.writeFileSync(bestPath(tmpDir, SKILL), 'v2 candidate that crashed'); // best clobbered
    const history = loadHistory(tmpDir, SKILL);
    history.push({
      status: 'pending', run_id: 'run-A', version_n: 2,
      ts: '2026-05-27T13:00:00Z', edits: [], sel_score: 0.65, delta: 0.05,
    });
    fs.writeFileSync(historyPath(tmpDir, SKILL), JSON.stringify({ schema: 1, rows: history }));

    // Step 3: resume — call revertAllPending (what runOptimizationLoop does).
    const reverted = revertAllPending(tmpDir, SKILL);
    expect(reverted).toBe(1);

    // best.md restored to v1 (since v1 is the prior committed).
    expect(fs.readFileSync(bestPath(tmpDir, SKILL), 'utf8')).toBe(v1);

    // History has only the committed v1 row.
    const final = loadHistory(tmpDir, SKILL);
    expect(final).toHaveLength(1);
    expect(final[0]!.status).toBe('committed');
    expect(final[0]!.version_n).toBe(1);

    // Checkpoint still loadable (un-touched by revert).
    const reloaded = loadCheckpoint(tmpDir, SKILL, 'run-A');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.best_sel_score).toBe(0.6);
    expect(reloaded!.best_skill_text).toBe(v1);
    expect(reloaded!.last_completed_step).toBe(1); // resume from here
  });

  test('checkpoint deleteCheckpoint is idempotent (re-delete is no-op)', () => {
    const cp: RunCheckpoint = {
      schema: 1,
      run_id: 'run-X',
      skill: SKILL,
      skill_sha8: 'a', benchmark_sha8: 'b',
      optimizer_model: 'o', target_model: 't', judge_model: 'j',
      epochs: 1, batch_size: 1, lr: 1, lr_schedule: 'cosine',
      best_sel_score: 0, best_skill_text: '',
      last_completed_epoch: 0, last_completed_step: 0,
      cumulative_cost_usd: 0,
      started_at: '2026-05-27T12:00:00Z',
      last_updated_at: '2026-05-27T12:00:00Z',
    };
    saveCheckpoint(tmpDir, SKILL, cp);
    deleteCheckpoint(tmpDir, SKILL, 'run-X');
    // Second call should not throw.
    expect(() => deleteCheckpoint(tmpDir, SKILL, 'run-X')).not.toThrow();
    expect(loadCheckpoint(tmpDir, SKILL, 'run-X')).toBeNull();
  });

  test('checkpoint with non-matching schema returns null (treat as fresh)', () => {
    const dir = path.join(tmpDir, SKILL, 'skillopt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'checkpoint-bad.json'),
      JSON.stringify({ schema: 999, run_id: 'bad' }),
    );
    expect(loadCheckpoint(tmpDir, SKILL, 'bad')).toBeNull();
  });

  test('checkpoint with malformed JSON returns null + stderr warn (caller starts fresh)', () => {
    const dir = path.join(tmpDir, SKILL, 'skillopt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'checkpoint-bad.json'), '{ this is not json');
    expect(loadCheckpoint(tmpDir, SKILL, 'bad')).toBeNull();
  });
});
