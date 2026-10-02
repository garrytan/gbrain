import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { exportContext, parseContextOptions } from '../../scripts/screenpipe-context.ts';
import { importFile } from '../../src/core/import-file.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const suite = hasDatabase() ? describe : describe.skip;
suite('Screenpipe activity and processed knowledge through PostgreSQL', () => {
  let engine: PostgresEngine;
  let directory: string;
  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', ['screenpipe-example']);
    directory = await mkdtemp(join(tmpdir(), 'screenpipe-context-e2e-'));
  }, 120_000);
  afterAll(async () => {
    try { await teardownDB(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  });

  test('retrieves screen evidence, saved knowledge, a workflow and inert skill/agent references in the selected source', async () => {
    const at = '2026-09-20T16:00:00Z';
    await writeFile(join(directory, 'SKILL.md'), '---\nname: release-review\n---\n\nCheck the cobalt otter release checklist.');
    await writeFile(join(directory, 'agent.md'), 'Cobalt otter release failed its dry run. Retry after fixing the package.');
    const artifacts = ['skill', 'agent-output'].map((kind, index) => ({
      id: `release-${index}`, kind, path: index ? 'agent.md' : 'SKILL.md', title: `Release ${kind}`, version: '1',
      producer: 'example-agent', generated_at: at, status: index ? 'failed' : 'reviewed', sources: ['screenpipe:laptop-example:screen:42'],
    }));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, artifacts }));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (request.headers.get('Authorization') !== 'Bearer synthetic-example-key') return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === '/workflows/release') return Response.json({ id: 'release', analyzedAt: at,
        workflow: { title: 'Release procedure', stages: [{ title: 'Check cobalt otter artifact', screenshot: { frameId: 42, timestamp: at } }] } });
      if (url.searchParams.get('offset') !== '0') return Response.json({ data: [] });
      const type = url.searchParams.get('content_type');
      const row = type === 'ocr' ? { type: 'OCR', content: { frame_id: 42, text: 'Cobalt otter release checklist on screen.',
        timestamp: at, app_name: 'Editor', window_name: 'Release', text_source: 'accessibility' } }
        : type === 'audio' ? { type: 'Audio', content: { chunk_id: 9, offset_index: 0, timestamp: at,
          transcription: 'We need to review the cobalt otter checklist.', device_name: 'Mic' } }
        : { type: 'Memory', content: { id: 7, content: 'Cobalt otter requires a dry run.', source: 'example-agent',
          tags: ['release'], created_at: at, updated_at: at, source_context: { frame_ids: [42] } } };
      return Response.json({ data: [row], pagination: { limit: Number(url.searchParams.get('limit')), offset: 0, total: 1 } });
    } });
    try {
      const options = parseContextOptions(['--api-url', server.url.origin, '--device', 'laptop-example',
        '--start', at, '--end', '2026-09-20T17:00:00Z', '--types', 'screen,audio,memory', '--workflow-ids', 'release',
        '--artifacts', join(directory, 'manifest.json'), '--output', join(directory, 'staged'), '--write'], 'synthetic-example-key');
      const files = await exportContext(options);
      expect(files).toHaveLength(6);
      const slugs: string[] = [];
      for (const file of files) {
        const relative = `context/screenpipe/${basename(file.path)}`;
        const imported = await importFile(engine, file.path, relative, { noEmbed: true, sourceId: 'screenpipe-example' });
        expect(imported.error).toBeUndefined();
        expect(imported.status).toBe('imported');
        slugs.push(imported.slug);
        const page = await engine.getPage(imported.slug, { sourceId: 'screenpipe-example' });
        expect(page?.type).toBe('note');
        expect(page?.frontmatter.visibility).toBe('private');
        expect(page?.frontmatter.source_id).toBe(file.id);
        if (file.id.toString().includes('artifact-agent-output')) expect(page?.frontmatter.declared_status).toBe('failed');
        if (file.id.toString().includes('artifact-skill')) expect(page?.frontmatter.artifact_version).toBe('1');
        expect(await engine.getPage(imported.slug, { sourceId: 'default' })).toBeNull();
        expect((await importFile(engine, file.path, relative, { noEmbed: true, sourceId: 'screenpipe-example' })).status).toBe('skipped');
      }
      const hits = await engine.searchKeyword('cobalt otter', { sourceId: 'screenpipe-example', limit: 20 });
      expect(hits.map(hit => hit.slug).sort()).toEqual(slugs.sort());
      expect(await engine.searchKeyword('cobalt otter', { sourceId: 'default' })).toEqual([]);
    } finally { server.stop(true); }
  }, 60_000);
});
