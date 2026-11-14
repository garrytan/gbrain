import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

interface LegacyFile { slug: string; path: string; page: string; disk?: string }

const note = (title: string, body: string) => serializeMarkdown({}, body, '', { type: 'note', title, tags: [] });

/**
 * Pages imported before the brain was managed (and before their path became a sync metafile), soft-deleted past the
 * 72-hour retention. Each file holds `disk` when given, else the page's own markdown, so the purge's comparison matches.
 * The checkout is a Git repository with no commit, so every file is uncommitted: GST-2201 keeps a committed file on purge,
 * and these tests need the purge to be allowed to remove a file so that only the #7613 metafile rule keeps one.
 */
function seedExpiredTombstones(files: LegacyFile[]) {
  return async ({ engine, root }: { engine: BrainEngine; root: string }) => {
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const file of files) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.disk ?? file.page);
      const parsed = parseMarkdown(file.page, file.slug);
      await engine.putPage(file.slug, { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth,
        timeline: parsed.timeline, frontmatter: parsed.frontmatter, source_path: file.path }, { sourceId: 'default' });
    }
    await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '4 days' WHERE source_id = 'default'");
  };
}

async function remainingSlugs(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id = 'default' ORDER BY slug");
  return rows.map(row => row.slug);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`[${backend}] #7613: purging an expired tombstone recorded at a root sync metafile keeps that file`, async () => {
    const agents = note('Agent instructions', 'Run the checks before every commit.');
    const readme = note('Topic overview', 'An overview of notes/topic.');
    const resolverPage = note('Old resolver', 'A routing table that was replaced.');
    const resolverDisk = '# Resolver\n\nThe current routing table, edited by hand.\n';
    const files: LegacyFile[] = [
      { slug: 'agents', path: 'AGENTS.md', page: agents },
      { slug: 'readme', path: 'README.md', page: readme },
      { slug: 'resolver', path: 'RESOLVER.md', page: resolverPage, disk: resolverDisk },
    ];
    await managedBrain(async ({ engine, root }) => {
      const result = await purgeDeletedPagesCoordinated(engine, 72);
      expect(['AGENTS.md', 'README.md', 'RESOLVER.md'].filter(path => !existsSync(join(root, path)))).toEqual([]);
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(agents);
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(readme);
      expect(readFileSync(join(root, 'RESOLVER.md'), 'utf8')).toBe(resolverDisk);
      expect(result.blocked).toEqual([]);
      expect([...result.slugs].sort()).toEqual(['agents', 'readme', 'resolver']);
      expect(await remainingSlugs(engine)).toEqual([]);
    }, { databaseUrl, setup: seedExpiredTombstones(files) });
  }, 120_000);

  test(`[${backend}] #7613: a nested metafile keeps its drift check and an ordinary root file is still removed`, async () => {
    const topicPage = note('Topic readme', 'What notes/topic held when it was imported.');
    const topicDisk = '# Topic\n\nEdited after the page was deleted.\n';
    const plain = note('Scratch', 'A root page that is not scaffolding.');
    const files: LegacyFile[] = [
      { slug: 'notes/topic/readme', path: 'notes/topic/README.md', page: topicPage, disk: topicDisk },
      { slug: 'scratch', path: 'scratch.md', page: plain },
    ];
    await managedBrain(async ({ engine, root }) => {
      const result = await purgeDeletedPagesCoordinated(engine, 72);
      expect(result.slugs).toEqual(['scratch']);
      expect(result.blocked).toEqual([expect.objectContaining({ slug: 'notes/topic/readme', code: 'source_changed' })]);
      expect(await remainingSlugs(engine)).toEqual(['notes/topic/readme']);
      expect(readFileSync(join(root, 'notes/topic/README.md'), 'utf8')).toBe(topicDisk);
      expect(existsSync(join(root, 'scratch.md'))).toBe(false);
    }, { databaseUrl, setup: seedExpiredTombstones(files) });
  }, 120_000);

  test(`[${backend}] #8920: a soft delete or an owner purge of a live page recorded at a root sync metafile keeps that file`, async () => {
    const agents = note('Agent instructions', 'Run the checks before every commit.');
    const readme = note('Topic overview', 'An overview of notes/topic.');
    const plain = note('Scratch', 'A root page that is not scaffolding.');
    const files: LegacyFile[] = [
      { slug: 'agents', path: 'AGENTS.md', page: agents },
      { slug: 'readme', path: 'README.md', page: readme },
      { slug: 'scratch', path: 'scratch.md', page: plain },
    ];
    const seed = seedExpiredTombstones(files);
    await managedBrain(async ({ engine, ctx, root }) => {
      const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
      const remote = { ...ctx, remote: true } as typeof ctx;
      await submitPageMutation(remote, { operation: 'delete_page', params: { slug: 'agents', source_id: 'default', request_id: randomUUID(), expected_revision: await revision('agents') } });
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'readme', source_id: 'default', purge: true, request_id: randomUUID(), expected_revision: await revision('readme') } });
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'scratch', source_id: 'default', purge: true, request_id: randomUUID(), expected_revision: await revision('scratch') } });
      await settleManagedGitEffects(engine);
      expect((await engine.readPageSnapshot('agents', { sourceId: 'default', includeDeleted: true }))?.page.deleted_at).toBeTruthy();
      expect(await remainingSlugs(engine)).toEqual(['agents']);
      expect(existsSync(join(root, 'AGENTS.md')) && readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(agents);
      expect(existsSync(join(root, 'README.md')) && readFileSync(join(root, 'README.md'), 'utf8')).toBe(readme);
      expect(existsSync(join(root, 'scratch.md'))).toBe(false);
    }, { databaseUrl, setup: async brain => { await seed(brain); await brain.engine.executeRaw("UPDATE pages SET deleted_at = NULL WHERE source_id = 'default'"); } });
  }, 120_000);
}
