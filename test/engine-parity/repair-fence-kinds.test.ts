/**
 * BrainEngine parity — `gbrain repair fences` and `gbrain repair slug-conflicts` through `runRepair` (batch 9).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with a page whose facts fence is broken, both previews answer the same on PGLite, Postgres and
 *    Rust: fences lists the page as held for a model repair no measured model can make (`no_measured_model`), and
 *    slug-conflicts finds no held or conflicting file. A page whose fence the free tier can mend (a missing end marker and
 *    an invented kind) previews as one deterministic repair, applies with the preview hash on a database-only source
 *    (a revision-bound page write, no model), stores a fence that parses with no warning, and a second preview finds
 *    nothing left; a mendable file of a legacy checkout source is backed up, rewritten and imported the same way. On Rust the
 *    database-only apply ends on the typed refusal of the page publication's fence guard (trust/fence-guard.ts raw
 *    statements, a facts-lane gap): the write stays queued and the repair stops at repair/settle.ts. The census, the fence scan records and the daily budget ledger day read through typed members
 *    (engine-sql/fence-census.ts), so neither kind stops at plan entry on the Rust engine any more.
 *  - Regression: the Rust engine stopped both kinds at plan entry ("repair fences census") because those members were not
 *    on this branch; before that it refused them at `executeRaw` in the middle of the preview, with no name.
 *  - Why existing coverage misses it: test/repair-fences*.test.ts and test/repair-slug-conflicts*.test.ts run on PGLite and
 *    Postgres only.
 *  - Seam: none. Generated values are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } }).replace(/\b[0-9a-f]{64}\b/g, '<sha256>')
    // The census scan stamps its own clock.
    .replace(/"fresh_at":"[^"]*"/g, '"fresh_at":"<time>"')
    // A legacy repair backs the file up under the run's own home and clock.
    .replace(/"backup":"[^"]*"/g, '"backup":"<path>"'));
}

const runKind = async (engine: BrainEngine, kind: RepairKind) =>
  (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true });

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-b9-home-'));
  try {
    // A write the engine cannot publish stays queued; a short wait ends an apply on that refusal at once.
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_WRITE_WAIT_MS: '3000', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const BROKEN = 'Body.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim |\n|---|\n| x | broken\n<!--- gbrain:facts:end -->\n';

async function seedBrokenFence(engine: BrainEngine) {
  await engine.putPage('notes/broken-fence', { type: 'note' as never, title: 'broken fence', compiled_truth: BROKEN, timeline: '' }, { sourceId: 'default' });
}

/** A fence the free tier mends: no end marker and an invented kind (test/repair-fences.test.ts `fixable`). */
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const FIXABLE = `Body.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n${FH}\n| 1 | Synthetic vendor partnership | partnership | 0.9 | private | high | 2026-01-01 |  | chat |  |\n`;

const apply = async (engine: BrainEngine, expectHash: string) =>
  (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('fences', await resolveRepairScope(engine),
    { explicit: true, remote: false, expect: expectHash } as never);

describe('engine parity: the fence repair kinds of batch 9', () => {
  for (const kind of ['fences', 'slug-conflicts'] as const) {
    parityTest(`${kind} previews a brain with a broken facts fence the same way on every engine`, {
      methods: ['putPage'], timeout: 60_000,
    }, async engine => withHome(async () => {
      await seedBrokenFence(engine);
      const previewed = await runKind(engine, kind);
      if (kind === 'fences') expect(previewed.residuals).toEqual({ no_measured_model: 1 });
      else expect(previewed.affected).toBe(0);
      return shape(previewed);
    }));
  }

  for (const kind of ['fences', 'slug-conflicts'] as const) {
    parityTest(`${kind} previews a checkout file with a mendable fence on a legacy source the same way on every engine`, {
      methods: ['readOldestSyncHoldAt'], timeout: 120_000,
    }, async (engine, backend) => withHome(async () => {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-repair-b9-root-'));
      try {
        mkdirSync(join(root, 'notes'), { recursive: true });
        writeFileSync(join(root, 'notes', 'legacy-fence.md'), `---\ntitle: legacy fence\n---\n${FIXABLE}`);
        await createSource(engine, backend, 'legacy', {}, root);
        const scope = await resolveRepairScope(engine, 'legacy');
        const previewed = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true, sourceFlag: 'legacy' } as never);
        if (kind === 'fences') expect((previewed.details as { counts: unknown }).counts).toEqual({ deterministic: 1, resolver: 0, llm: 0, held: 0 });
        else expect(previewed.affected).toBe(0);
        return shape(previewed);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }));
  }

  parityTest('fences repairs a checkout file on a legacy source with no model: the file is rewritten, imported, and a second preview finds nothing', {
    methods: ['getPage'], timeout: 120_000,
  }, async (engine, backend) => withHome(async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-repair-b9-root-'));
    try {
      mkdirSync(join(root, 'notes'), { recursive: true });
      writeFileSync(join(root, 'notes', 'legacy-fence.md'), `---\ntitle: legacy fence\n---\n${FIXABLE}`);
      await createSource(engine, backend, 'legacy', {}, root);
      const scope = await resolveRepairScope(engine, 'legacy');
      const run = async (opts: { apply: boolean; expect?: string }) => (await repairRunner(engine, { apply: opts.apply, noEmbed: true, logger: quiet }))
        .run('fences', scope, { explicit: true, remote: false, sourceFlag: 'legacy', ...(opts.expect ? { expect: opts.expect } : {}) } as never)
        ;
      const previewed = await run({ apply: false });
      expect(previewed.affected).toBe(1);
      const applied = await run({ apply: true, expect: previewed.preview_hash! });
      expect(applied.applied).toBe(1);
      expect(applied.outcome_items![0]!.detail).toMatchObject({ mode: 'legacy', tier: 'deterministic' });
      const file = readFileSync(join(root, 'notes', 'legacy-fence.md'), 'utf8');
      expect(parseFactsFence(file).warnings).toEqual([]);
      const stored = await engine.getPage('legacy-fence', { sourceId: 'legacy' }) ?? await engine.getPage('notes/legacy-fence', { sourceId: 'legacy' });
      const again = await run({ apply: false });
      expect(again.affected).toBe(0);
      return { previewed: shape(previewed), applied: shape(applied), file, stored: stored ? parseFactsFence(stored.compiled_truth).facts.map(f => f.claim) : null, again: shape(again) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

  parityTest('fences repairs a fence the free tier can mend on a database-only page, with no model, and a second preview finds nothing', {
    methods: ['putPage', 'getPage'], timeout: 120_000,
  }, async (engine, backend) => withHome(async () => {
    await engine.putPage('notes/mendable-fence', { type: 'note' as never, title: 'mendable fence', compiled_truth: FIXABLE, timeline: '' }, { sourceId: 'default' });
    const previewed = await runKind(engine, 'fences');
    expect(previewed.affected).toBe(1);
    expect((previewed.details as { counts: unknown }).counts).toEqual({ deterministic: 1, resolver: 0, llm: 0, held: 0 });
    let applied: RepairResult;
    try {
      applied = await apply(engine, previewed.preview_hash!);
    } catch (err) {
      // The one named stop: the page publication refuses at the facts-fence guard. The write is claimed three times and then ends
      // failed with the typed raw_sql refusal (coordinator.ts, PUBLICATION_CAPABILITY_ATTEMPTS), or the settle step reports it queued.
      if (backend === 'rust') expect(JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail })).toMatch(/repair write publication|member=executeRaw capability=raw_sql/);
      throw err;
    }
    expect(applied.applied).toBe(1);
    expect(applied.outcome_items![0]!.detail).toMatchObject({ mode: 'db', slug: 'notes/mendable-fence', tier: 'deterministic' });
    const stored = await engine.getPage('notes/mendable-fence', { sourceId: 'default' });
    expect(parseFactsFence(stored!.compiled_truth).warnings).toEqual([]);
    expect(parseFactsFence(stored!.compiled_truth).facts.map(f => f.claim)).toEqual(['Synthetic vendor partnership']);
    const again = await runKind(engine, 'fences');
    expect(again.affected).toBe(0);
    return { previewed: shape(previewed), applied: shape(applied), body: stored!.compiled_truth, again: shape(again) };
  }));
});
