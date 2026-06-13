import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { formatResult, operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID, NOTE_MANIFEST_EXTRACTOR_VERSION } from '../src/core/services/note-manifest-service.ts';

test('note manifest operations are registered with CLI hints', () => {
  const get = operations.find((operation) => operation.name === 'get_note_manifest_entry');
  const list = operations.find((operation) => operation.name === 'list_note_manifest_entries');
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_manifest');

  expect(get?.cliHints?.name).toBe('manifest-get');
  expect(list?.cliHints?.name).toBe('manifest-list');
  expect(rebuild?.cliHints?.name).toBe('manifest-rebuild');
});

test('get_note_manifest_entry uses the default scope and formats a detailed view', async () => {
  const get = operations.find((operation) => operation.name === 'get_note_manifest_entry');
  if (!get) throw new Error('get_note_manifest_entry operation is missing');

  const calls: Array<Record<string, unknown>> = [];
  const result = await get.handler({
    engine: {
      getNoteManifestEntry: async (scopeId: string, slug: string) => {
        calls.push({ scopeId, slug });
        return {
          scope_id: scopeId,
          page_id: 42,
          slug,
          path: `${slug}.md`,
          page_type: 'concept',
          title: 'Note Manifest',
          frontmatter: { repo: 'meghendra6/mbrain' },
          aliases: ['Context Manifest'],
          tags: ['phase2', 'manifest'],
          outgoing_wikilinks: ['systems/mbrain'],
          outgoing_urls: ['https://example.com'],
          source_refs: ['User, direct message, 2026-04-20 09:00 AM KST'],
          heading_index: [{ slug: 'overview', text: 'Overview', depth: 1, line_start: 1 }],
          content_hash: 'a'.repeat(64),
          extractor_version: NOTE_MANIFEST_EXTRACTOR_VERSION,
          last_indexed_at: new Date('2026-04-20T10:00:00.000Z'),
        };
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    slug: 'concepts/note-manifest',
  });

  expect(calls).toEqual([{
    scopeId: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug: 'concepts/note-manifest',
  }]);

  const output = formatResult('get_note_manifest_entry', result);
  expect(output).toContain('Note Manifest');
  expect(output).toContain('Context Manifest');
  expect(output).toContain('systems/mbrain');
  expect(output).toContain('https://example.com');
  expect(output).toContain('Overview');
});

test('list_note_manifest_entries forwards filters and formats rows', async () => {
  const list = operations.find((operation) => operation.name === 'list_note_manifest_entries');
  if (!list) throw new Error('list_note_manifest_entries operation is missing');

  const calls: Array<Record<string, unknown> | undefined> = [];
  const result = await list.handler({
    engine: {
      listNoteManifestEntries: async (filters?: Record<string, unknown>) => {
        calls.push(filters);
        return [
          {
            scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
            page_id: 1,
            slug: 'concepts/note-manifest',
            path: 'concepts/note-manifest.md',
            page_type: 'concept',
            title: 'Note Manifest',
            frontmatter: {},
            aliases: ['Context Manifest'],
            tags: ['phase2', 'manifest'],
            outgoing_wikilinks: [],
            outgoing_urls: [],
            source_refs: [],
            heading_index: [],
            content_hash: 'a'.repeat(64),
            extractor_version: NOTE_MANIFEST_EXTRACTOR_VERSION,
            last_indexed_at: new Date('2026-04-20T10:00:00.000Z'),
          },
        ];
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    limit: 5,
  });

  expect(calls).toEqual([{ scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug: undefined, limit: 5 }]);
  const output = formatResult('list_note_manifest_entries', result, { limit: 5 });
  expect(output).toContain('concepts/note-manifest');
  expect(output).toContain('concept');
  expect(output).toContain('Note Manifest');
});

test('rebuild_note_manifest rebuilds a single page from canonical page state', async () => {
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_manifest');
  if (!rebuild) throw new Error('rebuild_note_manifest operation is missing');

  const calls: Array<Record<string, unknown>> = [];
  const result = await rebuild.handler({
    engine: {
      getPage: async (slug: string) => ({
        id: 7,
        slug,
        type: 'concept',
        title: 'Rebuild Target',
        compiled_truth: '# Overview\nReference [[systems/mbrain]].',
        timeline: '',
        frontmatter: { aliases: ['Rebuild Alias'] },
        content_hash: 'b'.repeat(64),
        created_at: new Date('2026-04-20T00:00:00.000Z'),
        updated_at: new Date('2026-04-20T00:05:00.000Z'),
      }),
      getTags: async () => ['phase2'],
      getNoteManifestEntry: async () => null,
      upsertNoteManifestEntry: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          ...input,
          last_indexed_at: new Date('2026-04-20T10:00:00.000Z'),
        };
      },
      markDerivedIndexReady: async () => ({
        status: 'ready',
      }),
      listDerivedJobs: async () => [],
      listPages: async () => [],
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    slug: 'concepts/rebuild-target',
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    page_id: 7,
    slug: 'concepts/rebuild-target',
    path: 'concepts/rebuild-target.md',
    tags: ['phase2'],
  });
  expect((result as any).rebuilt).toBe(1);
  expect((result as any).slugs).toEqual(['concepts/rebuild-target']);
});

test('rebuild_note_manifest marks the derived manifest state ready for deferred pages', async () => {
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_manifest');
  if (!rebuild) throw new Error('rebuild_note_manifest operation is missing');

  const dir = mkdtempSync(join(tmpdir(), 'mbrain-manifest-rebuild-state-'));
  const engine = new SQLiteEngine();
  const slug = 'concepts/deferred-manifest-rebuild';
  const manifestPath = 'imports/raw/deferred-manifest-rebuild.md';
  const content = [
    '---',
    'type: concept',
    'title: Deferred Manifest Rebuild',
    'tags: [phase2, derived]',
    '---',
    '# Overview',
    'Manual rebuild should reconcile freshness state.',
  ].join('\n');

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const imported = await importFromContent(engine, slug, content, {
      path: manifestPath,
      deferDerived: true,
    });
    expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toBeNull();
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_manifest',
    )).toMatchObject({
      status: 'pending',
      target_content_hash: imported.content_hash,
      indexed_content_hash: null,
    });

    await rebuild.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, { slug });

    expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toMatchObject({
      title: 'Deferred Manifest Rebuild',
      path: manifestPath,
      content_hash: imported.content_hash,
    });
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_manifest',
    )).toMatchObject({
      status: 'ready',
      target_content_hash: imported.content_hash,
      indexed_content_hash: imported.content_hash,
    });
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      status: 'pending',
    })).toHaveLength(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
