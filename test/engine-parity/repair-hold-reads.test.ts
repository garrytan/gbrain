/**
 * BrainEngine parity — the normal answers of the reads whose catches the repair reports no longer have: the oldest
 * hold of `gbrain repair fences` and `gbrain repair slug-conflicts` (`readOldestSyncHoldAt`, reported as
 * `verification.oldest_hold_at`), and the page lookup of a named slug (`getPage`, which slug-conflicts reads to record
 * whether the page has a file).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a brain with no hold row of the kind reports `oldest_hold_at: null`; one with hold rows reports the
 *    earliest `held_at` of its own hold code (a fences hold does not answer slug-conflicts); a slug that names no page
 *    reads as `null` from `getPage`, not as an error. The same on PGLite, Postgres and Rust, so removing the catch that
 *    used to turn any failure into those answers changes none of them.
 *  - Regression: `reportFences`, `reportConflicts` and `recordState` caught every error of these reads into a null,
 *    which also hid the Rust engine's typed capability refusal (test/repair-refusal-swallow.test.ts).
 *  - Why existing coverage misses it: test/repair-fences*.test.ts and test/repair-slug-conflicts*.test.ts run on PGLite and
 *    Postgres only.
 *  - Seam: none. Typed members only; hold rows are written with `writeOpCheckpointRecord`.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {} } as never;

async function oldestHold(engine: BrainEngine, kind: RepairKind): Promise<unknown> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-holds-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const result = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true });
      return (result as unknown as { verification: { oldest_hold_at: unknown } }).verification.oldest_hold_at;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('engine parity: the reads behind the repair verification', () => {
  parityTest('the oldest hold reads null with no hold row and the earliest held_at of its own code with some', {
    methods: ['writeOpCheckpointRecord', 'readOldestSyncHoldAt'], timeout: 60_000,
  }, async (engine) => {
    const none = { fences: await oldestHold(engine, 'fences'), conflicts: await oldestHold(engine, 'slug-conflicts') };
    const hold = (fp: string, code: string, at: string) => engine.writeOpCheckpointRecord('sync-hold', fp, [{ source_id: 'default', code, held_at: at, path: fp }]);
    await hold('a.md', 'invalid_fence', '2026-11-20T10:00:00.000Z');
    await hold('b.md', 'invalid_fence', '2026-11-19T10:00:00.000Z');
    await hold('c.md', 'frontmatter_slug_conflict', '2026-10-01T10:00:00.000Z');
    const some = { fences: await oldestHold(engine, 'fences'), conflicts: await oldestHold(engine, 'slug-conflicts') };
    expect({ none, some }).toEqual({
      none: { fences: null, conflicts: null },
      some: { fences: '2026-11-19T10:00:00.000Z', conflicts: '2026-10-01T10:00:00.000Z' },
    });
    return { none, some };
  });

  parityTest('a slug that names no page reads as null from getPage, not as an error', {
    methods: ['getPage', 'putPage'],
  }, async (engine) => {
    await engine.putPage('people/named-example', { type: 'person' as never, title: 'Named Example', compiled_truth: 'A named page.', timeline: '' }, { sourceId: 'default' });
    const missing = await engine.getPage('people/never-written', { sourceId: 'default' });
    const elsewhere = await engine.getPage('people/named-example', { sourceId: 'other' });
    const present = await engine.getPage('people/named-example', { sourceId: 'default' });
    const answers = { missing, elsewhere, present: { slug: present!.slug, source_path: present!.source_path ?? null } };
    expect(answers).toEqual({ missing: null, elsewhere: null, present: { slug: 'people/named-example', source_path: null } });
    return answers;
  });
});
