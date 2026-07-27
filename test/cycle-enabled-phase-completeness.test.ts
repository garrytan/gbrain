/**
 * #2540 — doctor's `cycle_freshness` must define "full cycle" against the
 * ENABLED phase set (pack-declared ∩ config-enabled), not the universe of
 * every phase `ALL_PHASES` could ever run.
 *
 * Investigation finding (documented here so a future reader doesn't
 * re-litigate it): on this codebase, that half of the issue was already
 * correctly handled BEFORE this fix —
 *
 *   - A phase the active pack doesn't declare (`extract_atoms`,
 *     `synthesize_concepts`) reports `status: 'skipped'` with
 *     `reason: 'not_in_active_pack'` (src/core/cycle.ts, the
 *     `packDeclaresPhase` gate). A config-disabled phase (`drift`,
 *     `enrich_thin`, `skillopt`, `conversation_facts_backfill`,
 *     `synthesize` with no corpus dir configured) is also `'skipped'`.
 *   - `deriveStatus` only downgrades the report on `'warn'`/`'fail'`
 *     phases; `'skipped'` phases are excluded from both `anyWarn` and
 *     `anyFailed`/`allFailed`.
 *   - The `last_full_cycle_at` stamp gate (runCycle's exit hook) already
 *     writes on `status === 'ok' | 'clean' | 'partial'` — only a fully
 *     'failed' cycle (every attempted phase failed) skips the write.
 *
 * So a pack that omits optional phases, with every phase it DOES enable
 * completing, was already stamped — test 1 below pins that (it passes
 * on both sides of this PR's actual fix, which lives in
 * `resolveSourceForDir`'s symlink handling; see
 * test/dream-dir-source-stamp.test.ts for the part that regresses
 * without the fix).
 *
 * Test 2 pins the other side the issue explicitly calls out: the fix
 * must not "weaken the check into uselessness" — when every attempted
 * phase genuinely fails, the cycle must still report 'failed' and must
 * NOT stamp `last_full_cycle_at`, so doctor's cycle_freshness can still
 * catch a real problem.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { runCycle, ALL_PHASES } from '../src/core/cycle.ts';
import { mkdtempSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-2540-enabled-phases-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name t', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

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
  brainDir = makeGitRepo();
  gbrainHome = emptyHome();
});

async function seedSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, id, brainDir],
  );
}

async function readLastFullCycleAt(sourceId: string): Promise<string | null> {
  const sources = await engine.listAllSources();
  const s = sources.find(x => x.id === sourceId);
  if (!s) return null;
  const raw = s.config?.last_full_cycle_at;
  return typeof raw === 'string' ? raw : null;
}

describe('#2540 (i) — pack omitting optional phases, all enabled phases complete', () => {
  test('full ALL_PHASES cycle with no active pack declaring extract_atoms/synthesize_concepts stamps last_full_cycle_at', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      await seedSource('no-pack');
      expect(await readLastFullCycleAt('no-pack')).toBeNull();

      // No active pack registered → packDeclaresPhase fails open (false)
      // for extract_atoms/synthesize_concepts → both report 'skipped',
      // not 'warn'/'fail'. Default ALL_PHASES selection (matches a real
      // nightly `gbrain dream`/`gbrain dream --dir` run).
      const report = await runCycle(engine, {
        brainDir,
        sourceId: 'no-pack',
      });

      const extractAtoms = report.phases.find(p => p.phase === 'extract_atoms');
      const synthConcepts = report.phases.find(p => p.phase === 'synthesize_concepts');
      expect(extractAtoms?.status).toBe('skipped');
      expect(extractAtoms?.details?.reason).toBe('not_in_active_pack');
      expect(synthConcepts?.status).toBe('skipped');
      expect(synthConcepts?.details?.reason).toBe('not_in_active_pack');

      // The cycle must not be reported 'failed' outright just because two
      // phases the pack never declared were skipped.
      expect(report.status).not.toBe('failed');

      // Scope note (from review): 'not failed' deliberately does NOT claim
      // "every enabled phase succeeded". A mixed success/failure cycle
      // reports 'partial', and runCycle stamps on 'partial' too — e.g. in an
      // environment with no embedding provider configured, `embed` reports
      // 'fail' and the stamp still lands. Whether a partial cycle should
      // stamp `last_full_cycle_at` at all is a separate semantics question
      // for the maintainer; this PR does not change it, and this test must
      // not silently encode an answer to it. What IS pinned here is the
      // narrow property under test: a phase the active pack never declared
      // is 'skipped' — never 'fail' — so pack composition alone can never
      // hold the stamp back.
      const packGatedFailures = report.phases
        .filter(p => p.details?.reason === 'not_in_active_pack' && p.status !== 'skipped')
        .map(p => `${p.phase}:${p.status}`);
      expect(packGatedFailures).toEqual([]);

      expect(await readLastFullCycleAt('no-pack')).not.toBeNull();
    });
  }, 60_000);
});

describe('#2540 (ii) — an enabled phase that never completes still prevents the stamp', () => {
  test('every selected phase failing reports status=failed and does NOT stamp last_full_cycle_at', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      await seedSource('always-fails');
      expect(await readLastFullCycleAt('always-fails')).toBeNull();

      // embed is a real, always-enabled phase (no pack gate, no config
      // .enabled toggle). With no embedding provider key configured it
      // deterministically fails — this is NOT the fix under test, it's
      // the pre-existing "an enabled phase genuinely never completes"
      // case the issue says must keep failing doctor's check.
      const report = await runCycle(engine, {
        brainDir,
        sourceId: 'always-fails',
        phases: ['embed'],
      });

      expect(report.status).toBe('failed');
      expect(report.phases[0]?.status).toBe('fail');
      expect(await readLastFullCycleAt('always-fails')).toBeNull();
    });
  }, 60_000);
});

// Static-shape guard: pins ALL_PHASES still contains both pack-gated
// phases, so a future refactor that drops them from the default set
// doesn't silently make test 1 above meaningless.
describe('#2540 — ALL_PHASES still includes the pack-gated phases', () => {
  test('ALL_PHASES contains extract_atoms and synthesize_concepts', () => {
    expect(ALL_PHASES).toContain('extract_atoms');
    expect(ALL_PHASES).toContain('synthesize_concepts');
  });
});
