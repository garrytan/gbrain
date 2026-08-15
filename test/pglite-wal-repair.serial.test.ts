/**
 * The ported upstream regression (electric-sql/pglite PR #994) against a REAL
 * PGLite brain: create → insert → clean shutdown → corrupt the WAL → reopen
 * through PGLiteEngine.connect() → auto-repair fires → the original row is
 * still readable. Plus the kill-switch, gate-level negatives, and the #2084
 * exitCode pin.
 *
 * .serial: real PGLite cold starts + process.env writes (docs/TESTING.md R1).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { EngineConfig } from '../src/core/types.ts';

const COLD_START_TIMEOUT = 120_000;

function engineConfig(dir: string): EngineConfig {
  return { engine: 'pglite', database_path: dir } as EngineConfig;
}

/** Build a real brain with one probe row, cleanly shut down. */
async function buildRealBrain(): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'walrepair-')), 'brain.pglite');
  const engine = new PGLiteEngine();
  await engine.connect(engineConfig(dir));
  await engine.db.exec('CREATE TABLE repair_probe (id int); INSERT INTO repair_probe VALUES (42);');
  await engine.disconnect();
  return dir;
}

function walSegments(dir: string): string[] {
  return readdirSync(join(dir, 'pg_wal')).filter((f) => /^[0-9A-F]{24}$/.test(f));
}

function backupDirs(dir: string): string[] {
  return readdirSync(dirname(dir)).filter((f) => f.startsWith(`${basename(dir)}.wal-repair-backup-`));
}

function corruptAllSegments(dir: string, mode: 'truncate' | 'garbage'): void {
  const segs = walSegments(dir);
  expect(segs.length).toBeGreaterThan(0);
  for (const seg of segs) {
    const p = join(dir, 'pg_wal', seg);
    if (mode === 'truncate') {
      truncateSync(p, 1024);
    } else {
      // Overwrite the whole segment with garbage, keeping its size.
      const size = readFileSync(p).length;
      writeFileSync(p, Buffer.alloc(size, 0xff));
    }
  }
}

async function connectExpectingRepair(dir: string): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
  try {
    await engine.connect(engineConfig(dir));
  } finally {
    console.warn = origWarn;
  }
  // #2084 pin: the retry create's exit-status scribble is contained.
  expect(Number(process.exitCode ?? 0)).toBe(0);
  expect(engine.walRepairReceipt).not.toBeNull();
  expect(warns.join('\n')).toContain('repaired');
  return engine;
}

describe('WAL auto-repair — real-brain regression (#223/#1670/#2575)', () => {
  test('case A (truncated WAL): connect() auto-repairs and the row survives', async () => {
    const dir = await buildRealBrain();
    corruptAllSegments(dir, 'truncate');

    const engine = await connectExpectingRepair(dir);
    try {
      const receipt = engine.walRepairReceipt!;
      expect(existsSync(receipt.backupPath)).toBe(true);
      expect(existsSync(join(receipt.backupPath, 'pg_wal'))).toBe(true);
      const rows = await engine.db.query('SELECT id FROM repair_probe');
      expect((rows.rows[0] as { id: number }).id).toBe(42);
    } finally {
      await engine.disconnect();
    }
  }, COLD_START_TIMEOUT);

  test('case B (garbage-overwritten WAL): connect() auto-repairs and the row survives', async () => {
    const dir = await buildRealBrain();
    corruptAllSegments(dir, 'garbage');

    const engine = await connectExpectingRepair(dir);
    try {
      const rows = await engine.db.query('SELECT id FROM repair_probe');
      expect((rows.rows[0] as { id: number }).id).toBe(42);
      // A healthy reconnect afterwards does NOT re-fire repair.
      await engine.disconnect();
      const engine2 = new PGLiteEngine();
      await engine2.connect(engineConfig(dir));
      expect(engine2.walRepairReceipt).toBeNull();
      await engine2.disconnect();
    } finally {
      try { await engine.disconnect(); } catch { /* already disconnected */ }
    }
  }, COLD_START_TIMEOUT);

  test('kill-switch: GBRAIN_PGLITE_WAL_REPAIR=off → honest error, no backup, lock released', async () => {
    const dir = await buildRealBrain();
    corruptAllSegments(dir, 'garbage');
    const backupsBefore = backupDirs(dir).length;

    await withEnv({ GBRAIN_PGLITE_WAL_REPAIR: 'off' }, async () => {
      const engine = new PGLiteEngine();
      let message = '';
      try {
        await engine.connect(engineConfig(dir));
        throw new Error('connect unexpectedly succeeded');
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain('PGLite failed to initialize');
      expect(message).toContain('GBRAIN_PGLITE_WAL_REPAIR=off');
      expect(message).toContain('gbrain pglite-repair');
      expect(message).toContain('Original error:');
    });
    // No surgery happened…
    expect(backupDirs(dir).length).toBe(backupsBefore);
    // …and the lock was released: repair works on the next (enabled) connect.
    const engine = await connectExpectingRepair(dir);
    const rows = await engine.db.query('SELECT id FROM repair_probe');
    expect((rows.rows[0] as { id: number }).id).toBe(42);
    await engine.disconnect();
  }, COLD_START_TIMEOUT);

  test('gate negative: a REAL wasm-abort with the cooldown gate active refuses repair — no new backup, honest skip reason', async () => {
    // A genuinely corrupt brain (create() aborts with the production
    // `RuntimeError: Aborted()` signature) whose sidecar records a fresh
    // failed attempt — the classifier says wasm-abort, but the cooldown gate
    // must refuse BEFORE any surgery. Pins the skip path end-to-end: verdict
    // fired, gate refused, zero backup dirs created, honest message.
    const { recordRepairAttempt } = await import('../src/core/pglite-repair.ts');
    const dir = await buildRealBrain();
    corruptAllSegments(dir, 'garbage');
    recordRepairAttempt(dir, 'failed', null);

    const engine = new PGLiteEngine();
    let message = '';
    try {
      await engine.connect(engineConfig(dir));
      throw new Error('connect unexpectedly succeeded');
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('PGLite failed to initialize');
    expect(message).toContain('Auto-repair skipped');
    expect(message).toContain('gbrain pglite-repair');
    expect(backupDirs(dir).length).toBe(0);
  }, COLD_START_TIMEOUT);

  test('gate negative: symlinked data dir — Emscripten refuses the mount with a NAMED error, repair never fires', async () => {
    // PGLite's NODEFS cannot mount through a symlinked data dir: it throws a
    // message-less `ErrnoError { errno: 20 }`. Two pins: (a) the error
    // stringifier surfaces name+errno instead of "[object Object]" (#2674
    // class), (b) no repair surgery runs on either path.
    const { symlinkSync } = await import('node:fs');
    const real = await buildRealBrain();
    corruptAllSegments(real, 'garbage');
    const link = join(mkdtempSync(join(tmpdir(), 'walrepair-')), 'link.pglite');
    symlinkSync(real, link);

    const engine = new PGLiteEngine();
    let message = '';
    try {
      await engine.connect(engineConfig(link));
      throw new Error('connect unexpectedly succeeded');
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('PGLite failed to initialize');
    expect(message).not.toContain('[object Object]');
    expect(message).toContain('ErrnoError (errno 20)');
    expect(backupDirs(real).length).toBe(0);
    expect(backupDirs(link).length).toBe(0);
  }, COLD_START_TIMEOUT);

  test('gate shape: the seam only runs for wasm-abort + persistent dataDir (structural pin)', () => {
    const src = readFileSync('src/core/pglite-engine.ts', 'utf-8');
    expect(src).toMatch(/if \(verdict === 'wasm-abort'\)/);
    expect(src).toMatch(/if \(!dataDir\) \{\s*\n\s*ctx = \{ repair: 'in-memory' \}/);
    // The seam call sits INSIDE the wasm-abort branch (no call site outside it).
    const firstSeamCall = src.indexOf('await attemptWalRepairAndRetry(');
    const gate = src.indexOf("if (verdict === 'wasm-abort')");
    expect(gate).toBeGreaterThan(-1);
    expect(firstSeamCall).toBeGreaterThan(gate);
    expect(src.indexOf('await attemptWalRepairAndRetry(', firstSeamCall + 1)).toBe(-1);
  });
});
