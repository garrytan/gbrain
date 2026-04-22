import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importFromContent } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

test('importFromContent refreshes deterministic note-section rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-section-engine-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const content = [
      '---',
      'type: concept',
      'title: Refresh Sections',
      'tags: [phase2, sections]',
      '---',
      '# One',
      'Body',
      '',
      '## Two',
      'Nested body',
    ].join('\n');

    await importFromContent(engine, 'concepts/refresh-sections', content, {
      path: 'concepts/refresh-sections.md',
    });

    const entries = await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: 'concepts/refresh-sections',
    });

    expect(entries.map((entry) => entry.section_id)).toEqual([
      'concepts/refresh-sections#one',
      'concepts/refresh-sections#one/two',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('note section engine honors limit and offset filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-section-engine-offset-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const content = [
      '---',
      'type: concept',
      'title: Refresh Sections',
      '---',
      '# One',
      'Body',
      '',
      '# Two',
      'Body',
    ].join('\n');

    await importFromContent(engine, 'concepts/refresh-sections-offset', content, {
      path: 'concepts/refresh-sections-offset.md',
    });

    const first = await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: 'concepts/refresh-sections-offset',
      limit: 1,
      offset: 0,
    });
    const second = await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: 'concepts/refresh-sections-offset',
      limit: 1,
      offset: 1,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.section_id).not.toBe(second[0]?.section_id);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
