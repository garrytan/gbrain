/**
 * GBRA-130 A-46: the content-repair lane runs fences, then slug-conflicts
 * (src/core/repair/content-lane.ts runContentLane), for \`gbrain repair
 * content\`, the cycle's content_repair phase and \`sync unblock --apply\`.
 *
 * Protects: a kind whose plan or apply throws item-scoped is recorded in the
 * lane's \`stopped[]\` with reason \`error\`, its message and the kind's preview,
 * and the next kind still runs and reports its own result; a run-scoped
 * failure still stops the lane.
 * Fails when: the lane loses its per-kind catch (a throw in fences means
 * slug-conflicts never runs and every outcome of the lane is lost).
 * Why new: test/repair-apply-continue-6459.test.ts covers per-item failures
 * inside one kind, not a kind that throws.
 * Seams: stub kind specs passed as the lane's registry (ContentLaneOptions.registry).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { afterCursor, resolveRepairScope, type RepairCursor, type RepairHandler, type RepairItem, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import type { RepairKindSpec } from '../../src/core/repair/registry.ts';
import { runContentLane } from '../../src/core/repair/content-lane.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const quiet = { info() {}, warn() {}, error() {} };

interface StubKind { spec: RepairKindSpec; fail: { plan?: () => unknown } }

/** A projection kind over the pages under \`<kind>/\`: each pending page is rewritten, so progress shows in its content hash. */
function stubKind(engine: BrainEngine, kind: RepairKind): StubKind {
  const stub = { fail: {} } as StubKind;
  const handler: RepairHandler = {
    kind, publication: 'projection', embeds: false,
    async plan(_engine, scope, after: RepairCursor | null) {
      if (stub.fail.plan) throw stub.fail.plan();
      const rows = await engine.executeRaw<{ id: number; slug: string }>(
        "SELECT id, slug FROM pages WHERE source_id=ANY($1::text[]) AND slug LIKE $2 AND compiled_truth LIKE 'needs repair%' AND deleted_at IS NULL ORDER BY id", [scope.source_ids, kind + '/%']);
      const items: RepairItem[] = rows.map(row => ({ cursor: { phase: 0, id: Number(row.id) }, source_id: SOURCE, slug: row.slug, chars: 1, action: 'repair' }));
      return { items: items.filter(item => afterCursor(item.cursor, after)), residuals: {} };
    },
    async apply(_ctx, item) {
      await engine.putPage(item.slug, { type: 'note', title: item.slug, compiled_truth: 'repaired ' + item.slug }, { sourceId: SOURCE, allowEmptyOverwrite: true });
      return true;
    },
  };
  stub.spec = { kind, handler, summary: 'stub', embeds: 'none', checks: [], consent: 'safe' } as unknown as RepairKindSpec;
  return stub;
}

async function seed(engine: BrainEngine, kinds: readonly string[]) {
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
  await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [SOURCE]);
  for (const kind of kinds) for (const n of [1, 2]) await engine.putPage(kind + '/p' + n, { type: 'note', title: kind + ' ' + n, compiled_truth: 'needs repair ' + n }, { sourceId: SOURCE });
}
const slugsOf = (kinds: readonly string[]) => kinds.flatMap(kind => [kind + '/p1', kind + '/p2']);

const KINDS: RepairKind[] = ['fences', 'slug-conflicts'];

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('A-46 content lane: one throwing kind never stops the next kind (' + backend + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => { await seed(engine, KINDS); });
    const lane = async (stubs: StubKind[]) => runContentLane(engine, await resolveRepairScope(engine), { apply: true, kinds: KINDS, registry: stubs.map(stub => stub.spec), logger: quiet });

    test('item case: fences throwing is recorded in stopped[] and slug-conflicts still runs and reports its result', async () => {
      const stubs = KINDS.map(kind => stubKind(engine, kind));
      stubs[0]!.fail.plan = () => new Error('fence census refused one file');
      const before = await snapshotItems(engine, SOURCE);
      const result = await expectUnitNotAborted(() => lane(stubs));
      expect(result.stopped.length).toBe(1);
      const stopped = result.stopped[0]!;
      expectItemFailure({ key: stopped.kind, code: stopped.reason, fix: stopped.fix }, { key: 'fences', code: 'error', fix: /"gbrain","repair","fences"/ });
      expect(stopped.message).toContain('fence census refused one file');
      expect(result.results.map((r: RepairResult) => r.kind)).toEqual(KINDS);
      expect(result.results[1]).toMatchObject({ kind: 'slug-conflicts', applied: 2, complete: true });
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: slugsOf(['slug-conflicts']), progressFields: ['content_hash'] });
    });

    for (const { name, error } of runScopedErrors()) {
      test('run case: a run-scoped ' + name + ' in fences stops the lane before slug-conflicts', async () => {
        const stubs = KINDS.map(kind => stubKind(engine, kind));
        const injected = error();
        stubs[0]!.fail.plan = () => injected;
        const before = await snapshotItems(engine, SOURCE);
        await expect(lane(stubs)).rejects.toBe(injected);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE));
      });
    }
  });
}
