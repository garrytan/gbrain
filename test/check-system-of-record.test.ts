/**
 * v0.32.2 — check-system-of-record CI gate self-test.
 *
 * Runs scripts/check-system-of-record.sh in two configurations:
 *   - Positive: against the real repo src/ + scripts/ tree. After
 *     commit 9 lands the allow-list comments, the gate must exit 0.
 *   - Negative: against a temporary src/ tree containing a violation
 *     (direct engine.insertFact call without the allow comment).
 *     The gate must exit 1 and the offending file path must appear
 *     in the output.
 *
 * The negative case is the regression guard: if the gate is too
 * permissive (regex misses), this test fails. If the gate is too
 * strict (false-positives the positive case), the positive case
 * fails. Both directions need to hold.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'check-system-of-record.sh');

function runGate(cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT_PATH], { cwd, encoding: 'utf-8', timeout: 30_000 });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('check-system-of-record.sh — positive case (real repo)', () => {
  test('exits 0 on the current repo state (all legitimate sites carry allow-list comments)', () => {
    const repoRoot = join(import.meta.dir, '..');
    const r = runGate(repoRoot);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OK: no direct derived-table writes outside the reconcile layer');
  });
});

describe('check-system-of-record.sh — negative case (synthetic violator)', () => {
  test('exits 1 + names the violator path when a forbidden call appears without the allow comment', () => {
    // Build a synthetic mini-repo with a violating .ts file.
    const fakeRepo = mkdtempSync(join(tmpdir(), 'gate-test-'));
    try {
      // Initialize as a git repo so `git rev-parse --show-toplevel` resolves.
      spawnSync('git', ['init', '-q'], { cwd: fakeRepo });

      // Copy the gate script itself (the script uses relative path src/).
      const fakeScripts = join(fakeRepo, 'scripts');
      mkdirSync(fakeScripts, { recursive: true });
      cpSync(SCRIPT_PATH, join(fakeScripts, 'check-system-of-record.sh'));

      const fakeSrc = join(fakeRepo, 'src');
      mkdirSync(fakeSrc, { recursive: true });
      // Forbidden call — no allow-list comment.
      writeFileSync(
        join(fakeSrc, 'violator.ts'),
        `// A file that breaks the rule.
import type { BrainEngine } from './engine.ts';
async function bad(engine: BrainEngine) {
  await engine.insertFact({ fact: 'I bypass the gate' } as any, { source_id: 'default' });
}
`,
        'utf-8',
      );

      const r = runGate(fakeRepo);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('violator.ts');
      expect(r.stdout).toContain('direct writes to derived tables');
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test('allow-list comment on the SAME LINE makes the gate accept the call', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'gate-test-allow-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: fakeRepo });
      const fakeSrc = join(fakeRepo, 'src');
      mkdirSync(fakeSrc, { recursive: true });
      writeFileSync(
        join(fakeSrc, 'reconciler.ts'),
        `// A legitimate reconciler — explicit allow comment.
import type { BrainEngine } from './engine.ts';
async function reconcile(engine: BrainEngine) {
  await engine.insertFact({ fact: 'ok' } as any, { source_id: 'default' }); // gbrain-allow-direct-insert: this is the canonical reconcile path
}
`,
        'utf-8',
      );

      const r = runGate(fakeRepo);
      expect(r.code).toBe(0);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test('allow-list comment on a DIFFERENT line does NOT exempt the call', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'gate-test-misplaced-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: fakeRepo });
      const fakeSrc = join(fakeRepo, 'src');
      mkdirSync(fakeSrc, { recursive: true });
      writeFileSync(
        join(fakeSrc, 'tricky.ts'),
        `// gbrain-allow-direct-insert: misplaced comment on the wrong line
import type { BrainEngine } from './engine.ts';
async function tricky(engine: BrainEngine) {
  await engine.insertFact({ fact: 'sneaky' } as any, { source_id: 'default' });
}
`,
        'utf-8',
      );

      const r = runGate(fakeRepo);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('tricky.ts');
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});

describe('check-system-of-record.sh — scope correctness', () => {
  test('does NOT scan test/ — tests legitimately call engine.insertFact for fixtures (Codex R2-#8)', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'gate-test-test-scope-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: fakeRepo });
      // src/ is clean; test/ has a violation. The gate should pass.
      const fakeTest = join(fakeRepo, 'test');
      mkdirSync(fakeTest, { recursive: true });
      writeFileSync(
        join(fakeTest, 'fixture.test.ts'),
        `// Fixtures legitimately call insertFact.
import type { BrainEngine } from '../src/core/engine.ts';
async function seed(engine: BrainEngine) {
  await engine.insertFact({ fact: 'seed' } as any, { source_id: 'default' });
}
`,
        'utf-8',
      );

      const r = runGate(fakeRepo);
      expect(r.code).toBe(0);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test('catches violations in scripts/ alongside src/', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'gate-test-scripts-scope-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: fakeRepo });
      const fakeScripts = join(fakeRepo, 'scripts');
      mkdirSync(fakeScripts, { recursive: true });
      writeFileSync(
        join(fakeScripts, 'naughty.ts'),
        `// Scripts are in-scope for the gate.
import type { BrainEngine } from '../src/core/engine.ts';
async function go(engine: BrainEngine) {
  await engine.addLinksBatch([] as any);
}
`,
        'utf-8',
      );

      const r = runGate(fakeRepo);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('naughty.ts');
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});
