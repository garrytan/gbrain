/**
 * GBRA-130 A-45: \`gbrain repair\` (the no-kind preview) and \`gbrain repair --all
 * [--apply]\` run every automatic kind in one loop (src/commands/repair.ts
 * runRepairKinds).
 *
 * Protects: a kind whose plan or apply throws item-scoped is reported as a
 * result that stops with reason \`error\`, its message and the kind's preview
 * as the fix, and every later kind still runs; the exit verdict stays 1. A
 * run-scoped failure still stops the whole command, and when most kinds fail
 * the breaker stops it with \`item_failures_systemic\`.
 * Fails when: the loop loses its per-kind catch (the first throwing kind
 * aborts every later kind and the preview of all kinds), or a run-scoped
 * error is reported as one kind's failure.
 * Why new: \`doctor --remediation-plan\` isolates kinds (remediation/repairs.ts);
 * the CLI loop had no owner.
 * Seams: stub kind specs passed as the registry, as repairRunner accepts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { afterCursor, resolveRepairScope, type RepairCursor, type RepairHandler, type RepairItem, type RepairKind } from '../../src/core/repair/core.ts';
import { repairRunner, type RepairKindSpec } from '../../src/core/repair/registry.ts';
import { repairExitVerdict, runRepairKinds } from '../../src/commands/repair.ts';
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

const KINDS: RepairKind[] = ['timeline', 'visibility', 'safe-chunks'];

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('A-45 repair --all: one throwing kind never stops the later kinds (' + backend + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => { await seed(engine, KINDS); });

    async function runAll(stubs: StubKind[], apply: boolean) {
      const registry = stubs.map(stub => stub.spec);
      const scope = await resolveRepairScope(engine);
      const runner = await repairRunner(engine, { apply, noEmbed: true, logger: quiet, registry });
      return runRepairKinds(registry.map(spec => spec.kind), scope, { apply, noEmbed: true, named: false, registry }, kind => runner.run(kind, scope));
    }

    for (const apply of [true, false]) {
      test('item case: a kind whose plan throws is listed with reason error and its preview, and the later kinds still run (' + (apply ? '--all --apply' : 'no-kind preview') + ')', async () => {
        const stubs = KINDS.map(kind => stubKind(engine, kind));
        stubs[1]!.fail.plan = () => new Error('visibility plan exploded on one row: postgres://user:secret@db.example/brain');
        const before = await snapshotItems(engine, SOURCE);
        const results = await expectUnitNotAborted(() => runAll(stubs, apply));
        expect(results.map(r => r.kind)).toEqual(KINDS);
        const failed = results[1]!;
        expectItemFailure({ key: failed.kind, code: failed.stopped?.reason, fix: failed.stopped?.fix }, { key: 'visibility', code: 'error', fix: /"gbrain","repair","visibility"/ });
        expect(failed.stopped?.message).toContain('visibility plan exploded');
        expect(JSON.stringify(results)).not.toContain('secret');
        expect(results[2]!.affected).toBe(2);
        expect(repairExitVerdict(results)).toBe(1);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), apply ? { expectProgress: slugsOf(['timeline', 'safe-chunks']), progressFields: ['content_hash'] } : {});
      });
    }

    for (const { name, error } of runScopedErrors()) {
      test('run case: a run-scoped ' + name + ' in one kind stops the whole command', async () => {
        const stubs = KINDS.map(kind => stubKind(engine, kind));
        const injected = error();
        stubs[1]!.fail.plan = () => injected;
        const before = await snapshotItems(engine, SOURCE);
        await expect(runAll(stubs, true)).rejects.toBe(injected);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { changed: slugsOf(['timeline']) });
        expect((await snapshotItems(engine, SOURCE)).get('safe-chunks/p1')).toEqual(before.get('safe-chunks/p1'));
      });
    }

    test('breaker case: when most kinds fail the command stops with item_failures_systemic', async () => {
      const kinds: RepairKind[] = ['timeline', 'visibility', 'safe-chunks', 'contextual-mode', 'request-indexes', 'orphan-bindings'];
      await seed(engine, kinds);
      const stubs = kinds.map(kind => stubKind(engine, kind));
      for (const stub of stubs) stub.fail.plan = () => new OperationError('invalid_data', 'every plan reads the same broken row');
      const error = await runAll(stubs, false).then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('item_failures_systemic');
      expect((error as OperationError).message).toContain('repair.all_kinds');
    });
  });
}
