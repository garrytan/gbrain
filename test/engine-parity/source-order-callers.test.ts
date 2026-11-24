/**
 * BrainEngine parity — the callers that pick or copy sources in `default`-first, then id, order: the cycle's
 * `resolveSourceForDir` (exact path match, then the canonical-path fallback), `gbrain migrate`'s
 * `copyMigrationSources`, and the repair previews that hash the source incarnations (`gbrain repair loop-facts`
 * stands for the about 20 repair kinds that send the same read).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: two live sources registered on one path resolve to `default`, else the lowest id in byte order, on
 *    every engine and every Postgres locale; an archived source never wins; a source registered through a symlink
 *    resolves from the real path, and two such sources fail closed; the migration copy reads `default` first, then
 *    ids in byte order, on a Rust source too (readMigrationRows is a typed member the store serves); a repair preview hashes the incarnation rows in byte
 *    order, and an apply that names a hash printed in the old locale order is refused with preview_changed ("Re-run the preview").
 *  - Regression: a resolver or copy that breaks the id tie in the server locale (an en_US.utf8 Postgres then picks or
 *    copies `a0` before `a-c`, unlike PGLite); a resolver that reads sources through raw SQL (the Rust engine has none,
 *    so the cycle there derives no source from `--dir` and the freshness stamp never lands); a repair incarnation read
 *    that sorts in the server locale (the preview hash then differs between engines).
 *  - Why existing coverage misses it: test/dream-dir-source-stamp.test.ts and test/cycle-extract-source.test.ts run on
 *    PGLite only, whose C collation hides the locale tie-break, and never on the Rust engine;
 *    test/e2e/migrate-engine-sources-postgres.test.ts copies one source, so it has no tie to break; the repair tests
 *    (test/repair-*.test.ts) run one source or a C-locale database.
 *  - Seam: the migration case records the target's writes in a stub target. The source side is the real arm engine.
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveSourceForDir } from '../../src/core/cycle.ts';
import { copyMigrationSources } from '../../src/commands/migrate-engine.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { previewHash } from '../../src/core/persistence/preview-approval.ts';
import { loopFactsRepair } from '../../src/core/repair/loop-facts.ts';
import type { RepairScope } from '../../src/core/repair/core.ts';

const { parityTest } = parityArms(testBackends());

const root = mkdtempSync(join(tmpdir(), 'gbrain-parity-source-order-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const REPAIR_IDS = ['ab', 'a0', 'a-c'];
const REPAIR_SCOPE: RepairScope = { brain_id: 'host', source_ids: REPAIR_IDS };

/** The sources' incarnation rows in the given id order (one typed read per source). */
async function incarnations(engine: BrainEngine, order: string[]): Promise<Array<{ id: string; incarnation: string }>> {
  const rows: Array<{ id: string; incarnation: string }> = [];
  for (const id of order) rows.push({ id, incarnation: (await engine.readSourceIncarnation(id))!.incarnation });
  return rows;
}

/** The hash `gbrain repair loop-facts` prints for a scope with no drifted loops, over these source rows. */
function emptyLoopFactsHash(sources: Array<{ id: string; incarnation: string }>): string {
  return previewHash({ kind: 'loop-facts-v1', brain_id: 'host', sources, selection: { source_ids: REPAIR_IDS }, loops: [] });
}

describe('engine parity: callers that order sources', () => {
  parityTest('resolveSourceForDir picks default, else the lowest live id in byte order, among sources on one path', { methods: ['listAllSources'] }, async (engine, backend) => {
    const dir = join(root, `exact-${backend}`);
    for (const id of ['ab', 'a0', 'a-c']) await createSource(engine, backend, id, {}, dir);
    const tie = await resolveSourceForDir(engine, dir);
    expect(tie).toBe('a-c');
    await archiveSource(engine, backend, 'a-c');
    const afterArchive = await resolveSourceForDir(engine, dir);
    expect(afterArchive).toBe('a0');
    await createSource(engine, backend, 'zz', {}, join(root, `other-${backend}`));
    const unknown = await resolveSourceForDir(engine, join(root, `missing-${backend}`));
    expect(unknown).toBeUndefined();
    return { tie, afterArchive, unknown: unknown ?? null };
  });

  parityTest('resolveSourceForDir finds a source registered through a symlink, and fails closed on two', { methods: ['listAllSources'] }, async (engine, backend) => {
    const real = join(root, `real-${backend}`);
    mkdirSync(real, { recursive: true });
    const linkA = join(root, `link-a-${backend}`);
    const linkB = join(root, `link-b-${backend}`);
    symlinkSync(real, linkA);
    symlinkSync(real, linkB);
    await createSource(engine, backend, 'a-c', {}, linkA);
    const one = await resolveSourceForDir(engine, real);
    expect(one).toBe('a-c');
    await createSource(engine, backend, 'a0', {}, linkB);
    const two = await resolveSourceForDir(engine, real);
    expect(two).toBeUndefined();
    return { one, two: two ?? null };
  });

  parityTest('copyMigrationSources copies default first, then ids in byte order, whatever the server locale', { methods: ['readMigrationRows'] }, async (engine, backend) => {
    for (const id of ['ab', 'a0', 'a-c']) await createSource(engine, backend, id, {});
    const written: string[] = [];
    const target = {
      executeRaw: async (_sql: string, params?: unknown[]) => { written.push(String(params?.[0])); return []; },
    } as unknown as BrainEngine;
    const copied = await copyMigrationSources(engine, target);
    expect(copied).toBe(4);
    expect(written).toEqual(['default', 'a-c', 'a0', 'ab']);
    return written;
  });

  parityTest('a repair preview hashes the source incarnations in byte order, whatever the server locale', { methods: ['loopFactDrift', 'readSourceIncarnation'] }, async (engine, backend) => {
    for (const id of REPAIR_IDS) await createSource(engine, backend, id, {});
    const plan = await loopFactsRepair.plan(engine, REPAIR_SCOPE, null, { apply: false });
    const sources = await incarnations(engine, ['a-c', 'a0', 'ab']);
    expect(plan.preview_hash).toBe(emptyLoopFactsHash(sources));
    return { items: plan.items.length, ids: sources.map((row) => row.id) };
  });

  parityTest('a repair preview hash made in the old locale order is refused with preview_changed and "Re-run the preview"', { methods: ['readSourceIncarnation'] }, async (engine, backend) => {
    for (const id of REPAIR_IDS) await createSource(engine, backend, id, {});
    // The order an en_US.utf8 Postgres gave before the sort was collated: a hash printed by that preview.
    const oldHash = emptyLoopFactsHash(await incarnations(engine, ['a0', 'ab', 'a-c']));
    const refusal = await loopFactsRepair.plan(engine, REPAIR_SCOPE, null, { apply: true, expect: oldHash }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(OperationError);
    const { code, message, suggestion } = refusal as OperationError;
    expect(code).toBe('preview_changed');
    expect(message).toBe(`The preview changed since ${oldHash}; re-run gbrain repair loop-facts and use the new hash.`);
    expect(suggestion).toBe('Re-run the preview: gbrain repair loop-facts');
    return { code, message: message.replace(oldHash, '<hash>'), suggestion };
  });
});
