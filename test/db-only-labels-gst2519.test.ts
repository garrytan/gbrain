/**
 * GST-2519: privacy labels on pages under a declared `storage.db_only` dir, on PGLite and Postgres.
 *   - A strict (git-canonical) source keeps a label repair on a page whose file Git still tracks there: the sync no
 *     longer imports the unchanged file over the database row (sync-classify.ts gitVerdict).
 *   - A commit to such a file never widens its page, on strict and non-strict sources: a label the row holds and the
 *     file does not state is kept (sync-prepare.ts, label-edit.ts withStoredLabels); a label the file states applies.
 *   - A strict page stamped git_ignored (put_page under a path Git ignores, no file) takes a label repair in the
 *     database, where it lives, instead of being held canonical_file_missing (page-prepare.ts).
 * Repo-less brains never reach these paths (no checkout, no managed sync).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { conversationPage } from './helpers/conversation-page.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { OWNER, commitFiles, drainEffects, git, labels, page, repairApply, seedMembers, unboundReads } from './helpers/label-repair.ts';

const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const D = 'sources/mail-dbonly-example/', SLUG = `${D}tracked-example`, CANARY = 'canarytracked';
const IGNORED = 'sources/mail-ignored-example/', IGNORED_SLUG = `${IGNORED}put-example`;
const sync = async (engine: BrainEngine, full = false) => { await performManagedSync(engine, { ...OPTS, ...(full ? { full: true } : {}) }); await drainEffects(engine); };
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const declareDbOnly = ({ root }: { root: string }) => {
  writeFileSync(join(root, '.gitignore'), `${D}\n${IGNORED}\n`);
  writeFileSync(join(root, 'gbrain.yml'), `storage:\n  db_only:\n    - ${D}\n`);
  durableGitRepo(root, ['.gitignore', 'gbrain.yml']);
  mkdirSync(join(root, D), { recursive: true });
  writeFileSync(join(root, `${SLUG}.md`), page(SLUG, CANARY));
  commitFiles(root, [`${SLUG}.md`], 'a file committed before its folder was declared db_only');
};

for (const backend of testBackends()) describe(`[${backend}] GST-2519 labels under storage.db_only`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('strict source: a private label repair on a tracked page under storage.db_only survives every later sync', () => managedBrain(async ({ engine }) => {
    await sync(engine);
    await strict(engine);
    expect((await repairApply(engine, ['visibility', '--slug', SLUG])).applied).toBe(1);
    for (const full of [false, false, true]) {
      await sync(engine, full);
      expect((await labels(engine, SLUG))).toMatchObject({ visibility: 'private', deleted: false });
    }
    expect(await unboundReads(engine, SLUG, CANARY)).toBe(false);
  }, { databaseUrl, setup: declareDbOnly }), 180_000);

  test('strict source: a readers label repair on a tracked page under storage.db_only survives every later sync', () => managedBrain(async ({ engine }) => {
    await sync(engine);
    await strict(engine);
    await seedMembers(engine, ['assistant-example']);
    expect((await repairApply(engine, ['visibility', '--slug', SLUG, '--readers', `assistant-example,${OWNER}`])).applied).toBe(1);
    for (const full of [false, true]) {
      await sync(engine, full);
      expect((await labels(engine, SLUG))!.readable_by).toEqual(['assistant-example', OWNER]);
    }
    expect(await unboundReads(engine, SLUG, CANARY)).toBe(false);
  }, { databaseUrl, setup: declareDbOnly }), 180_000);

  for (const mode of ['strict', 'non-strict'] as const) {
    test(`${mode} source: a commit to a tracked file under storage.db_only keeps the labels the file does not state, and a label the file states applies`, () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      if (mode === 'strict') await strict(engine);
      await seedMembers(engine, ['assistant-example']);
      expect((await repairApply(engine, ['visibility', '--slug', SLUG])).applied).toBe(1);
      expect((await repairApply(engine, ['visibility', '--slug', SLUG, '--readers', `assistant-example,${OWNER}`])).applied).toBe(1);
      await sync(engine);
      // Another writer commits an edit to the file that states no label (its committed bytes never had one).
      writeFileSync(join(root, `${SLUG}.md`), page(SLUG, `${CANARY} edited upstream`));
      commitFiles(root, [`${SLUG}.md`], 'an edit that states no label');
      await sync(engine);
      const kept = await labels(engine, SLUG);
      expect(kept).toMatchObject({ visibility: 'private', readable_by: ['assistant-example', OWNER], deleted: false });
      expect((await engine.executeRaw<{ t: string }>("SELECT compiled_truth AS t FROM pages WHERE source_id='default' AND slug=$1", [SLUG]))[0]!.t).toContain('edited upstream');
      expect(await unboundReads(engine, SLUG, CANARY)).toBe(false);
      // The owner widens through the file by stating the wider label; it applies.
      writeFileSync(join(root, `${SLUG}.md`), page(SLUG, CANARY, ['visibility: world']));
      commitFiles(root, [`${SLUG}.md`], 'the owner states the wider label');
      await sync(engine);
      expect((await labels(engine, SLUG))!.visibility).toBe('world');
      expect((await labels(engine, SLUG))!.readable_by).toEqual(['assistant-example', OWNER]);
    }, { databaseUrl, setup: declareDbOnly }), 180_000);
  }

  test('strict source: a blank label line or blank lines before the fence never widen the page or move its frontmatter into the body', () => managedBrain(async ({ engine, root }) => {
    const slug = `${D}blank-example`;
    const shaped = (canary: string) => `\n\n${page(slug, canary, ['visibility:', 'tags: [alpha]'])}`;
    writeFileSync(join(root, `${slug}.md`), shaped('canaryblank'));
    commitFiles(root, [`${slug}.md`], 'a page with a blank visibility line');
    await sync(engine);
    await strict(engine);
    expect((await repairApply(engine, ['visibility', '--slug', slug])).applied).toBe(1);
    await sync(engine);
    writeFileSync(join(root, `${slug}.md`), shaped('canaryblank edited upstream'));
    commitFiles(root, [`${slug}.md`], 'a body edit that keeps the blank line');
    await sync(engine);
    expect(await labels(engine, slug)).toMatchObject({ visibility: 'private', deleted: false });
    const [row] = await engine.executeRaw<{ t: string; owner: string | null }>("SELECT compiled_truth AS t, frontmatter->>'owner_note' AS owner FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    expect(row!.owner).toBe('kept');
    expect(row!.t).not.toContain('---');
    expect(row!.t).toContain('edited upstream');
    expect(await unboundReads(engine, slug, 'canaryblank')).toBe(false);
  }, { databaseUrl, setup: declareDbOnly }), 180_000);

  test('a file over the single-string ceiling that drops a label its db_only page holds is held, and the page keeps the label', () => managedBrain(async ({ engine, root }) => {
    const slug = `${D}huge-example`;
    const huge = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 19 });
    writeFileSync(join(root, `${slug}.md`), huge.replace('---\n', '---\nvisibility: private\n'));
    commitFiles(root, [`${slug}.md`], 'a large private page');
    await sync(engine);
    expect(await labels(engine, slug)).toMatchObject({ visibility: 'private', deleted: false });
    writeFileSync(join(root, `${slug}.md`), huge);
    commitFiles(root, [`${slug}.md`], 'the same page without its label line');
    await sync(engine);
    expect(await labels(engine, slug)).toMatchObject({ visibility: 'private', deleted: false });
    const holds = (await readGitSourceHolds(engine, { sourceIds: ['default'] })).flatMap(s => s.holds);
    expect(holds.map(h => [h.path, h.code])).toEqual([[`${slug}.md`, 'visibility_noncanonical']]);
  }, { databaseUrl, setup: declareDbOnly }), 300_000);

  test('a commit to a tracked file outside storage.db_only still imports as it stands (the file is canonical there)', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/plain-example';
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, `${slug}.md`), page(slug, 'canaryplain', ['visibility: private']));
    commitFiles(root, [`${slug}.md`], 'a private note');
    await sync(engine);
    expect((await labels(engine, slug))!.visibility).toBe('private');
    writeFileSync(join(root, `${slug}.md`), page(slug, 'canaryplain'));
    commitFiles(root, [`${slug}.md`], 'the owner removes the label line');
    await sync(engine);
    expect((await labels(engine, slug))!.visibility).toBeNull();
  }, { databaseUrl, setup: declareDbOnly }), 180_000);

  test('strict source: a page stamped git_ignored takes a label repair in the database, and the label survives syncs', () => managedBrain(async ({ engine, ctx }) => {
    await sync(engine);
    await strict(engine);
    await operations.find(op => op.name === 'put_page')!.handler(ctx, { slug: IGNORED_SLUG, content: page(IGNORED_SLUG, 'canaryignored'), request_id: randomUUID(), wait_ms: 30_000 });
    await drainEffects(engine);
    expect((await engine.executeRaw<{ r: string }>("SELECT database_only_reason AS r FROM pages WHERE slug=$1", [IGNORED_SLUG]))[0]!.r).toBe('git_ignored');
    await seedMembers(engine, ['assistant-example']);
    const readers = await repairApply(engine, ['visibility', '--slug', IGNORED_SLUG, '--readers', `assistant-example,${OWNER}`]);
    expect(readers.outcome_items?.map(item => item.outcome)).toEqual(['readers_set']);
    expect(readers.applied).toBe(1);
    expect((await repairApply(engine, ['visibility', '--slug', IGNORED_SLUG])).applied).toBe(1);
    for (const full of [false, true]) {
      await sync(engine, full);
      expect(await labels(engine, IGNORED_SLUG)).toMatchObject({ visibility: 'private', readable_by: ['assistant-example', OWNER], deleted: false });
    }
    expect(await unboundReads(engine, IGNORED_SLUG, 'canaryignored')).toBe(false);
  }, { databaseUrl, setup: declareDbOnly }), 180_000);

  test('strict source: a git_ignored page whose ignore rule is gone is still held canonical_file_missing', () => managedBrain(async ({ engine, ctx, root }) => {
    await sync(engine);
    await strict(engine);
    await operations.find(op => op.name === 'put_page')!.handler(ctx, { slug: IGNORED_SLUG, content: page(IGNORED_SLUG, 'canaryignored'), request_id: randomUUID(), wait_ms: 30_000 });
    await drainEffects(engine);
    writeFileSync(join(root, '.gitignore'), `${D}\n`);
    commitFiles(root, ['.gitignore'], 'drop the ignore rule');
    const held = await repairApply(engine, ['visibility', '--slug', IGNORED_SLUG]);
    expect(held.applied).toBe(0);
    expect(held.outcome_items?.map(item => item.outcome)).toEqual(['canonical_file_missing']);
    expect(git(root, 'status', '--porcelain', '--', IGNORED).trim()).toBe('');
  }, { databaseUrl, setup: declareDbOnly }), 180_000);
});
