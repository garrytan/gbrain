/**
 * GST-2492 PR 2, review findings on the held facts of memory/unattributed.
 *
 * 1. Protects: the same claim held for two entities stays two rows (the Facts table, the extract_facts upkeep step and a
 *    rebuild keep both); `gbrain repair facts-home` writes two such facts in one apply; a fact whose entity page is
 *    soft-deleted is never written to the world-readable holding page, by the repair or by a writer, and the repair lists
 *    it as `entity_page_deleted`.
 * 2. Fails when: one of two same-claim held rows is expired or never written, the repair's apply never lands because two
 *    facts share a claim, or a soft-deleted (possibly private) page's fact is named on memory/unattributed, where its purge
 *    would not reach it.
 * 3. Existing coverage: test/repair-facts-home-gst2492.test.ts and test/strict-background-writers-gst2492.test.ts cover one
 *    fact per claim and live pages only.
 * 4. Real seams: writeSingleFact, the extract_facts phase and the repair runner through the write door on PGLite and
 *    Postgres (DATABASE_URL), a managed Git checkout, and a rebuild of a fresh database from a clone of HEAD.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD_FILE = 'memory/unattributed.md';
const logger = { info() {}, warn() {}, error() {} };
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const head = (root: string, file: string) => { try { return git(root, 'show', `HEAD:${file}`); } catch { return ''; } };
const linesOf = (text: string, claim: string) => text.split('\n').filter(line => line.includes(claim));
const active = (engine: BrainEngine, claim: string) => engine.executeRaw<{ entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
  `SELECT entity_slug, source_markdown_slug, row_num FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL ORDER BY entity_slug`, [claim]);
const repair = async (engine: BrainEngine, opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run('facts-home' as RepairKind, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect: opts.expect }) as Promise<Record<string, any>>;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
async function unguarded(engine: BrainEngine, write: () => Promise<unknown>): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await write(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
const legacy = (engine: BrainEngine, claim: string, entity: string | null) =>
  unguarded(engine, () => engine.insertFact({ fact: claim, kind: 'fact', entity_slug: entity, visibility: 'world', source: 'legacy import' } as never, { source_id: 'default' }));
const classes = (result: { listing?: Array<{ class: string }> }) => (result.listing ?? []).map(entry => entry.class);

async function rebuilt(root: string, databaseUrl: string | undefined, claim: string) {
  const home = mkdtempSync(join(tmpdir(), 'gst2492-review-'));
  try {
    const clone = join(home, 'content');
    git(home, 'clone', '--quiet', root, clone);
    const fresh = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await fresh.engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [clone]);
      await performSync(fresh.engine, { sourceId: 'default', repoPath: clone, noPull: true, noEmbed: true } as never);
      await runExtractFacts(fresh.engine, { sourceId: 'default' });
      return (await active(fresh.engine, claim)).map(row => row.entity_slug);
    } finally { await fresh.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** A private entity page with a database-only fact, then the source made strict and the page soft-deleted. */
async function deletedPrivatePage({ engine, ctx }: ManagedBrain, claim: string): Promise<void> {
  await call(ctx, 'put_page', { slug: 'people/alice-example', content: '---\ntype: person\ntitle: Alice Example\nvisibility: private\n---\n\nPrivate notes.\n' });
  await settleManagedGitEffects(engine);
  await legacy(engine, claim, 'people/alice-example');
  await strict(engine);
  const snapshot = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
  await call(ctx, 'delete_page', { slug: 'people/alice-example', expected_revision: snapshot!.revision });
  await settleManagedGitEffects(engine);
}

for (const backend of testBackends()) describe(`[${backend}] held facts on memory/unattributed, review findings (GST-2492 PR 2)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const brain = (run: (brain: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl, setup: gitRepo });

  test('the same claim held for two entities stays two rows through extract_facts and a rebuild', () => brain(async ({ engine, root }) => {
    await strict(engine);
    const claim = 'Prefers email over phone calls.';
    for (const entity of ['notes/alice-example', 'notes/bob-example']) {
      await writeSingleFact(engine, 'default', { fact: claim, provenance: 'chat 2026-11-11', entity, visibility: 'world', remote: false } as never);
      await settleManagedGitEffects(engine);
    }
    expect(linesOf(head(root, HOLD_FILE), claim)).toHaveLength(2);
    await runExtractFacts(engine, { sourceId: 'default' });
    await settleManagedGitEffects(engine);
    expect((await active(engine, claim)).map(row => row.entity_slug)).toEqual(['notes/alice-example', 'notes/bob-example']);
    expect(await rebuilt(root, databaseUrl, claim)).toEqual(['notes/alice-example', 'notes/bob-example']);
  }), 240_000);

  test('the repair writes two facts that share a claim in one apply', () => brain(async ({ engine, root }) => {
    const claim = 'Lives near the harbor.';
    for (const entity of ['notes/carol-example', 'notes/dave-example']) await legacy(engine, claim, entity);
    await strict(engine);
    const preview = await repair(engine);
    expect(classes(preview)).toEqual(['entity_page_missing', 'entity_page_missing']);
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.applied).toBe(1);
    await settleManagedGitEffects(engine);
    expect(linesOf(head(root, HOLD_FILE), claim)).toHaveLength(2);
    expect((await active(engine, claim)).map(row => [row.entity_slug, row.source_markdown_slug])).toEqual(
      [['notes/carol-example', 'memory/unattributed'], ['notes/dave-example', 'memory/unattributed']]);
    expect(classes(await repair(engine))).toEqual([]);
  }), 240_000);

  test('a fact whose entity page is soft-deleted is listed entity_page_deleted and never written to the holding page', () => brain(async b => {
    const { engine, root } = b;
    const claim = 'Alice Example is negotiating a severance package.';
    await deletedPrivatePage(b, claim);
    const preview = await repair(engine);
    expect(classes(preview)).toEqual(['entity_page_deleted']);
    await repair(engine, { apply: true, expect: preview.preview_hash }).catch(() => null);
    await settleManagedGitEffects(engine);
    expect(head(root, HOLD_FILE)).not.toContain(claim);
    expect(await active(engine, claim)).toEqual([{ entity_slug: 'people/alice-example', source_markdown_slug: null, row_num: null }]);

    const later = 'Alice Example moved to the Lisbon office.';
    await writeSingleFact(engine, 'default', { fact: later, provenance: 'chat 2026-11-11', entity: 'people/alice-example', visibility: 'world', remote: false } as never).catch(() => null);
    await settleManagedGitEffects(engine);
    expect(head(root, HOLD_FILE)).not.toContain(later);
    expect(head(root, HOLD_FILE)).not.toContain('people/alice-example');
  }), 240_000);
});
