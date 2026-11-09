import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

interface LegacyFile { slug: string; path: string; page: string; disk?: string }

const note = (title: string, body: string) => serializeMarkdown({}, body, '', { type: 'note', title, tags: [] });

/**
 * Pages imported before the brain was managed (and before their path became a sync metafile), soft-deleted past the
 * 72-hour retention. Each file holds `disk` when given, else the page's own markdown, so the purge's comparison matches.
 */
function seedExpiredTombstones(files: LegacyFile[]) {
  return async ({ engine, root }: { engine: BrainEngine; root: string }) => {
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
}
