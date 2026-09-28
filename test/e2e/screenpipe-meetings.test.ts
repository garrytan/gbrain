import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMeetings, parseOptions } from '../../scripts/screenpipe-meetings.ts';
import { importFile } from '../../src/core/import-file.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const suite = hasDatabase() ? describe : describe.skip;

suite('Screenpipe meeting notes through PostgreSQL import', () => {
  let engine: PostgresEngine;
  let directory: string;

  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', ['screenpipe-example']);
    directory = await mkdtemp(join(tmpdir(), 'screenpipe-import-e2e-'));
  }, 120_000);

  afterAll(async () => {
    try {
      await teardownDB();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  test('preserves provenance, indexes the note in the selected source, and imports once', async () => {
    const meeting = {
      id: 42, meeting_start: '2026-09-20T16:00:00Z', meeting_end: '2026-09-20T16:30:00Z',
      meeting_app: 'Video call', title: 'Planning: onboarding', attendees: 'alice-example',
      note: 'The team chose a cobalt otter mascot for the onboarding experiment.',
    };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (request.headers.get('Authorization') !== 'Bearer synthetic-example-key') {
        return new Response(null, { status: 401 });
      }
      if (new URL(request.url).pathname !== '/meetings/42') return new Response(null, { status: 404 });
      return Response.json(meeting);
    } });
    try {
      const options = parseOptions(['--api-url', server.url.origin, '--device', 'laptop-example',
        '--ids', '42', '--output', directory, '--write'], 'synthetic-example-key');
      const [file] = await exportMeetings(options);
      const relativePath = 'meetings/screenpipe/screenpipe-laptop-example-42.md';
      const imported = await importFile(engine, file.path, relativePath,
        { noEmbed: true, sourceId: 'screenpipe-example' });
      expect(imported.error).toBeUndefined();
      expect(imported.status).toBe('imported');
      const page = await engine.getPage(imported.slug, { sourceId: 'screenpipe-example' });
      expect(page?.title).toBe(meeting.title);
      expect(page?.type).toBe('meeting');
      expect(page?.frontmatter.source_id).toBe('screenpipe:laptop-example:meeting:42');
      expect(page?.compiled_truth).toContain(meeting.note);
      expect(page?.compiled_truth).toContain('screenpipe://timeline?timestamp=');
      const results = await engine.searchKeyword('cobalt otter', { sourceId: 'screenpipe-example' });
      expect(results.map(result => result.slug)).toContain(imported.slug);
      expect(await engine.getPage(imported.slug, { sourceId: 'default' })).toBeNull();
      expect((await importFile(engine, file.path, relativePath,
        { noEmbed: true, sourceId: 'screenpipe-example' })).status).toBe('skipped');
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
