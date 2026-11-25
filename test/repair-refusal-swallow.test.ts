/**
 * The verification reads of `gbrain repair fences` and `gbrain repair slug-conflicts` do not swallow an engine refusal.
 *
 * Protects: when the engine refuses the oldest-hold read (`readOldestSyncHoldAt`) with the typed `engine_capability_missing`
 * refusal (the Rust engine refuses a member it does not serve), both kinds' reports refuse too. Before, each report turned the
 * refusal into `oldest_hold_at: null`, so the verification said "no hold is waiting" on a brain that could not look. The
 * normal answers (no hold row: null; a hold row: its time) are pinned on every engine arm in
 * test/engine-parity/repair-hold-reads.test.ts; the named-page read of slug-conflicts is covered in
 * test/repair-slug-conflicts-sync-screen.test.ts.
 * Fails when: a report catches a refusal and answers with a default.
 * Why new: lane 8's refusal-swallow triage (docs/research/rust-refusal-swallow-triage.tsv) names these catches as swap blockers.
 * Seam: PGLite with one member swapped for the refusal, the way the Rust engine refuses a member it does not serve.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const quiet = { info() {}, warn() {}, error() {} } as never;
let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-repair-refusal-'));
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => { await resetPgliteState(engine); });

/** `engine` with the member `member` refused the way the Rust engine refuses a member it does not serve. */
function refusing(member: keyof BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === member) return async () => { throw capabilityMissing('persistence_journal', String(member)); };
      return value.bind(target);
    },
  }) as BrainEngine;
}

const run = (over: BrainEngine, kind: RepairKind) => withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () =>
  (await repairRunner(over, { apply: false, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(over), { explicit: true }));

describe('repair verification reads', () => {
  for (const kind of ['fences', 'slug-conflicts'] as const) {
    test(`${kind}: a refused oldest-hold read refuses the report, it is not answered as no hold`, async () => {
      await expect(run(refusing('readOldestSyncHoldAt'), kind)).rejects.toMatchObject({ code: 'engine_capability_missing' });
    }, 60_000);

    test(`${kind}: with the read served, a brain with no hold row reports oldest_hold_at null`, async () => {
      const result = await run(engine, kind);
      expect((result as unknown as { verification: { oldest_hold_at: unknown } }).verification.oldest_hold_at).toBeNull();
    }, 60_000);
  }
});
