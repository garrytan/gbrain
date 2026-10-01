import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { renderTakesFence } from '../../src/core/takes-fence.ts';

/**
 * Legacy (pre-activation) brain content the managed migrations must adopt:
 * a file-backed entity page with a takes fence that has no `takes` rows,
 * unfenced legacy facts with vectors, a conversation-extractor fact on the
 * same page, and a page under a declared `storage.db_only` directory with
 * its own legacy fact. Seeded with
 * direct SQL before `claimWorktree` / activation, as an old binary wrote it.
 */
export const LEGACY_FILE_SLUG = 'people/alice-example';
export const LEGACY_DB_ONLY_SLUG = 'private/dana-example';
export const LEGACY_EXTRACTOR_SOURCE = 'cli:extract-conversation-facts:session-example';

export interface LegacySeed {
  legacyFactIds: number[];
  dbOnlyFactIds: number[];
  extractorFactId: number;
  takesRows: number;
}

const TAKES_BODY = renderTakesFence([
  { rowNum: 1, claim: 'Acme example raised a seed round', kind: 'fact', holder: 'world', weight: 1, sinceDate: '2026-01', source: 'press note', active: true },
  { rowNum: 2, claim: 'Widget co ships in Q4', kind: 'bet', holder: 'people/alice-example', weight: 0.7, sinceDate: '2026-03', source: 'call notes', active: true },
]);

async function embeddingLiteral(engine: BrainEngine, seed: number): Promise<string> {
  const [column] = await engine.executeRaw<{ width: number }>(
    "SELECT atttypmod::int AS width FROM pg_attribute WHERE attrelid='facts'::regclass AND attname='embedding'");
  const width = Number(column.width);
  return `[${Array.from({ length: width }, (_, i) => (i === seed ? 1 : 0)).join(',')}]`;
}

async function legacyFact(engine: BrainEngine, slug: string, fact: string, seed: number, validFrom = '2026-02-03T00:00:00Z'): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, source,
       source_session, confidence, embedding, embedded_at, embedding_model)
     VALUES ('default', $1, $2, 'fact', 'world', 'high', 'from a call', $4::timestamptz, 'mcp:put_page',
       'session-legacy', 0.9, $3::vector, '2026-02-04T00:00:00Z', 'openai:text-embedding-3-large') RETURNING id`,
    [slug, fact, await embeddingLiteral(engine, seed), validFrom]);
  return Number(row.id);
}

export async function seedLegacyManagedContent(engine: BrainEngine, root: string): Promise<LegacySeed> {
  const page = await engine.putPage(LEGACY_FILE_SLUG, { type: 'person', title: 'Alice Example',
    compiled_truth: `# Alice Example\n\nSome prose.\n\n## Takes\n\n${TAKES_BODY}` });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${LEGACY_FILE_SLUG}.md`, page.id]);
  const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
  const path = join(root, `${LEGACY_FILE_SLUG}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
  writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - private/\n');
  await engine.putPage(LEGACY_DB_ONLY_SLUG, { type: 'person', title: 'Dana Example', compiled_truth: '# Dana Example\n\nDatabase-only notes.' });

  const legacyFactIds = [
    await legacyFact(engine, LEGACY_FILE_SLUG, 'Alice example founded Acme example', 0),
    await legacyFact(engine, LEGACY_FILE_SLUG, 'Alice example moved to Lisbon', 1, '2026-02-05T13:45:12Z'),
  ];
  const dbOnlyFactIds = [await legacyFact(engine, LEGACY_DB_ONLY_SLUG, 'Dana example advises Widget co', 2)];
  const [extractor] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
       row_num, source_markdown_slug)
     VALUES ('default', $1, 'Alice example prefers morning calls', 'preference', 'private', 'medium', now(), $2, 0.8, 1, $1)
     RETURNING id`, [LEGACY_FILE_SLUG, LEGACY_EXTRACTOR_SOURCE]);
  return { legacyFactIds, dbOnlyFactIds, extractorFactId: Number(extractor.id), takesRows: 2 };
}
