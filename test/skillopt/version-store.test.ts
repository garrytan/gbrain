/**
 * SkillOpt version-store tests. Covers D8 history-intent-first ordering
 * and crash-recovery via revertAllPending.
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
} from '../../src/core/skillopt/version-store.ts';

let tmpDir: string;
const SKILL = 'test-skill';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-versions-'));
  // Seed a baseline SKILL.md so atomic writes have a real file.
  fs.mkdirSync(path.join(tmpDir, SKILL), { recursive: true });
  fs.writeFileSync(skillPath(tmpDir, SKILL), '---\nname: test\n---\nbaseline body\n');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('acceptCandidate (D8 two-phase commit)', () => {
  test('writes 4 files in order + flips history to committed', () => {
    const candidate = '---\nname: test\n---\nimproved body\n';
    const r = acceptCandidate({
      skillsDir: tmpDir,
      skillName: SKILL,
      runId: 'run-1',
      epoch: 1,
      step: 1,
      edits: [{ op: 'replace', target: 'baseline', replacement: 'improved' }],
      candidateText: candidate,
      selScore: 0.85,
      delta: 0.10,
    });

    expect(r.versionN).toBe(1);
    // SKILL.md replaced.
    expect(fs.readFileSync(skillPath(tmpDir, SKILL), 'utf8')).toBe(candidate);
    // best.md is a pointer copy.
    expect(fs.readFileSync(bestPath(tmpDir, SKILL), 'utf8')).toBe(candidate);
    // versions/v0001_e1_s1.md is a snapshot.
    expect(fs.existsSync(r.versionFilePath)).toBe(true);
    expect(fs.readFileSync(r.versionFilePath, 'utf8')).toBe(candidate);
    // history.json has a committed row.
    const hist = loadHistory(tmpDir, SKILL);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.status).toBe('committed');
    expect(hist[0]!.version_n).toBe(1);
    expect(hist[0]!.sel_score).toBe(0.85);
  });

  test('version_n increments across runs', () => {
    const c1 = '---\nname: test\n---\nv1\n';
    const c2 = '---\nname: test\n---\nv2\n';
    const r1 = acceptCandidate({
      skillsDir: tmpDir, skillName: SKILL, runId: 'a', epoch: 1, step: 1,
      edits: [], candidateText: c1, selScore: 0.5, delta: 0.5,
    });
    const r2 = acceptCandidate({
      skillsDir: tmpDir, skillName: SKILL, runId: 'b', epoch: 1, step: 1,
      edits: [], candidateText: c2, selScore: 0.6, delta: 0.1,
    });
    expect(r1.versionN).toBe(1);
    expect(r2.versionN).toBe(2);
    expect(loadHistory(tmpDir, SKILL)).toHaveLength(2);
  });
});

describe('revertAllPending (D8 crash recovery)', () => {
  test('no-op when no pending rows', () => {
    const reverted = revertAllPending(tmpDir, SKILL);
    expect(reverted).toBe(0);
  });

  test('cleans up a pending row left behind by a simulated crash', () => {
    // Simulate: history has a pending row; snapshot exists; best.md points
    // at the pending text; SKILL.md still has the baseline (the commit step
    // never ran). This is the EXACT crash scenario D8 guards against.
    fs.mkdirSync(versionsDir(tmpDir, SKILL), { recursive: true });
    const snapPath = path.join(versionsDir(tmpDir, SKILL), 'v0001_e1_s1.md');
    fs.writeFileSync(snapPath, 'pending body that never committed');
    fs.writeFileSync(bestPath(tmpDir, SKILL), 'pending body that never committed');
    fs.writeFileSync(
      historyPath(tmpDir, SKILL),
      JSON.stringify({
        schema: 1,
        rows: [{
          status: 'pending',
          run_id: 'crashed-run',
          version_n: 1,
          ts: '2026-05-27T12:00:00Z',
          edits: [],
          sel_score: 0.4,
          delta: 0.1,
        }],
      }, null, 2),
    );

    const reverted = revertAllPending(tmpDir, SKILL);
    expect(reverted).toBe(1);
    // Snapshot removed.
    expect(fs.existsSync(snapPath)).toBe(false);
    // best.md removed (no prior committed version to restore from).
    expect(fs.existsSync(bestPath(tmpDir, SKILL))).toBe(false);
    // History row gone.
    expect(loadHistory(tmpDir, SKILL)).toEqual([]);
    // SKILL.md untouched (still baseline).
    expect(fs.readFileSync(skillPath(tmpDir, SKILL), 'utf8')).toContain('baseline body');
  });

  test('restores best.md from prior committed version on revert', () => {
    // First commit a clean version.
    const v1 = '---\nname: test\n---\nclean version\n';
    acceptCandidate({
      skillsDir: tmpDir, skillName: SKILL, runId: 'good', epoch: 1, step: 1,
      edits: [], candidateText: v1, selScore: 0.5, delta: 0.5,
    });
    // Then simulate a pending row from a later crashed run.
    const snapPath = path.join(versionsDir(tmpDir, SKILL), 'v0002_e1_s1.md');
    fs.writeFileSync(snapPath, 'corrupted pending');
    fs.writeFileSync(bestPath(tmpDir, SKILL), 'corrupted pending');
    const history = loadHistory(tmpDir, SKILL);
    history.push({
      status: 'pending', run_id: 'crashed', version_n: 2,
      ts: new Date().toISOString(), edits: [], sel_score: 0.6, delta: 0.1,
    });
    fs.writeFileSync(historyPath(tmpDir, SKILL), JSON.stringify({ schema: 1, rows: history }, null, 2));

    revertAllPending(tmpDir, SKILL);

    // best.md should be restored to v1.
    expect(fs.readFileSync(bestPath(tmpDir, SKILL), 'utf8')).toBe(v1);
    // Pending row dropped.
    expect(loadHistory(tmpDir, SKILL).every((r) => r.status === 'committed')).toBe(true);
  });
});
