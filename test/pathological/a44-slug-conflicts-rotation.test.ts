/**
 * GBRA-130 A-44: \`gbrain repair slug-conflicts\` (src/core/repair/slug-conflicts.ts),
 * run by \`gbrain repair content\`, the cycle's content_repair phase and
 * \`sync unblock --apply\`, on a managed source with real
 * \`frontmatter_slug_conflict\` holds written by sync.
 *
 * Protects: a candidate whose repair fails item-scoped is recorded in
 * \`failed[]\`, a failed attempt is recorded on its hold (so
 * HOLD_ATTEMPTS_NEEDS_HUMAN escalates it), its file is untouched and the other
 * candidates are repaired; a bare apply starts after the candidate the last
 * one attempted (the fences rotation), so a poison candidate cannot sit first
 * forever; a run-scoped failure stops the run and records no attempt; a
 * systemic run (most candidates failing) records no attempt either.
 * Fails when: slug-conflicts loses the rotation (a limited run re-attempts the
 * same poison candidate every time) or records attempts from a run-scoped or
 * systemic stop.
 * Why new: test/repair-slug-conflicts.test.ts covers healthy candidates on PGLite only.
 * Seams: a test-only trigger on pages builds the poison candidate (its
 * publication fails); run-scoped errors are injected at the engine inside the
 * kind's apply.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { rotationAfter, rotationKeyOf, saveRotation } from '../../src/core/repair/rotation.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const quiet = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const file = (name: string) => '---\ntitle: Note ' + name + '\ntype: note\nslug: ghost-' + name + '\n---\nBody of ' + name + '.\n';

async function refusePages(engine: BrainEngine, slugs: string[]) {
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION pathological_refuse_page() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.slug = ANY(ARRAY[${slugs.map(s => "'" + s + "'").join(',')}]::text[]) THEN RAISE EXCEPTION 'pathological: page refused' USING ERRCODE = 'check_violation'; END IF; RETURN NEW; END $fn$`);
  await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_page ON pages');
  await engine.executeRaw('CREATE TRIGGER pathological_refuse_page BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION pathological_refuse_page()');
}

function failingInApply(engine: BrainEngine, injected: unknown): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'executeRaw' && typeof value === 'function') {
      return (...args: unknown[]) => new Error().stack?.includes('applyConflict') ? Promise.reject(injected) : (value as Function).apply(target, args);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}

/** A managed source whose \`notes/<name>.md\` files each declare a slug no page or file has: sync holds them \`frontmatter_slug_conflict\`. */
function withConflicts(names: string[], databaseUrl: string | undefined, run: (b: { engine: BrainEngine; root: string; attempts: () => Promise<Record<string, number>>;
  repair: (opts?: { limit?: number; engine?: BrainEngine }) => Promise<import('../../src/core/repair/core.ts').RepairResult> }) => Promise<void>) {
  return managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true });
    const attempts = async () => Object.fromEntries(((await readGitSourceHolds(engine, { sourceIds: [SOURCE] }))[0]?.holds ?? [])
      .filter(h => h.code === 'frontmatter_slug_conflict').map(h => [h.path, h.meta.attempts ?? 1]));
    expect(Object.keys(await attempts()).sort()).toEqual(names.map(n => 'notes/' + n + '.md'));
    const repair = async (opts: { limit?: number; engine?: BrainEngine } = {}) => {
      const runner = await repairRunner(opts.engine ?? engine, { apply: true, noEmbed: true, logger: quiet });
      return runner.run('slug-conflicts', await resolveRepairScope(engine, SOURCE), { explicit: true, sourceFlag: SOURCE, limit: opts.limit });
    };
    await run({ engine, root, attempts, repair });
  }, { databaseUrl, setup: ({ root }) => {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
    mkdirSync(join(root, 'notes'), { recursive: true });
    for (const name of names) writeFileSync(join(root, 'notes', name + '.md'), file(name));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  } });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('A-44 slug-conflicts: a poison candidate is rotated past and its hold counts the attempt (' + backend + ')', () => {
    test('item case: the poison candidate is recorded in failed[] with a hold attempt and the other candidates are repaired', () => withConflicts(['a', 'b', 'c'], databaseUrl, async ({ engine, root, attempts, repair }) => {
      await refusePages(engine, ['notes/a']);
      const before = await snapshotItems(engine, SOURCE);
      const result = await expectUnitNotAborted(() => repair());
      expect(result).toMatchObject({ applied: 2, complete: true });
      expect(result.failed.length).toBe(1);
      expectItemFailure({ key: result.failed[0]!.item, code: result.failed[0]!.reason, fix: result.failed[0]!.fix }, { key: SOURCE + ':notes/a.md', code: 'storage_error', fix: /"gbrain","repair","slug-conflicts","--source","default"/ });
      expect(await attempts()).toEqual({ 'notes/a.md': 2 });
      expect(readFileSync(join(root, 'notes', 'a.md'), 'utf8')).toBe(file('a'));
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: ['notes/b', 'notes/c'] });
    }), 120_000);

    test('rotation: a limited bare apply starts after the candidate the last one attempted', () => withConflicts(['a', 'b', 'c'], databaseUrl, async ({ engine, repair }) => {
      await refusePages(engine, ['notes/a']);
      const first = await expectUnitNotAborted(() => repair({ limit: 1 }));
      expect(first.failed.map(f => f.slug)).toEqual(['notes/a.md']);
      const second = await expectUnitNotAborted(() => repair({ limit: 1 }));
      expect(second.failed).toEqual([]);
      expect(second.outcome_items?.map(o => o.item)).toEqual([SOURCE + ':notes/b.md']);
    }), 120_000);

    test('the rotation key round-trips through op_checkpoints (jsonb refuses the NUL separator fences used, so no rotation was ever saved)', () => managedBrain(async ({ engine }) => {
      for (const op of ['fence-repair-rotation', 'slug-conflict-repair-rotation']) {
        await saveRotation(engine, op, 'brain-example', rotationKeyOf(SOURCE, 'notes/a.md'));
        expect(await rotationAfter(engine, op, 'brain-example')).toBe(rotationKeyOf(SOURCE, 'notes/a.md'));
      }
      expect(rotationKeyOf('a', 'z') < rotationKeyOf('b', 'a')).toBe(true);
    }, { databaseUrl }), 120_000);

    test('recovery case: once the cause clears, the next run repairs the poison candidate and its hold clears', () => withConflicts(['a', 'b', 'c'], databaseUrl, async ({ engine, attempts, repair }) => {
      await refusePages(engine, ['notes/a']);
      await expectUnitNotAborted(() => repair());
      await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_page ON pages');
      const before = await snapshotItems(engine, SOURCE);
      const result = await expectUnitNotAborted(() => repair());
      expect(result).toMatchObject({ applied: 1, failed: [] });
      expect(await attempts()).toEqual({});
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: ['notes/a'] });
    }), 120_000);

    for (const { name, error } of runScopedErrors()) {
      test('run case: a run-scoped ' + name + ' in a candidate\'s apply stops the run and records no attempt', () => withConflicts(['a', 'b', 'c'], databaseUrl, async ({ engine, attempts, repair }) => {
        const injected = error();
        const before = await snapshotItems(engine, SOURCE);
        const was = await attempts();
        let thrown: unknown;
        const result = await repair({ engine: failingInApply(engine, injected) }).catch(err => { thrown = err; return null; });
        if (result) {
          expect(result.stopped?.reason).toBe('owner_unavailable');
          expect(result.failed).toEqual([]);
        } else expect(thrown).toBe(injected);
        expect(await attempts()).toEqual(was);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE));
      }), 120_000);
    }

    test('breaker case: when most candidates fail the run stops item_failures_systemic and records no attempt', () => withConflicts(['a', 'b', 'c', 'd', 'e', 'f'], databaseUrl, async ({ engine, attempts, repair }) => {
      await refusePages(engine, ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e', 'notes/f']);
      const was = await attempts();
      const result = await expectUnitNotAborted(() => repair());
      expect(result.stopped?.reason).toBe('item_failures_systemic');
      expect(await attempts()).toEqual(was);
    }), 180_000);
  });
}
