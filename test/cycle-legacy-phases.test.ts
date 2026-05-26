/**
 * v0.39 (GAP 5 / D9) — cycle-phase wrapper coverage for legacy phases.
 *
 * Narrowed to RESULT-MAPPING + ERROR-ENVELOPE per D3 codex tension:
 *   - counter → PhaseStatus enum mapping (issues → 'warn'; gaps → 'ok' with
 *     audit-only summary; throw-from-lib → 'fail' with error envelope)
 *   - summary string format (caller-facing message)
 *   - dry-run path returns sensible status without writes
 *
 * The wrappers don't take a progress reporter or AbortSignal directly —
 * those concerns live at runCycle. We do NOT test "BaseCyclePhase contract"
 * here because legacy phases don't extend it. We test what they actually
 * do: lazy-import the lib, try/catch envelope, result-mapping.
 *
 * Combined file with two describe blocks per D5 — shared brain-dir setup,
 * future phases (sync, extract, embed, orphans) land as additional
 * describes here rather than 7 nearly-identical files.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseLint, runPhaseBacklinks } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Fresh brain dir per test — phase wrappers walk the filesystem.
  brainDir = mkdtempSync(join(tmpdir(), 'cycle-phases-'));
});

function cleanupBrain(): void {
  try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe('runPhaseLint — result-mapping', () => {
  test('clean brain (no markdown files) → status="ok", summary names zero issues', async () => {
    try {
      const result = await runPhaseLint(brainDir, false);
      expect(result.phase).toBe('lint');
      expect(result.status).toBe('ok');
      expect(result.summary.toLowerCase()).toContain('fix');
      // No issues, no error envelope.
      expect(result.error).toBeUndefined();
      expect(typeof result.details).toBe('object');
    } finally {
      cleanupBrain();
    }
  });

  test('brain with valid markdown → status="ok"', async () => {
    try {
      mkdirSync(join(brainDir, 'people'), { recursive: true });
      writeFileSync(
        join(brainDir, 'people', 'alice-example.md'),
        '---\ntitle: Alice\ntype: person\n---\n\nHello.\n',
      );
      const result = await runPhaseLint(brainDir, false);
      expect(result.phase).toBe('lint');
      expect(['ok', 'warn']).toContain(result.status);
      expect(result.error).toBeUndefined();
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    } finally {
      cleanupBrain();
    }
  });

  test('dry-run path → status reflects whether issues remained without writes', async () => {
    try {
      mkdirSync(brainDir, { recursive: true });
      const result = await runPhaseLint(brainDir, true);
      expect(result.phase).toBe('lint');
      // dryRun is in the details payload so callers can disambiguate.
      expect(result.details).toMatchObject({ dryRun: true });
      // Status is ok when nothing actionable found, warn when issues remain.
      expect(['ok', 'warn']).toContain(result.status);
      // Summary uses "would" / "found" / "no issues" — never the post-fix
      // "applied N fixes" string, because nothing was written.
      expect(result.summary.toLowerCase()).not.toContain('applied');
    } finally {
      cleanupBrain();
    }
  });

  test('throw-from-lib (nonexistent brainDir) → status="fail" with error envelope', async () => {
    const missingDir = join(tmpdir(), `nonexistent-brain-${Date.now()}-${Math.random()}`);
    const result = await runPhaseLint(missingDir, false);
    expect(result.phase).toBe('lint');
    expect(result.status).toBe('fail');
    expect(result.summary).toBe('lint phase failed');
    expect(result.error).toBeDefined();
    expect(typeof result.error!.code).toBe('string');
    // Critical: throw does NOT escape — the wrapper's try/catch envelope
    // contains it. If this assertion ever flips, every cycle that hits a
    // lint failure would abort instead of carrying on with the next phase.
  });
});

describe('runPhaseBacklinks — result-mapping', () => {
  test('clean brain (no markdown files) → status="ok" with "no missing" summary', async () => {
    try {
      const result = await runPhaseBacklinks(brainDir, false);
      expect(result.phase).toBe('backlinks');
      expect(result.status).toBe('ok');
      expect(result.summary.toLowerCase()).toMatch(/no missing back-links|^no\b/);
      expect(result.error).toBeUndefined();
      expect(result.details).toMatchObject({ mode: 'audit-only' });
    } finally {
      cleanupBrain();
    }
  });

  test('brain with content but no link gaps → status="ok"', async () => {
    try {
      mkdirSync(join(brainDir, 'people'), { recursive: true });
      writeFileSync(
        join(brainDir, 'people', 'alice-example.md'),
        '---\ntitle: Alice\ntype: person\n---\n\nNo links here.\n',
      );
      const result = await runPhaseBacklinks(brainDir, false);
      expect(result.phase).toBe('backlinks');
      // Even with gaps, the wrapper returns status='ok' — backlinks is
      // audit-only by design (v0.22+). Mode reflects that.
      expect(result.status).toBe('ok');
      expect(result.details).toMatchObject({ mode: 'audit-only' });
    } finally {
      cleanupBrain();
    }
  });

  test('dry-run path → status="ok", dryRun in details', async () => {
    try {
      const result = await runPhaseBacklinks(brainDir, true);
      expect(result.phase).toBe('backlinks');
      expect(result.status).toBe('ok');
      expect(result.details).toMatchObject({ dryRun: true, mode: 'audit-only' });
    } finally {
      cleanupBrain();
    }
  });

  test('throw-from-lib (nonexistent brainDir) → status="fail" with error envelope', async () => {
    const missingDir = join(tmpdir(), `nonexistent-brain-bl-${Date.now()}-${Math.random()}`);
    const result = await runPhaseBacklinks(missingDir, false);
    expect(result.phase).toBe('backlinks');
    expect(result.status).toBe('fail');
    expect(result.summary).toBe('backlinks phase failed');
    expect(result.error).toBeDefined();
    expect(typeof result.error!.code).toBe('string');
    // Same try/catch envelope contract as runPhaseLint above.
  });
});

describe('phase wrappers — contract invariants shared by both', () => {
  test('PhaseResult.phase always matches the wrapper name', async () => {
    try {
      const lint = await runPhaseLint(brainDir, false);
      const backlinks = await runPhaseBacklinks(brainDir, false);
      expect(lint.phase).toBe('lint');
      expect(backlinks.phase).toBe('backlinks');
    } finally {
      cleanupBrain();
    }
  });

  test('every PhaseResult has a string summary AND object details', async () => {
    try {
      for (const result of [
        await runPhaseLint(brainDir, false),
        await runPhaseBacklinks(brainDir, false),
      ]) {
        expect(typeof result.summary).toBe('string');
        expect(result.summary.length).toBeGreaterThan(0);
        expect(typeof result.details).toBe('object');
      }
    } finally {
      cleanupBrain();
    }
  });

  test('successful runs leave error undefined (envelope is fail-only)', async () => {
    try {
      const lint = await runPhaseLint(brainDir, false);
      const backlinks = await runPhaseBacklinks(brainDir, false);
      expect(lint.error).toBeUndefined();
      expect(backlinks.error).toBeUndefined();
    } finally {
      cleanupBrain();
    }
  });
});
