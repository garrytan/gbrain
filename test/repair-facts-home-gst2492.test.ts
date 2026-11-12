/**
 * GST-2492 PR 2: `gbrain repair facts-home --source <id>` gives the facts of a strict source that live in the database
 * alone a home in Git.
 *
 * 1. Protects: the preview groups every such fact and writes nothing; `--apply --expect <hash>` writes exactly the facts
 *    with no entity, or for an entity with no page, to memory/unattributed in one commit (a held row names its entity) and
 *    moves their rows in place (same ids); every other group stays as it is and is listed. A rebuild from a clone of HEAD
 *    brings the written facts back. A stale hash refuses preview_changed with the preview as its fix and the git-gap census
 *    as its verify step; a source that isn't strict lists nothing, writes nothing and says why, so the bare preview a
 *    remediation plan prints exits 0.
 * 2. Fails when: the preview writes, the apply writes a fact the preview did not list, an entity under a folder rule is
 *    named on the holding page, a written fact gets a new id or is lost on a rebuild, or a stale hash applies anything.
 * 3. Existing coverage: none for this kind; test/strict-background-writers-gst2492.test.ts covers the writers.
 * 4. Real seams: the repair runner as the CLI calls it, the maintenance publication through the write door on PGLite and
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
import { publishManagedEntityFacts } from '../src/core/facts/managed-fact-write.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const KIND = 'facts-home' as RepairKind;
const HOLD = 'memory/unattributed';
const HOLD_FILE = `${HOLD}.md`;
const logger = { info() {}, warn() {}, error() {} };
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const head = (root: string, file: string) => { try { return git(root, 'show', `HEAD:${file}`); } catch { return ''; } };
const lineOf = (text: string, claim: string) => text.split('\n').find(line => line.includes(claim)) ?? '';
const factRow = async (engine: BrainEngine, claim: string) => (await engine.executeRaw<{ id: number; entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
  `SELECT id::int AS id, entity_slug, source_markdown_slug, row_num FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL`, [claim]))[0];
const repair = async (engine: BrainEngine, opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run(KIND, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect: opts.expect }) as Promise<Record<string, any>>;
const classes = (result: { listing?: Array<{ class: string }> }) => (result.listing ?? []).map(entry => entry.class).sort();
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nNotes about ${title}.\n`;
const put = (ctx: OperationContext, slug: string, title: string) => operationsByName.put_page!.handler(ctx, { slug, content: page(title), request_id: randomUUID() });
const extracted = (claim: string) => ({ fact: claim, kind: 'fact' as const, notability: 'medium' as const, source: 'extraction 2026-11-11', visibility: 'world' as const, embedding: null, sessionId: null });
/** A database-only fact row an older gbrain left (written outside the owner's write guards, as only its publications may). */
async function unguarded(engine: BrainEngine, write: () => Promise<unknown>): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await write(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
const legacy = (engine: BrainEngine, claim: string, entity: string | null) =>
  unguarded(engine, () => engine.insertFact({ fact: claim, kind: 'fact', entity_slug: entity, visibility: 'world', source: 'legacy import' } as never, { source_id: 'default' }));

const PAGELESS = 'The kitchen remodel starts in March.';
const SUBJECTLESS = 'The quarterly offsite moved to May.';
const PAGED = 'Hana Example cycles to work.';
const UNRENDERABLE = 'Line one<br>line two of a pasted note.';
const RESTRICTED = 'The acquisition target is acme-example.';
const OLD_HELD = 'Dana Example prefers morning calls.';

/** Database-only facts written while the source was not strict, then the source made strict, plus one held row 40 days old. */
async function seeded(brain: ManagedBrain): Promise<void> {
  const { engine, ctx } = brain;
  await put(ctx, 'people/hana-example', 'Hana Example');
  await engine.executeRaw(`INSERT INTO access_policy_state(source_id) VALUES('default') ON CONFLICT DO NOTHING`);
  await engine.executeRaw(`INSERT INTO access_rules(source_id,rule_id,prefix,readable_by,revision) VALUES('default','r1','secret/',ARRAY['member:alice-example'],1)`);
  __resetPrivateVisibilityCacheForTests();
  await writeSingleFact(engine, 'default', { fact: PAGELESS, entity: 'notes/kitchen-remodel', provenance: 'chat 2026-11-11', remote: false } as never);
  await publishManagedEntityFacts(engine, 'default', null, [extracted(SUBJECTLESS)]);
  await legacy(engine, PAGED, 'people/hana-example');
  await legacy(engine, UNRENDERABLE, null);
  await legacy(engine, RESTRICTED, 'secret/project-x');
  await settleManagedGitEffects(engine);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
  await operationsByName.remember!.handler(ctx, { fact: OLD_HELD, entity: 'notes/dana-example', provenance: 'chat 2026-10-01', request_id: randomUUID() });
  await unguarded(engine, () => engine.executeRaw(`UPDATE facts SET created_at = now() - interval '40 days' WHERE fact=$1`, [OLD_HELD]));
  await put(ctx, 'people/dana-example', 'Dana Example');
  await settleManagedGitEffects(engine);
}

async function rebuild(root: string, databaseUrl: string | undefined, claims: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'gst2492-facts-home-'));
  try {
    const clone = join(home, 'content');
    git(home, 'clone', '--quiet', root, clone);
    const fresh = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await fresh.engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [clone]);
      await performSync(fresh.engine, { sourceId: 'default', repoPath: clone, noPull: true, noEmbed: true } as never);
      await runExtractFacts(fresh.engine, { sourceId: 'default' });
      const out: Record<string, string | null | undefined> = {};
      for (const claim of claims) out[claim] = (await factRow(fresh.engine, claim))?.entity_slug;
      return out;
    } finally { await fresh.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const backend of testBackends()) describe(`[${backend}] gbrain repair facts-home (GST-2492 PR 2)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const brain = (run: (brain: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl, setup: gitRepo });

  test('the preview groups every fact without a Git home and writes nothing; the apply writes exactly the homeable ones', () => brain(async b => {
    const { engine, root } = b;
    await seeded(b);
    const before = { head: git(root, 'rev-parse', 'HEAD'), pageless: await factRow(engine, PAGELESS), subjectless: await factRow(engine, SUBJECTLESS) };
    const preview = await repair(engine);
    expect(classes(preview)).toEqual(['cannot_render', 'entity_page_exists', 'entity_page_missing', 'folder_restricted', 'held_over_30_days', 'no_entity']);
    const old = preview.listing.find((entry: { class: string }) => entry.class === 'held_over_30_days');
    expect(old.detail).toContain('people/dana-example');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(await factRow(engine, PAGELESS)).toEqual(before.pageless);

    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.applied).toBe(1);
    await settleManagedGitEffects(engine);
    expect(await factRow(engine, PAGELESS)).toMatchObject({ id: before.pageless!.id, entity_slug: 'notes/kitchen-remodel', source_markdown_slug: HOLD });
    expect(await factRow(engine, SUBJECTLESS)).toMatchObject({ id: before.subjectless!.id, entity_slug: null, source_markdown_slug: HOLD });
    const file = head(root, HOLD_FILE);
    expect(lineOf(file, PAGELESS)).toContain('notes/kitchen-remodel');
    expect(lineOf(file, SUBJECTLESS)).toContain(SUBJECTLESS);
    for (const text of [PAGED, UNRENDERABLE, RESTRICTED, 'secret/project-x']) expect(file).not.toContain(text);
    expect(await factRow(engine, RESTRICTED)).toMatchObject({ row_num: null });
    expect(classes(await repair(engine))).toEqual(['cannot_render', 'entity_page_exists', 'folder_restricted', 'held_over_30_days']);
    expect(await rebuild(root, databaseUrl, [PAGELESS, SUBJECTLESS])).toEqual({ [PAGELESS]: 'notes/kitchen-remodel', [SUBJECTLESS]: null });
  }), 240_000);

  test('a stale hash refuses preview_changed with the preview as fix and the census as verify; an old hash writes only its own set', () => brain(async b => {
    const { engine, root } = b;
    await seeded(b);
    const preview = await repair(engine);
    const later = 'The porch repair needs a permit.';
    await legacy(engine, later, 'notes/porch-repair');
    const headBefore = git(root, 'rev-parse', 'HEAD');
    const refusal = await repair(engine, { apply: true, expect: 'f'.repeat(64) }).then(() => null, (error: Record<string, any>) => error);
    expect(refusal).toMatchObject({ code: 'preview_changed' });
    expect(refusal!.fix.argv).toEqual(['gbrain', 'repair', 'facts-home', '--source', 'default', '--json']);
    expect(refusal!.fix.verify.argv).toEqual(['gbrain', 'sources', 'git-gap', 'default', '--json']);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await factRow(engine, PAGELESS)).toMatchObject({ row_num: null });
    // A previewed fact edited since the preview: nothing is written.
    await unguarded(engine, () => engine.executeRaw('UPDATE facts SET confidence=0.5 WHERE fact=$1', [PAGELESS]));
    const edited = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(edited.applied).toBe(0);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await factRow(engine, SUBJECTLESS)).toMatchObject({ row_num: null });
    // A fresh preview's hash writes its own set: the later fact too.
    const again = await repair(engine);
    expect((await repair(engine, { apply: true, expect: again.preview_hash })).applied).toBe(1);
    await settleManagedGitEffects(engine);
    for (const claim of [PAGELESS, SUBJECTLESS, later]) expect(await factRow(engine, claim)).toMatchObject({ source_markdown_slug: HOLD });
  }), 240_000);

  test('with no holding page yet, the apply creates memory/unattributed in Git with the fact', () => brain(async ({ engine, root }) => {
    await legacy(engine, SUBJECTLESS, null);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    expect(head(root, HOLD_FILE)).toBe('');
    const preview = await repair(engine);
    expect(classes(preview)).toEqual(['no_entity']);
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.applied).toBe(1);
    await settleManagedGitEffects(engine);
    expect(lineOf(head(root, HOLD_FILE), SUBJECTLESS)).toContain(SUBJECTLESS);
    expect(await factRow(engine, SUBJECTLESS)).toMatchObject({ entity_slug: null, source_markdown_slug: HOLD, row_num: 1 });
  }), 120_000);

  test('a source that is not strict lists nothing, writes nothing and names the census', () => brain(async ({ engine }) => {
    await legacy(engine, SUBJECTLESS, null);
    const preview = await repair(engine);
    expect(classes(preview)).toEqual([]);
    expect(preview.warnings).toEqual([expect.stringContaining('Source default is not strict')]);
    expect(preview.details).toMatchObject({ strict: false, verify: 'gbrain sources git-gap default --json' });
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.applied).toBe(0);
    expect(await factRow(engine, SUBJECTLESS)).toMatchObject({ row_num: null, source_markdown_slug: null });
  }), 120_000);
});
