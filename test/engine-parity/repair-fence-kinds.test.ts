/**
 * BrainEngine parity — `gbrain repair fences` and `gbrain repair slug-conflicts` through `runRepair` (batch 9).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with a page whose facts fence is broken, the fences preview lists it the same way on PGLite and
 *    Postgres (held for a model repair no measured model can make); the slug-conflicts preview of the same brain finds no
 *    held or conflicting file. The Rust engine stops both by name ("repair fences census") before any read: the fence
 *    census and the daily budget ledger read through lane 14's members (engine-sql/fence-census.ts), which are not on
 *    this branch yet. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts).
 *  - Regression: the Rust engine refused both kinds at `executeRaw` in the middle of the preview, with no name.
 *  - Why existing coverage misses it: test/repair-fences*.test.ts and test/repair-slug-conflicts*.test.ts run on PGLite and
 *    Postgres only.
 *  - Seam: none. Generated values are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } }).replace(/\b[0-9a-f]{64}\b/g, '<sha256>')
    // The census scan stamps its own clock.
    .replace(/"fresh_at":"[^"]*"/g, '"fresh_at":"<time>"'));
}

const runKind = async (engine: BrainEngine, kind: RepairKind) =>
  (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true });

const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-b9-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const BROKEN = 'Body.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim |\n|---|\n| x | broken\n<!--- gbrain:facts:end -->\n';

async function seedBrokenFence(engine: BrainEngine) {
  await engine.putPage('notes/broken-fence', { type: 'note' as never, title: 'broken fence', compiled_truth: BROKEN, timeline: '' }, { sourceId: 'default' });
}

describe('engine parity: the fence repair kinds of batch 9', () => {
  for (const kind of ['fences', 'slug-conflicts'] as const) {
    parityTest(`${kind} previews a brain with a broken facts fence the same way, and the Rust engine stops it by name`, {
      methods: ['putPage'], requires: 'raw_sql', timeout: 60_000,
    }, async (engine, backend) => withHome(async () => {
      await seedBrokenFence(engine);
      try {
        const previewed = await runKind(engine, kind);
        if (kind === 'fences') expect(previewed.residuals).toEqual({ no_measured_model: 1 });
        else expect(previewed.affected).toBe(0);
        return shape(previewed);
      } catch (err) {
        if (backend === 'rust') expect(refusalText(err)).toContain('repair fences census');
        throw err;
      }
    }));
  }
});
