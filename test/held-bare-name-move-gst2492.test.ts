/**
 * GST-2492 PR 2: a fact held under a bare name moves when the page appears under a folder.
 *
 * 1. Protects: `remember` keys a new name ("Kofi Example") as `kofi-example`, with no folder (by design, pinned in
 *    test/remember-entity-target-7248.test.ts). On a strict source that fact is held on memory/unattributed. Once the
 *    user creates `people/kofi-example`, the upkeep move resolves the bare key as `remember` would and moves the row
 *    into that page in one commit, re-keyed to it. With two pages the name could mean, the row stays held, and the
 *    doctor check and the `repair facts-home` preview name both. A held row keyed with a folder moves only to that page.
 * 2. Fails when: the held fact never moves (it stays on memory/unattributed for good), moves to one of two candidate
 *    pages by guess, keeps the bare key after the move, or a folder-keyed row moves to another page.
 * 3. Existing coverage: test/remember-strict-held-gst2492.test.ts pins the move for a row keyed by the page slug.
 * 4. Real seams: the operation handler, the extract_facts phase on a managed Git checkout, PGLite and Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { strictFactsOutsideGitEntry } from '../src/commands/doctor/checks/strict-facts-outside-git.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const head = (root: string, file: string) => { try { return git(root, 'show', `HEAD:${file}`); } catch { return ''; } };
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const remember = (ctx: OperationContext, fact: string, entity: string) => call(ctx, 'remember', { fact, entity, provenance: 'chat 2026-11-11' });
const put = (ctx: OperationContext, slug: string, title: string, type: string) =>
  call(ctx, 'put_page', { slug, content: `---\ntype: ${type}\ntitle: ${title}\n---\n\nNotes about ${title}.\n` });
const rows = (engine: BrainEngine, claim: string) => engine.executeRaw<{ id: number; entity_slug: string | null; source_markdown_slug: string | null; active: boolean }>(
  `SELECT id::int AS id, entity_slug, source_markdown_slug, (expired_at IS NULL) AS active FROM facts WHERE source_id='default' AND fact=$1 ORDER BY id`, [claim]);
const logger = { info() {}, warn() {}, error() {} };
const preview = async (engine: BrainEngine) => (await repairRunner(engine, { apply: false, logger }))
  .run('facts-home' as RepairKind, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' }) as Promise<Record<string, any>>;
const doctor = async (engine: BrainEngine) => ((await strictFactsOutsideGitEntry.run({ engine, progress: { heartbeat() {} }, args: [] } as unknown as DoctorContext)) as Array<{ name: string; status: string; message: string }>)
  .find(check => check.name === 'strict_facts_outside_git')!;

for (const backend of testBackends()) describe(`[${backend}] a fact held under a bare name moves to the page that appears under a folder (GST-2492 PR 2)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const strict = (run: (brain: ManagedBrain) => Promise<void>) => managedBrain(async brain => {
    await brain.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await run(brain);
  }, { databaseUrl, setup: gitRepo });

  test('the page people/kofi-example takes the fact held as kofi-example, re-keyed to it, in one commit', () => strict(async ({ engine, ctx, root }) => {
    const claim = 'Kofi Example parks in spot T6-3420.';
    const saved = await remember(ctx, claim, 'Kofi Example');
    expect(saved).toMatchObject({ status: 'inserted', entity_slug: 'kofi-example', page: HOLD, write_through: { written: true, held_for: 'kofi-example' } });
    await put(ctx, 'people/kofi-example', 'Kofi Example', 'person');
    await settleManagedGitEffects(engine);
    const before = Number(git(root, 'rev-list', '--count', 'HEAD').trim());
    const result = await runExtractFacts(engine, { sourceId: 'default' });
    expect(result.heldFactsMoved).toBe(1);
    await settleManagedGitEffects(engine);
    expect(Number(git(root, 'rev-list', '--count', 'HEAD').trim())).toBe(before + 1);
    // The row moved in place, re-keyed to the page. (The struck holding row projects as an expired row, as a rebuild has it.)
    expect((await rows(engine, claim)).filter(row => row.active)).toEqual([{ id: Number(saved.id), entity_slug: 'people/kofi-example', source_markdown_slug: 'people/kofi-example', active: true }]);
    expect(head(root, 'people/kofi-example.md')).toContain(claim);
    expect(head(root, `${HOLD}.md`).split('\n').find(line => line.includes(claim)) ?? '').toContain('~~');
    // Recall by the page finds it, and the next run has nothing left to move.
    expect(JSON.stringify(await call(ctx, 'recall', { entity: 'people/kofi-example' }))).toContain(claim);
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBeUndefined();
  }), 240_000);

  test('with two pages the name could mean, the fact stays held and the doctor check and the preview name both', () => strict(async ({ engine, ctx }) => {
    const claim = 'Ama Example renewed the lease for two years.';
    const saved = await remember(ctx, claim, 'Ama Example');
    expect(saved).toMatchObject({ entity_slug: 'ama-example', write_through: { held_for: 'ama-example' } });
    await put(ctx, 'people/ama-example', 'Ama Example', 'person');
    await put(ctx, 'companies/ama-example', 'Ama Example', 'company');
    const result = await runExtractFacts(engine, { sourceId: 'default' });
    expect(result.heldFactsMoved).toBeUndefined();
    const warning = result.warnings.find(w => w.startsWith('HELD_FACT_UNMOVABLE: ama-example'));
    expect(warning).toContain('entity_ambiguous: candidates companies/ama-example, people/ama-example');
    expect(await rows(engine, claim)).toEqual([{ id: Number(saved.id), entity_slug: 'ama-example', source_markdown_slug: HOLD, active: true }]);
    const check = await doctor(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('entity_ambiguous: candidates companies/ama-example, people/ama-example');
    const listed = (await preview(engine)).listing.find((entry: { item: string }) => entry.item === `default:fact ${saved.id}`);
    expect(listed).toMatchObject({ class: 'held_fact_unmovable' });
    expect(listed.detail).toContain('companies/ama-example, people/ama-example');
  }), 240_000);

  test('a held row keyed with a folder moves only to that page, as before', () => strict(async ({ engine, ctx }) => {
    const claim = 'The porch repair needs two new posts.';
    await remember(ctx, claim, 'notes/porch-repair');
    await put(ctx, 'projects/porch-repair', 'Porch Repair', 'project');
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBeUndefined();
    expect(await rows(engine, claim)).toMatchObject([{ entity_slug: 'notes/porch-repair', source_markdown_slug: HOLD, active: true }]);
    expect((await doctor(engine)).status).toBe('ok');
  }), 240_000);
});
