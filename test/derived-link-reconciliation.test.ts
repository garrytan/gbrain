import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

async function seed(slug: string, sourceId = 'default'): Promise<void> {
  await engine.putPage(slug, {
    type: slug.startsWith('people/') ? 'person' : slug.startsWith('companies/') ? 'company' : 'note',
    title: slug,
    compiled_truth: `${slug} fixture`,
    timeline: '',
  }, { sourceId });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('other', 'other', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

describe('reconcileDerivedLinks', () => {
  test('frontmatter cleanup preserves manual and other-origin edges', async () => {
    await seed('companies/acme-example');
    await seed('people/alice-example');
    await seed('notes/other-author');

    const authored = {
      from_slug: 'people/alice-example',
      to_slug: 'companies/acme-example',
      link_type: 'works_at',
      context: 'key_people: Alice Example',
      link_source: 'frontmatter',
      origin_slug: 'companies/acme-example',
      origin_field: 'key_people',
    };
    await engine.reconcileDerivedLinks('companies/acme-example', [authored], { sourceId: 'default' });
    await engine.reconcileDerivedLinks('notes/other-author', [{
      ...authored,
      context: 'related_people: Alice Example',
      origin_slug: 'notes/other-author',
      origin_field: 'related_people',
    }], { sourceId: 'default' });
    await engine.addLink(
      'people/alice-example',
      'companies/acme-example',
      'operator-curated relationship',
      'works_at',
      'manual',
    );

    const result = await engine.reconcileDerivedLinks(
      'companies/acme-example',
      [],
      { sourceId: 'default' },
    );
    expect(result).toEqual({ created: 0, removed: 1 });

    const remaining = (await engine.getBacklinks('companies/acme-example', { sourceId: 'default' }))
      .map((link) => ({
        source: link.link_source,
        origin: link.origin_slug ?? null,
        context: link.context,
      }))
      .sort((a, b) => `${a.source}:${a.origin}`.localeCompare(`${b.source}:${b.origin}`));
    expect(remaining).toEqual([
      {
        source: 'frontmatter',
        origin: 'notes/other-author',
        context: 'related_people: Alice Example',
      },
      {
        source: 'manual',
        origin: null,
        context: 'operator-curated relationship',
      },
    ]);
  });

  test('same slug in another source is outside the reconciliation partition', async () => {
    for (const sourceId of ['default', 'other']) {
      await seed('notes/source-scoped-writer', sourceId);
      await seed('concepts/source-scoped-target', sourceId);
      await engine.reconcileDerivedLinks('notes/source-scoped-writer', [{
        from_slug: 'notes/source-scoped-writer',
        to_slug: 'concepts/source-scoped-target',
        link_type: 'related',
        context: `${sourceId} context`,
        link_source: 'markdown',
        from_source_id: sourceId,
        to_source_id: sourceId,
      }], { sourceId });
    }

    await engine.reconcileDerivedLinks('notes/source-scoped-writer', [], { sourceId: 'default' });

    expect(await engine.getLinks('notes/source-scoped-writer', { sourceId: 'default' })).toEqual([]);
    expect(await engine.getLinks('notes/source-scoped-writer', { sourceId: 'other' }))
      .toEqual([expect.objectContaining({
        from_source_id: 'other',
        to_source_id: 'other',
        context: 'other context',
      })]);
  });

  test('surviving desired rows refresh their extracted context', async () => {
    await seed('notes/context-writer');
    await seed('concepts/context-target');
    const desired = {
      from_slug: 'notes/context-writer',
      to_slug: 'concepts/context-target',
      link_type: 'related',
      context: 'old excerpt',
      link_source: 'markdown',
      origin_slug: 'notes/misleading-origin',
      origin_field: 'misleading_field',
      origin_source_id: 'other',
    };
    expect(await engine.reconcileDerivedLinks('notes/context-writer', [desired], { sourceId: 'default' }))
      .toEqual({ created: 1, removed: 0 });
    expect(await engine.reconcileDerivedLinks(
      'notes/context-writer',
      [{ ...desired, context: 'new excerpt' }],
      { sourceId: 'default' },
    )).toEqual({ created: 0, removed: 0 });

    expect(await engine.getLinks('notes/context-writer', { sourceId: 'default' }))
      .toEqual([expect.objectContaining({
        context: 'new excerpt',
        origin_slug: null,
        origin_field: null,
      })]);
  });

  test('revision-fenced reconciliation refuses a stale snapshot and stamps a current one', async () => {
    await seed('notes/revision-writer');
    await seed('concepts/revision-a');
    await seed('concepts/revision-b');
    await engine.reconcileDerivedLinks('notes/revision-writer', [{
      from_slug: 'notes/revision-writer',
      to_slug: 'concepts/revision-a',
      link_type: 'related',
      context: 'revision A',
      link_source: 'markdown',
    }], { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages
          SET updated_at = '2026-08-20T00:00:02.123456Z', links_extracted_at = NULL
        WHERE source_id = 'default' AND slug = 'notes/revision-writer'`,
    );

    const desiredB = [{
      from_slug: 'notes/revision-writer',
      to_slug: 'concepts/revision-b',
      link_type: 'related',
      context: 'revision B',
      link_source: 'markdown',
    }];
    const staleOpts = {
      sourceId: 'default',
      expectedUpdatedAt: '2026-08-20T00:00:01.123456Z',
      stampExtractedAt: '2026-08-20T00:00:01.123456Z',
      timelineEntries: [{
        slug: 'notes/revision-writer', date: '2026-08-19', summary: 'stale event', source_id: 'default',
      }],
    };
    expect(await engine.reconcileDerivedLinks('notes/revision-writer', desiredB, staleOpts))
      .toEqual({ created: 0, removed: 0, timelineCreated: 0, applied: false });
    expect((await engine.getLinks('notes/revision-writer')).map((link) => link.to_slug))
      .toEqual(['concepts/revision-a']);

    const unstamped = await engine.executeRaw<{ links_extracted_at: string | null }>(
      `SELECT links_extracted_at FROM pages
        WHERE source_id = 'default' AND slug = 'notes/revision-writer'`,
    );
    expect(unstamped[0]?.links_extracted_at).toBeNull();

    const currentOpts = {
      sourceId: 'default',
      expectedUpdatedAt: '2026-08-20T00:00:02.123456Z',
      stampExtractedAt: '2026-08-20T00:00:02.123456Z',
      timelineEntries: [{
        slug: 'notes/revision-writer', date: '2026-08-20', summary: 'current event', source_id: 'default',
      }],
    };
    expect(await engine.reconcileDerivedLinks('notes/revision-writer', desiredB, currentOpts))
      .toEqual({ created: 1, removed: 1, timelineCreated: 1, applied: true });
    expect((await engine.getLinks('notes/revision-writer')).map((link) => link.to_slug))
      .toEqual(['concepts/revision-b']);
    const stamped = await engine.executeRaw<{ fresh: boolean }>(
      `SELECT links_extracted_at = updated_at AS fresh FROM pages
        WHERE source_id = 'default' AND slug = 'notes/revision-writer'`,
    );
    expect(stamped[0]?.fresh).toBe(true);
    expect((await engine.getTimeline('notes/revision-writer')).map((entry) => entry.summary))
      .toEqual(['current event']);
  });
});
