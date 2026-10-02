import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportContext, parseContextOptions } from '../scripts/screenpipe-context.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

const start = '2026-09-20T16:00:00Z';
const end = '2026-09-20T17:00:00Z';
const screen = { type: 'OCR', content: { frame_id: 42, text: 'Cobalt otter deployment checklist', timestamp: start,
  app_name: 'Editor', window_name: 'Checklist', browser_url: 'https://example.com/checklist', text_source: 'accessibility', event_source: 'typing_pause' } };
const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function searchResponse(url: URL, data: unknown[], total: number) {
  return Response.json({ data, pagination: { limit: Number(url.searchParams.get('limit')), offset: Number(url.searchParams.get('offset')), total } });
}
async function fixture(handler: (url: URL) => Response = url => searchResponse(url, [screen], 1)) {
  const directory = await mkdtemp(join(tmpdir(), 'screenpipe-context-test-'));
  directories.push(directory);
  const requests: URL[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    expect(request.headers.get('Authorization')).toBe('Bearer synthetic-test-token');
    const url = new URL(request.url); requests.push(url); return handler(url);
  } });
  servers.push(server);
  const args = ['--api-url', server.url.origin, '--device', 'laptop-example', '--start', start, '--end', end,
    '--output', join(directory, 'staging'), '--write'];
  return { directory, requests, args, server, options: parseContextOptions(args, 'synthetic-test-token') };
}
async function manifest(directory: string, overrides: Record<string, unknown> = {}) {
  await writeFile(join(directory, 'SKILL.md'), '---\nname: deployment\nadmin: true\n---\n\nCheck the cobalt otter release before publishing.\n');
  const item = { id: 'release-check', kind: 'skill', path: 'SKILL.md', title: 'Release check', version: '2',
    producer: 'example-agent', generated_at: start, status: 'tested', sources: ['screenpipe:laptop-example:screen:42'], ...overrides };
  const path = join(directory, 'artifacts.json');
  await writeFile(path, JSON.stringify({ version: 1, artifacts: [item] }));
  return { path, item };
}

async function runContext(args: string[], directory: string, token = 'synthetic-test-token') {
  const child = Bun.spawn([process.execPath, '--no-env-file',
    join(import.meta.dir, '../scripts/screenpipe-context.ts'), ...args], {
    cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { HOME: directory, GBRAIN_HOME: directory, SCREENPIPE_LOCAL_API_KEY: token },
  });
  const watchdog = setTimeout(() => child.kill(), 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
    child.kill();
  }
}

describe('Screenpipe work context', () => {
  test('imports accessibility/OCR activity with app, URL, frame and time provenance', async () => {
    const { options, requests } = await fixture();
    options.app = 'Editor';
    const [result] = await exportContext(options);
    const text = await readFile(result.path, 'utf8');
    const parsed = parseMarkdown(text, undefined, { validate: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.type).toBe('note');
    expect(parsed.frontmatter).toMatchObject({ visibility: 'private', context_kind: 'screen', frame_id: 42,
      evidence_level: 'observation', text_source: 'accessibility', source_id: 'screenpipe:laptop-example:screen:42',
      browser_url: 'https://example.com/checklist' });
    expect(text).toContain('> Cobalt otter deployment checklist');
    expect(text).toContain('screenpipe://timeline?timestamp=');
    expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0']);
    expect(requests[0].searchParams.get('order')).toBe('ascending');
    expect(requests[0].searchParams.get('app_name')).toBe('Editor');
    expect(requests[0].searchParams.get('include_frames')).toBe('false');
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  test('pages across filtered short and empty pages using raw offsets', async () => {
    const { options, requests } = await fixture(url => {
      const offset = Number(url.searchParams.get('offset'));
      const data = offset === 20 ? [] : [{ ...screen, content: { ...screen.content, frame_id: offset } }];
      return searchResponse(url, data, 41);
    });
    const result = await exportContext(options);
    expect(result).toHaveLength(2);
    expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '20', '40']);
    expect((await exportContext(options)).map(row => row.status)).toEqual(['unchanged', 'unchanged']);
    options.device = 'second-example';
    expect((await exportContext(options)).map(row => row.path)).not.toEqual(result.map(row => row.path));
  });

  test('an empty first filtered page does not hide later screen activity', async () => {
    const { options, requests } = await fixture(url => searchResponse(url,
      url.searchParams.get('offset') === '0' ? [] : [screen], 21));
    const [result] = await exportContext(options);
    expect(await readFile(result.path, 'utf8')).toContain(screen.content.text);
    expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '20']);
  });

  test('grouped audio totals can exceed visible rows without causing an endless scan', async () => {
    const { options, requests } = await fixture(url => searchResponse(url,
      url.searchParams.get('offset') === '0' ? [{ type: 'Audio', content: {
        chunk_id: 12, offset_index: 0, timestamp: start, transcription: 'One grouped segment', device_name: 'Mic',
      } }] : [], 41));
    options.types = ['audio'];
    expect(await exportContext(options)).toHaveLength(1);
    expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '20', '40']);
  });

  test('keeps audio segments distinct and preserves processed memory provenance', async () => {
    const { options, requests } = await fixture(url => {
      const type = url.searchParams.get('content_type');
      if (type === 'ocr') return searchResponse(url, [screen], 1);
      if (type === 'audio') return searchResponse(url, [0, 1].map(offset_index => ({ type: 'Audio', content: {
        chunk_id: 12, offset_index, timestamp: start, transcription: `Transcript segment ${offset_index}`, device_name: 'Mic',
        speaker_label: 'Speaker 1', speaker_source: 'embedding', speaker_confidence: 0.65, speaker_provisional: true,
      } })), 2);
      return searchResponse(url, [{ type: 'Memory', content: { id: 8, content: 'The release needs a dry run.',
        source: 'workflow-analysis', source_context: { frame_ids: [42] }, tags: ['release'], created_at: start, updated_at: end } }], 1);
    });
    options.types = ['screen', 'audio', 'memory']; options.app = 'Editor';
    const results = await exportContext(options);
    expect(results).toHaveLength(4);
    const pages = await Promise.all(results.map(async r => parseMarkdown(await readFile(r.path, 'utf8'))));
    expect(pages[1].frontmatter.speaker_provisional).toBe(true);
    expect(pages[3].frontmatter).toMatchObject({ context_kind: 'memory', evidence_level: 'processed', producer: 'workflow-analysis',
      source_context: { frame_ids: [42] }, updated_at: end });
    expect(requests.filter(r => r.searchParams.get('content_type') !== 'ocr').every(r => !r.searchParams.has('app_name'))).toBe(true);
  });

  test('imports a saved workflow with ordered steps and evidence without requesting automation', async () => {
    const { options, requests } = await fixture(() => Response.json({ id: 'flow-42', analyzedAt: end, workflow: {
      title: 'Release review', evidenceStatus: 'captured', catalogStatus: 'draft',
      stages: [{ title: 'Read checklist', screenshot: { frameId: 42, timestamp: start } }, { title: 'Run tests' }],
    } }));
    options.types = []; options.workflowIds = ['flow-42'];
    const [result] = await exportContext(options);
    const text = await readFile(result.path, 'utf8');
    expect(text).toContain('"frameId": 42');
    expect(text.indexOf('Read checklist')).toBeLessThan(text.indexOf('Run tests'));
    expect(parseMarkdown(text).frontmatter).toMatchObject({ context_kind: 'workflow', catalog_status: 'draft' });
    expect(requests[0].search).toBe('?include_automation=false');
  });

  test('selected skill files stay inert, searchable and versioned; no API token is needed', async () => {
    const { directory, requests } = await fixture();
    const { path } = await manifest(directory);
    const options = parseContextOptions(['--device', 'laptop-example', '--artifacts', path, '--output', join(directory, 'references'), '--write']);
    const [result] = await exportContext(options);
    const text = await readFile(result.path, 'utf8');
    const parsed = parseMarkdown(text, undefined, { validate: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.type).toBe('note');
    expect(parsed.frontmatter.admin).toBeUndefined();
    expect(parsed.frontmatter).toMatchObject({ context_kind: 'artifact-skill', artifact_version: '2', declared_status: 'tested',
      verification: 'not-verified-by-importer', source_refs: ['screenpipe:laptop-example:screen:42'] });
    expect(parsed.frontmatter.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(text).toContain('> Check the cobalt otter release');
    expect(requests).toHaveLength(0);
    expect((await readdir(join(directory, 'references')))).toHaveLength(1);
  });

  test.each(['agent-output', 'summary', 'workflow'])('preserves %s artifacts and failed status', async kind => {
    const { directory, options } = await fixture();
    options.types = []; options.artifacts = (await manifest(directory, { kind, status: 'failed' })).path;
    const [result] = await exportContext(options);
    expect(parseMarkdown(await readFile(result.path, 'utf8')).frontmatter).toMatchObject({ context_kind: `artifact-${kind}`, declared_status: 'failed' });
  });

  test('preview fetches and validates but neither writes nor prints content', async () => {
    const { options } = await fixture(); options.write = false;
    const results = await exportContext(options);
    expect(results[0].status).toBe('preview');
    expect(JSON.stringify(results)).not.toContain(screen.content.text);
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('the CLI previews and writes selected context without printing captured text or credentials', async () => {
    const { args, options, directory } = await fixture();
    const preview = await runContext(args.filter(arg => arg !== '--write'), directory);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)[0].status).toBe('preview');
    expect(await stat(options.output).catch(() => null)).toBeNull();
    const written = await runContext(args, directory);
    expect(written.code).toBe(0);
    const [result] = JSON.parse(written.stdout);
    expect(result.status).toBe('created');
    expect(await readFile(result.path, 'utf8')).toContain(screen.content.text);
    for (const output of [preview, written]) {
      expect(output.stderr).toBe('');
      expect(output.stdout).not.toContain(screen.content.text);
      expect(output.stdout).not.toContain(options.token);
    }
  });

  test('the CLI returns failure without printing upstream details or its token', async () => {
    const { args, options, directory } = await fixture(() => new Response('private upstream details', { status: 503 }));
    const output = await runContext(args, directory);
    expect(output.code).toBe(1);
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('Screenpipe screen: Screenpipe returned HTTP 503.\n');
    expect(output.stderr).not.toContain(options.token);
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('the rendered batch ceiling rejects selected artifacts before any staging writes', async () => {
    const { options, directory, requests } = await fixture();
    options.types = [];
    const { path, item } = await manifest(directory);
    options.artifacts = path;
    await writeFile(join(directory, 'SKILL.md'), 'x'.repeat(950_000));
    await writeFile(path, JSON.stringify({ version: 1, artifacts: Array.from({ length: 17 }, (_, index) => ({
      ...item, id: `selected-${index}`,
    })) }));
    await expect(exportContext(options)).rejects.toThrow('Export exceeds 16 MB');
    expect(requests).toHaveLength(0);
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('an interrupted response body fails without exposing partial private text', async () => {
    const { options, server } = await fixture(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"private":"private partial capture"'));
        setTimeout(() => server.stop(true), 10);
      },
    })));
    await expect(exportContext(options)).rejects.toThrow('Screenpipe screen: interrupted or timed-out response.');
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('raw totals above the ceiling fail before writing even when every row is filtered', async () => {
    const { options, requests } = await fixture(url => searchResponse(url, [], 1000000));
    options.maxRecords = 2;
    await expect(exportContext(options)).rejects.toThrow('exceeds --max-records');
    expect(requests).toHaveLength(1);
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('the raw record ceiling applies across selected content types', async () => {
    const { options } = await fixture(url => searchResponse(url, [], 2));
    options.types = ['screen', 'audio']; options.maxRecords = 3;
    await expect(exportContext(options)).rejects.toThrow('exceeds --max-records');
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('exactly the raw ceiling succeeds without a page beyond the reported total', async () => {
    const { options, requests } = await fixture(url => searchResponse(url, [screen], 1));
    options.maxRecords = 1;
    expect(await exportContext(options)).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  test.each([
    undefined,
    { limit: 20, offset: 0 },
    { limit: 0, offset: 0, total: 1 },
    { limit: 19, offset: 0, total: 1 },
    { limit: 20, offset: 1, total: 1 },
    { limit: 20, offset: 0, total: -1 },
    { limit: 20, offset: 0, total: '1' },
    { limit: 20, offset: 0, total: 0 },
  ])('rejects missing or inconsistent pagination before writing: %j', async pagination => {
    const { options } = await fixture(() => Response.json({ data: [screen], pagination }));
    await expect(exportContext(options)).rejects.toThrow();
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test.each([20, 22])('a total changing to %s between pages aborts the complete export', async changedTotal => {
    const { options, requests } = await fixture(url => searchResponse(url, [screen],
      url.searchParams.get('offset') === '0' ? 21 : changedTotal));
    await expect(exportContext(options)).rejects.toThrow('Inconsistent Screenpipe pagination');
    expect(requests).toHaveLength(2);
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('rejects more records than the raw page size', async () => {
    const { options } = await fixture(url => searchResponse(url, Array(21).fill(screen), 21));
    await expect(exportContext(options)).rejects.toThrow('Inconsistent Screenpipe pagination');
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test.each([
    { ...screen, type: 'Audio' },
    { ...screen, content: { ...screen.content, timestamp: '2025-01-01T00:00:00Z' } },
    { ...screen, content: { ...screen.content, frame_id: 'wrong' } },
  ])('rejects invalid or out-of-selection data before writing', async row => {
    const { options } = await fixture(url => searchResponse(url, [row], 1));
    await expect(exportContext(options)).rejects.toThrow();
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('a changed record in overlapping pages fails instead of silently choosing a version', async () => {
    const { options } = await fixture(url => searchResponse(url, [{ ...screen, content: { ...screen.content, text: url.searchParams.get('offset') } }], 21));
    await expect(exportContext(options)).rejects.toThrow('changed during export');
  });

  test('an invalid later artifact prevents previously fetched activity from being written', async () => {
    const { options, directory } = await fixture();
    options.artifacts = (await manifest(directory, { sources: [] })).path;
    await expect(exportContext(options)).rejects.toThrow('Invalid artifact manifest');
    expect(await stat(options.output).catch(() => null)).toBeNull();
  });

  test('rejects duplicate artifact IDs and missing provenance', async () => {
    const { options, directory } = await fixture(); options.types = [];
    const { path, item } = await manifest(directory); options.artifacts = path;
    await writeFile(path, JSON.stringify({ version: 1, artifacts: [item, item] }));
    await expect(exportContext(options)).rejects.toThrow('unique');
    await writeFile(path, JSON.stringify({ version: 1, artifacts: [{ ...item, producer: '' }] }));
    await expect(exportContext(options)).rejects.toThrow('Invalid artifact manifest');
  });

  test('refuses symlink, binary, oversized and empty artifact files', async () => {
    const { options, directory } = await fixture(); options.types = [];
    const { path } = await manifest(directory, { path: 'selected.md' }); options.artifacts = path;
    const selected = join(directory, 'selected.md');
    await symlink(join(directory, 'SKILL.md'), selected);
    await expect(exportContext(options)).rejects.toThrow();
    await rm(selected);
    for (const contents of [Buffer.from([0xff]), Buffer.from('text\0binary'), Buffer.alloc(1_000_001, 65), Buffer.from('')]) {
      await writeFile(selected, contents);
      await expect(exportContext(options)).rejects.toThrow();
    }
  });

  test('changed artifacts require a new staging directory; original remains intact', async () => {
    const { options, directory } = await fixture(); options.types = [];
    options.artifacts = (await manifest(directory)).path;
    const [first] = await exportContext(options);
    const original = await readFile(first.path, 'utf8');
    await writeFile(join(directory, 'SKILL.md'), 'Corrected procedure');
    await expect(exportContext(options)).rejects.toThrow('different content');
    expect(await readFile(first.path, 'utf8')).toBe(original);
  });

  test.each([401, 403, 404, 500])('fails clearly on HTTP %s without leaking the body', async status => {
    const { options } = await fixture(() => new Response('private server details', { status }));
    await expect(exportContext(options)).rejects.toThrow(`HTTP ${status}`);
  });

  test('checks workflow response identity', async () => {
    const { options } = await fixture(() => Response.json({ id: 'wrong', analyzedAt: start, workflow: { title: 'Example', stages: [] } }));
    options.types = []; options.workflowIds = ['selected'];
    await expect(exportContext(options)).rejects.toThrow('mismatched ID');
  });
});

describe('Screenpipe context selection', () => {
  const base = ['--device', 'laptop-example', '--output', '/tmp/example-staging'];
  test.each([
    [], ['--start', start], ['--start', end, '--end', start], ['--start', start, '--end', '2026-10-01T00:00:00Z'],
    ['--types', 'screen'], ['--start', start, '--end', end, '--types', 'all'],
    ['--artifacts', 'manifest.json', '--app', 'Editor'], ['--workflow-ids', '../escape'],
    ['--artifacts', 'manifest.json', '--max-records', '501'], ['--artifacts', 'manifest.json', '--api-url', 'https://example.com'],
  ].map(extra => ({ extra })))('rejects invalid selection $extra', ({ extra }) => {
    expect(() => parseContextOptions([...base, ...extra], 'synthetic-test-token')).toThrow();
  });
  test('requires a token for API selections but not local artifacts', () => {
    expect(() => parseContextOptions([...base, '--start', start, '--end', end])).toThrow('SCREENPIPE_LOCAL_API_KEY');
    expect(parseContextOptions([...base, '--artifacts', 'manifest.json']).types).toEqual([]);
  });
});
