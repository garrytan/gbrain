import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

test('note section operations are registered with CLI hints', () => {
  const get = operations.find((operation) => operation.name === 'get_note_section_entry');
  const list = operations.find((operation) => operation.name === 'list_note_section_entries');
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_sections');

  expect(get?.cliHints?.name).toBe('section-get');
  expect(list?.cliHints?.name).toBe('section-list');
  expect(rebuild?.cliHints?.name).toBe('section-rebuild');
});

test('rebuild_note_sections marks the derived section state ready after manual refresh', async () => {
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_sections');
  if (!rebuild) throw new Error('rebuild_note_sections operation is missing');

  const dir = mkdtempSync(join(tmpdir(), 'mbrain-section-rebuild-state-'));
  const engine = new SQLiteEngine();
  const slug = 'concepts/manual-section-rebuild';
  const manifestPath = 'imports/raw/manual-section-rebuild.md';
  const content = [
    '---',
    'type: concept',
    'title: Manual Section Rebuild',
    '---',
    '# Overview',
    'Manual section rebuild should refresh state.',
    '',
    '## Details',
    'The derived section rows are rebuilt from canonical content.',
  ].join('\n');

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const imported = await importFromContent(engine, slug, content, {
      path: manifestPath,
      deferDerived: true,
    });
    expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toBeNull();

    const rebuildManifest = operations.find((operation) => operation.name === 'rebuild_note_manifest');
    if (!rebuildManifest) throw new Error('rebuild_note_manifest operation is missing');
    await rebuildManifest.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, { slug });

    const manifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
    expect(manifest).not.toBeNull();
    expect(manifest?.path).toBe(manifestPath);

    await engine.deleteNoteSectionEntries(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
    expect(await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: slug,
    })).toHaveLength(0);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_sections',
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
    }, { page_slug: slug });

    expect(await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: slug,
    })).not.toHaveLength(0);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_sections',
    )).toMatchObject({
      status: 'ready',
      target_content_hash: imported.content_hash,
      indexed_content_hash: imported.content_hash,
    });
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_sections',
      status: 'pending',
    })).toHaveLength(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
