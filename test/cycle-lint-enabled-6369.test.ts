/**
 * PR #6369 shape (wave 15 P7.3): `cycle.lint.enabled` is the off switch for
 * the cycle's lint phase. Default on; only an explicit falsy value (`false`,
 * `0`, `off`, `no`) skips the phase, which then reports `skipped` with an
 * enable hint and never scans the brain directory. `gbrain dream --phase lint
 * --once` runs the phase once while it is off. `gbrain lint` is unaffected.
 *
 * Protects: the phase result and the brain files under a disabled lint phase.
 * Fails when: the key is ignored (the phase scans and repairs anyway), when
 * the disabled path still touches the directory, or when `--once` stops
 * bypassing the switch. Why new: `test/cycle-legacy-phases.test.ts` covers
 * `cycle.lint_fix` and `cycle.lint_exclude` only. Seam: none; the no-scan
 * proof is a file lint --fix would rewrite staying byte-identical.
 *
 * Contributed by @dovstern (#6369): the switch's shape and the skipped-result
 * cases; this test adds the no-scan bytes assertion and the --once bypass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runCycle, runPhaseLint } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let brainDir: string;
// A page wrapped in ```markdown fences: the one lint --fix rewrites (code-fence-wrap is fixable).
const WRAPPED = '```markdown\n---\ntitle: Wrapped\ntype: note\ndate: 2026-01-01\n---\n\nBody.\n```\n';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'cycle-lint-enabled-'));
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  writeFileSync(join(brainDir, 'notes', 'wrapped.md'), WRAPPED);
});
const cleanup = () => { try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* best effort */ } };
const page = () => readFileSync(join(brainDir, 'notes', 'wrapped.md'), 'utf8');

describe('cycle.lint.enabled (#6369, P7.3)', () => {
  test('control: with the key unset the phase scans and repairs the file', async () => {
    try {
      const result = await runPhaseLint(brainDir, false, engine);
      expect(result.status).not.toBe('skipped');
      expect((result.details as { pages_scanned?: number }).pages_scanned).toBeGreaterThan(0);
      expect(page()).not.toBe(WRAPPED);
    } finally { cleanup(); }
  });

  for (const raw of ['false', '0', 'off', 'no', ' False ']) {
    test(`"${raw}" skips the phase without scanning: result skipped, enable hint, file bytes unchanged`, async () => {
      try {
        await engine.setConfig('cycle.lint.enabled', raw);
        const result = await runPhaseLint(brainDir, false, engine);
        expect(result.status).toBe('skipped');
        expect(result.summary).toBe('lint skipped: cycle.lint.enabled=false');
        expect(result.details).toEqual({ reason: 'disabled', enable_hint: 'gbrain config set cycle.lint.enabled true' });
        expect(result.error).toBeUndefined();
        expect(page()).toBe(WRAPPED);
      } finally { cleanup(); }
    });
  }

  test('a truthy or unparseable value keeps the phase on', async () => {
    try {
      for (const raw of ['true', 'yes', 'on', '1', 'maybe']) {
        await engine.setConfig('cycle.lint.enabled', raw);
        const result = await runPhaseLint(brainDir, true, engine);
        expect(result.status).not.toBe('skipped');
      }
    } finally { cleanup(); }
  });

  test('--once bypasses the switch for that call only', async () => {
    try {
      await engine.setConfig('cycle.lint.enabled', 'false');
      const once = await runPhaseLint(brainDir, false, engine, undefined, undefined, { once: true });
      expect(once.status).not.toBe('skipped');
      expect(page()).not.toBe(WRAPPED);
      const again = await runPhaseLint(brainDir, false, engine);
      expect(again.status).toBe('skipped');
    } finally { cleanup(); }
  });

  test('runCycle threads onceForPhase=lint to the lint phase; other phases do not unlock it', async () => {
    try {
      await engine.setConfig('cycle.lint.enabled', 'false');
      const off = await runCycle(engine, { brainDir, phases: ['lint'], dryRun: true });
      expect(off.phases.find(p => p.phase === 'lint')?.status).toBe('skipped');
      const wrongPhase = await runCycle(engine, { brainDir, phases: ['lint'], dryRun: true, onceForPhase: 'backlinks' });
      expect(wrongPhase.phases.find(p => p.phase === 'lint')?.status).toBe('skipped');
      expect(page()).toBe(WRAPPED);
      const once = await runCycle(engine, { brainDir, phases: ['lint'], dryRun: false, onceForPhase: 'lint' });
      expect(once.phases.find(p => p.phase === 'lint')?.status).not.toBe('skipped');
      expect(page()).not.toBe(WRAPPED);
    } finally { cleanup(); }
  });
});
