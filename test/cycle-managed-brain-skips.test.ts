import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseLint } from '../src/core/cycle.ts';
import { runExtractCore } from '../src/commands/extract.ts';
import { managedBrainPhaseSkip } from '../src/core/persistence/maintenance.ts';

/**
 * #5180 / #5203 (phase half): on a managed brain (persistence_brain.enabled)
 * the legacy lint and extraction writers cannot mutate canonical tables or
 * files. They must report `skipped` with reason `writer_coordinator_required`
 * (or, for extract, keep the unguarded links pass and skip the timeline pass)
 * instead of failing the lane, so the per-source cycle keeps running.
 * synthesize / patterns / consolidate gained coordinator-backed paths in
 * v0.54.1.0 and are not covered here.
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

describe('managed brain: legacy lint/extraction phases skip with a reason', () => {
  test('managedBrainPhaseSkip reflects persistence_brain.enabled', async () => {
    const skip = await managedBrainPhaseSkip(engine, 'lint', 'x');
    expect(skip?.status).toBe('skipped');
    expect(skip?.details.reason).toBe('writer_coordinator_required');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    expect(await managedBrainPhaseSkip(engine, 'lint', 'x')).toBeNull();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });

  test('lint in fix mode skips instead of failing (#5180)', async () => {
    const r = await runPhaseLint(brainDir, false, engine);
    expect(r.status).toBe('skipped');
    expect(r.details?.reason).toBe('writer_coordinator_required');
  });

  test('lint dry-run still reports (no writes) on a managed brain', async () => {
    const r = await runPhaseLint(brainDir, true, engine);
    expect(r.status).not.toBe('skipped');
    expect(r.status).not.toBe('fail');
  });

  test('extract keeps the links pass and skips the timeline pass (#5203)', async () => {
    const r = await runExtractCore(engine, { mode: 'all', dir: brainDir, quiet: true, jsonMode: false } as any);
    expect(r.timeline_skipped_reason).toBe('writer_coordinator_required');
    expect(r.timeline_entries_created).toBe(0);
    const t = await runExtractCore(engine, { mode: 'timeline', dir: brainDir, quiet: true, jsonMode: false } as any);
    expect(t.timeline_skipped_reason).toBe('writer_coordinator_required');
  });

  test('unmanaged brain is unaffected', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      const lint = await runPhaseLint(brainDir, false, engine);
      expect(lint.details?.reason).not.toBe('writer_coordinator_required');
      const ex = await runExtractCore(engine, { mode: 'all', dir: brainDir, quiet: true, jsonMode: false } as any);
      expect(ex.timeline_skipped_reason).toBeUndefined();
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  });
});
