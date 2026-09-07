/**
 * #4778 — `GBRAIN_SOURCE=<id> gbrain dream` scopes the cycle like `--source <id>`.
 *
 * Pre-fix, dream entered the shared 6-tier source resolver only behind the
 * `--source` flag gate, so tier 2 (GBRAIN_SOURCE: validate + assertSourceExists)
 * could never fire. An env-scoped bare run fell through to sources.default /
 * sole-non-default / directory routing, cycled the wrong corpus, and never
 * stamped the intended source's freshness — silently, with exit 0, even for an
 * invalid or unregistered env value.
 *
 * Same real-PGLite/no-mocks discipline as test/dream-dir-source-stamp.test.ts,
 * same GBRAIN_HOME isolation (the cycle's PGLite file lock lives under
 * ~/.gbrain). Two active non-default sources with distinct on-disk local_paths
 * are seeded where tier-5.5 sole-non-default routing must NOT be allowed to
 * satisfy the assertion by accident; cwd stays outside both trees.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ALL_PHASES } from '../src/core/cycle.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runDream } from '../src/commands/dream.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let dirA: string;
let dirB: string;
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
  dirA = mkdtempSync(join(tmpdir(), 'gbrain-dream-env-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'gbrain-dream-env-b-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-dream-env-home-'));
}, 60_000);

afterEach(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

async function seedSource(id: string, localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())`,
    [id, id, localPath],
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

/** Run dream expecting a clean exit-1; returns the stderr lines it printed. */
async function runExpectingExit1(args: string[]): Promise<string[]> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
  const errLines: string[] = [];
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errLines.push(a.map(String).join(' '));
  });
  try {
    let threw: unknown;
    try {
      await runDream(engine, args);
    } catch (e) {
      threw = e;
    }
    expect((threw as Error | undefined)?.message).toBe('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);
    return errLines;
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('gbrain dream honors GBRAIN_SOURCE like --source (#4778)', () => {
  test('two-source brain: GBRAIN_SOURCE=source-a stamps source-a only', async () => {
    await seedSource('source-a', dirA);
    await seedSource('source-b', dirB);
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SOURCE: 'source-a' }, async () => {
      const report = await runDream(engine, ['--phase', 'lint', '--json']);
      expect(report).toBeTruthy();
      if (report) expect(['ok', 'clean']).toContain(report.status);
      // Pre-fix: two non-default sources defeat sole-non-default routing, no
      // sync.repo_path means no dir derivation, so resolvedSourceId stayed
      // undefined and runCycle's stamp gate skipped the write.
      expect(await readLastFullCycleAt('source-a')).not.toBeNull();
      expect(await readLastFullCycleAt('source-b')).toBeNull();
    });
  }, 60_000);

  test('invalid GBRAIN_SOURCE exits 1 with the resolver message (was: exit 0, unscoped)', async () => {
    await seedSource('source-a', dirA);
    await seedSource('source-b', dirB);
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SOURCE: 'NOT!VALID' }, async () => {
      const errLines = await runExpectingExit1(['--phase', 'lint', '--json']);
      expect(errLines.some((l) => l.startsWith('Invalid GBRAIN_SOURCE value'))).toBe(true);
    });
  }, 60_000);

  test('unregistered GBRAIN_SOURCE exits 1 with the not-found message (was: exit 0, unscoped)', async () => {
    await seedSource('source-a', dirA);
    await seedSource('source-b', dirB);
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SOURCE: 'ghost' }, async () => {
      const errLines = await runExpectingExit1(['--phase', 'lint', '--json']);
      expect(errLines.some((l) => l.includes('Source "ghost" not found or is archived.'))).toBe(true);
    });
  }, 60_000);

  test('GBRAIN_SOURCE=__all__ spans the brain: never narrowed to the implicit default source (wave review)', async () => {
    // Two populated-shape sources, sources.default = source-a: a bare run
    // narrows to source-a (#4700). An EXPLICIT __all__ asks for the whole
    // brain — the sentinel is excluded from the resolver (a '__all__' scope has
    // no local_path), but it must also skip the implicit-default narrowing.
    await seedSource('source-a', dirA);
    await seedSource('source-b', dirB);
    await engine.setConfig('sources.default', 'source-a');
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SOURCE: '' }, async () => {
      const bare = await runDream(engine, ['--phase', 'lint', '--json']);
      expect(bare?.brain_dir).toBe(dirA); // the #4700 implicit-default lane
    });
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SOURCE: '__all__' }, async () => {
      const report = await runDream(engine, ['--phase', 'lint', '--json']);
      expect(report).toBeTruthy();
      expect(report?.brain_dir).not.toBe(dirA);
      expect(report?.phases.map((p) => p.phase)).toEqual(['lint']);
    });
  }, 60_000);

  test('GBRAIN_SOURCE naming the sole non-default source keeps the full implicit cycle (#4700 no-regression)', async () => {
    await seedSource('source-a', dirA);
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SOURCE: 'source-a' }, async () => {
      const report = await runDream(engine, ['--dry-run', '--json']);
      expect(report).toBeTruthy();
      // The env names the brain's default-like source, which is the canonical
      // default cycle — not a freshness-only --source cycle.
      expect(report?.phases.map((p) => p.phase)).toEqual(ALL_PHASES);
      for (const p of report?.phases ?? []) {
        expect((p.details as { reason?: string } | undefined)?.reason).not.toBe('excluded_from_implicit_source_cycle');
      }
    });
  }, 300_000);
});
