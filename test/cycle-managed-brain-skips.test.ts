import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseLint } from '../src/core/cycle.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { runExtractCore } from '../src/commands/extract.ts';
import { isManagedBrain } from '../src/core/persistence/maintenance.ts';

/**
 * #5175 / #5180 / #5203 (phase half): on a managed brain (persistence_brain.enabled)
 * the legacy maintenance writers cannot mutate canonical tables or files. Each
 * phase must report `skipped` with reason `writer_coordinator_required` instead
 * of throwing or failing, so the per-source and brain-global lanes keep running
 * (embed, orphans, purge, grade_takes, ...) and the autopilot stamps progress.
 */
let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-skips-'));
  writeFileSync(join(brainDir, 'note.md'), `---\ntype: note\ntitle: Note\ningested_at: '2026-08-30T12:00:00Z'\n---\n\nBody.\n`);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
});
afterAll(async () => { await engine.disconnect(); rmSync(brainDir, { recursive: true, force: true }); });

describe('managed brain: legacy maintenance phases skip with a reason', () => {
  test('isManagedBrain reflects persistence_brain.enabled', async () => {
    expect(await isManagedBrain(engine)).toBe(true);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    expect(await isManagedBrain(engine)).toBe(false);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });

  test('synthesize skips instead of throwing (#5175)', async () => {
    const r = await runPhaseSynthesize(engine, { brainDir, dryRun: false } as any);
    expect(r.status).toBe('skipped');
    expect(r.details?.reason).toBe('writer_coordinator_required');
  });

  test('patterns skips instead of throwing (#5175)', async () => {
    const r = await runPhasePatterns(engine, { brainDir, dryRun: false } as any);
    expect(r.status).toBe('skipped');
    expect(r.details?.reason).toBe('writer_coordinator_required');
  });

  test('lint --fix skips instead of failing (#5180)', async () => {
    const r = await runPhaseLint(brainDir, false, engine);
    expect(r.status).toBe('skipped');
    expect(r.details?.reason).toBe('writer_coordinator_required');
  });

  test('lint dry-run still reports (no writes) on a managed brain', async () => {
    const r = await runPhaseLint(brainDir, true, engine);
    expect(r.status).not.toBe('skipped');
    expect(r.status).not.toBe('fail');
  });

  test('consolidate skips instead of hitting the writer guard', async () => {
    const r = await runPhaseConsolidate(engine, { dryRun: false });
    expect(r.status).toBe('skipped');
    expect(r.details?.reason).toBe('writer_coordinator_required');
  });

  test('extract keeps the links pass and skips the timeline pass', async () => {
    const r = await runExtractCore(engine, { mode: 'all', dir: brainDir, quiet: true, jsonMode: false } as any);
    expect(r.timeline_skipped_reason).toBe('writer_coordinator_required');
    expect(r.timeline_entries_created).toBe(0);
    const t = await runExtractCore(engine, { mode: 'timeline', dir: brainDir, quiet: true, jsonMode: false } as any);
    expect(t.timeline_skipped_reason).toBe('writer_coordinator_required');
  });

  test('unmanaged brain is unaffected: phases do not report the managed skip', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      const lint = await runPhaseLint(brainDir, false, engine);
      expect(lint.details?.reason).not.toBe('writer_coordinator_required');
      const cons = await runPhaseConsolidate(engine, { dryRun: false });
      expect(cons.details?.reason).not.toBe('writer_coordinator_required');
      const ex = await runExtractCore(engine, { mode: 'all', dir: brainDir, quiet: true, jsonMode: false } as any);
      expect(ex.timeline_skipped_reason).toBeUndefined();
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  });
});
