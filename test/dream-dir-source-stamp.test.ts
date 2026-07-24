/**
 * #1869 — `gbrain dream --dir <path>` stamps cycle freshness when the path
 * matches a registered source's local_path.
 *
 * Pre-fix, only `--source <id>` runs wrote last_source_cycle_at /
 * last_full_cycle_at (runCycle's stamp gate reads opts.sourceId, and dream
 * never derived one from --dir), so a path-scoped brain showed doctor's
 * cycle_freshness as perpetually stale.
 *
 * The fix lives in dream.ts (derive the source id from the resolved brain
 * dir via resolveSourceForDir), NOT in runCycle's stamp gate — a runCycle-
 * wide change would make the autopilot-global-maintenance handler (global
 * phases, brainDir set, no sourceId) falsely stamp per-source freshness
 * (the #2194 poisoning class; see rejected PR #2549).
 *
 * Same real-PGLite/no-mocks discipline as test/dream.test.ts; same
 * GBRAIN_HOME isolation as test/cycle-last-full-cycle-at.test.ts (the
 * cycle's PGLite file lock lives under ~/.gbrain).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runDream } from '../src/commands/dream.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-stamp-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-dream-stamp-home-'));
}, 60_000);

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

async function seedSource(id: string, archived = false): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, NOW())`,
    [id, id, brainDir, archived],
  );
}

async function readLastFullCycleAt(sourceId: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ config: Record<string, unknown> | null }>(
    `SELECT config FROM sources WHERE id = $1`,
    [sourceId],
  );
  const raw = rows[0]?.config?.last_full_cycle_at;
  return typeof raw === 'string' ? raw : null;
}

describe('gbrain dream --dir <path> freshness stamp (#1869)', () => {
  test('--dir matching a source local_path stamps last_full_cycle_at', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('path-scoped');
      expect(await readLastFullCycleAt('path-scoped')).toBeNull();

      const report = await runDream(engine, ['--dir', brainDir, '--phase', 'lint', '--json']);
      expect(report).toBeTruthy();
      if (report) expect(['ok', 'clean']).toContain(report.status);

      // Pre-fix this stays null forever: dream never passed a sourceId, so
      // runCycle's stamp gate skipped the write.
      expect(await readLastFullCycleAt('path-scoped')).not.toBeNull();
    });
  }, 60_000);

  test('--dir matching an ARCHIVED source does not stamp it', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('mothballed', true);

      const report = await runDream(engine, ['--dir', brainDir, '--phase', 'lint', '--json']);
      expect(report).toBeTruthy();

      // Stamping an archived source would mask data staleness when it is
      // later restored (mirrors the explicit --source archived guard).
      expect(await readLastFullCycleAt('mothballed')).toBeNull();
    });
  }, 60_000);
});

/**
 * #2540 — `--dir` matching against `sources.local_path` compares two path
 * SPELLINGS, and neither side is canonicalized: `--dir` goes through
 * `resolve()`, while `sources.local_path` stores whatever spelling the
 * source was registered with (`--path` as typed, or `defaultCloneDir`).
 * So a source registered through a symlink but dreamt via the real path
 * (or vice versa) never string-matched — `resolveSourceForDir`
 * (src/core/cycle.ts) derived no source, the #1869 freshness stamp never
 * landed, and doctor's `cycle_freshness` stayed permanently stale on an
 * otherwise healthy install. Symlinked vault locations are ordinary (a
 * brain inside a synced cloud-storage folder, a /home -> /mnt relocation).
 *
 * Fix: on an exact-match miss, `resolveSourceForDir` retries with
 * `realpathSync` applied to BOTH sides, so the match is symmetric no
 * matter which side holds the link. Both directions are pinned below.
 * Symlinks are constructed explicitly here (rather than relying on the
 * host's own tmpdir layout) so the test is deterministic on macOS and
 * Linux CI alike.
 */
describe('gbrain dream --dir <path> freshness stamp across a symlink (#2540)', () => {
  test('local_path stored as the REAL path, --dir given the SYMLINKED path still stamps', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const realTarget = mkdtempSync(join(tmpdir(), 'gbrain-2540-real-'));
      const linkParent = mkdtempSync(join(tmpdir(), 'gbrain-2540-link-'));
      const symlinkedDir = join(linkParent, 'vault');
      symlinkSync(realTarget, symlinkedDir, 'dir');
      expect(realpathSync(symlinkedDir)).not.toBe(symlinkedDir); // sanity: the symlink actually diverges

      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, archived, created_at)
         VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())`,
        ['vault-real', 'vault-real', realTarget],
      );

      const report = await runDream(engine, ['--dir', symlinkedDir, '--phase', 'lint', '--json']);
      expect(report).toBeTruthy();
      expect(await readLastFullCycleAt('vault-real')).not.toBeNull();

      rmSync(realTarget, { recursive: true, force: true });
      rmSync(linkParent, { recursive: true, force: true });
    });
  }, 60_000);

  test('local_path stored as the SYMLINKED path, --dir given the REAL path still stamps', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const realTarget = mkdtempSync(join(tmpdir(), 'gbrain-2540-real2-'));
      const linkParent = mkdtempSync(join(tmpdir(), 'gbrain-2540-link2-'));
      const symlinkedDir = join(linkParent, 'vault');
      symlinkSync(realTarget, symlinkedDir, 'dir');

      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, archived, created_at)
         VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())`,
        ['vault-link', 'vault-link', symlinkedDir],
      );

      const report = await runDream(engine, ['--dir', realpathSync(symlinkedDir), '--phase', 'lint', '--json']);
      expect(report).toBeTruthy();
      expect(await readLastFullCycleAt('vault-link')).not.toBeNull();

      rmSync(realTarget, { recursive: true, force: true });
      rmSync(linkParent, { recursive: true, force: true });
    });
  }, 60_000);
});
