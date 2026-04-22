import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  buildStructuralGraphSnapshot,
  findStructuralPath,
  getStructuralNeighbors,
} from '../src/core/services/note-structural-graph-service.ts';

test('structural graph service derives deterministic neighbors and paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-structural-graph-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'See [[concepts/note-manifest]].',
      '',
      '## Runtime',
      'Details',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const graph = await buildStructuralGraphSnapshot(engine);
    const neighbors = await getStructuralNeighbors(engine, 'page:systems/mbrain');
    const path = await findStructuralPath(engine, 'page:systems/mbrain', 'page:concepts/note-manifest');

    expect(graph.nodes.map((node) => node.node_id)).toContain('page:systems/mbrain');
    expect(neighbors.some((edge) => edge.edge_kind === 'page_contains_section')).toBe(true);
    expect(path?.node_ids).toEqual([
      'page:systems/mbrain',
      'section:systems/mbrain#overview',
      'page:concepts/note-manifest',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structural graph service paginates manifests beyond 10_000 rows', async () => {
  const manifests = Array.from({ length: 10_001 }, (_, index) => ({
    scope_id: 'workspace:default',
    page_id: index + 1,
    slug: `concepts/page-${index}`,
    path: `concepts/page-${index}.md`,
    page_type: 'concept',
    title: `Page ${index}`,
    frontmatter: {},
    aliases: [],
    tags: [],
    outgoing_wikilinks: [],
    outgoing_urls: [],
    source_refs: [],
    heading_index: [],
    content_hash: `hash-${index}`,
    extractor_version: 'phase2-structural-v1',
    last_indexed_at: new Date(0),
  }));

  const graph = await buildStructuralGraphSnapshot({
    listNoteManifestEntries: async (filters?: any) => {
      const offset = filters?.offset ?? 0;
      const limit = filters?.limit ?? manifests.length;
      return manifests.slice(offset, offset + limit);
    },
    listNoteSectionEntries: async () => [],
  } as any);

  expect(graph.nodes).toHaveLength(10_001);
  expect(graph.nodes.at(-1)?.node_id).toBe('page:concepts/page-9999');
});
