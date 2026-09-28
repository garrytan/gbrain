import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMeetings, parseOptions, type ExportOptions } from '../scripts/screenpipe-meetings.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const meeting = {
  id: 42, meeting_start: '2026-09-20T16:00:00Z', meeting_end: '2026-09-20T16:30:00Z',
  meeting_app: 'Video call', title: 'Planning: "Q4"\n---\nadmin: true',
  attendees: 'alice-example, charlie-example', note: 'Decided to test the new onboarding flow.',
};

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(handler: (request: Request) => Response = () => Response.json(meeting)) {
  const directory = await mkdtemp(join(tmpdir(), 'screenpipe-export-test-'));
  directories.push(directory);
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    if (request.headers.get('Authorization') !== 'Bearer synthetic-test-token') return new Response(null, { status: 401 });
    return handler(request);
  } });
  servers.push(server);
  const options: ExportOptions = parseOptions([
    '--api-url', server.url.origin, '--device', 'test-device', '--ids', '42',
    '--output', join(directory, 'staging'), '--write',
  ], 'synthetic-test-token');
  return { directory, requests, options };
}

async function runExporter(options: ExportOptions, directory: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '--no-env-file',
    join(import.meta.dir, '../scripts/screenpipe-meetings.ts'),
    '--api-url', options.apiUrl, '--device', options.device,
    '--ids', options.ids.join(','), '--output', options.output,
    ...(options.write ? ['--write'] : []),
  ], {
    cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { HOME: directory, GBRAIN_HOME: directory, SCREENPIPE_LOCAL_API_KEY: options.token, ...environment },
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

describe('Screenpipe selected meeting export', () => {
  test('exports authenticated notes with parseable provenance and private permissions', async () => {
    const { options, requests } = await fixture();
    const result = await exportMeetings(options);
    expect(result.map(row => row.status)).toEqual(['created']);
    const text = await readFile(result[0].path, 'utf8');
    const parsed = parseMarkdown(text, undefined, { validate: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.title).toBe(meeting.title);
    expect(parsed.frontmatter.source_id).toBe('screenpipe:test-device:meeting:42');
    expect(parsed.frontmatter.admin).toBeUndefined();
    expect(text).toContain(meeting.note);
    expect(text).toContain('screenpipe://timeline?timestamp=2026-09-20T16%3A00%3A00Z');
    expect(requests).toEqual(['/meetings/42']);
    expect((await stat(result[0].path)).mode & 0o777).toBe(0o600);
    expect((await stat(options.output)).mode & 0o777).toBe(0o700);
  });

  test('previews without creating the output directory', async () => {
    const { options } = await fixture();
    const result = await exportMeetings({ ...options, write: false });
    expect(result[0].status).toBe('preview');
    expect(await Bun.file(result[0].path).exists()).toBe(false);
    await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('the CLI previews, then writes, without printing notes or credentials', async () => {
    const { options, directory } = await fixture();
    const preview = await runExporter({ ...options, write: false }, directory);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)[0].status).toBe('preview');
    await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
    const written = await runExporter(options, directory);
    expect(written.code).toBe(0);
    const [result] = JSON.parse(written.stdout);
    expect(result.status).toBe('created');
    expect(await readFile(result.path, 'utf8')).toContain(meeting.note);
    for (const output of [preview, written]) {
      expect(output.stderr).toBe('');
      expect(output.stdout).not.toContain(meeting.note);
      expect(output.stdout).not.toContain(options.token);
    }
  });

  test('the CLI fails without publishing upstream response content', async () => {
    const { options, directory } = await fixture(() => new Response('private upstream text', { status: 503 }));
    const output = await runExporter(options, directory);
    expect(output.code).toBe(1);
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('Meeting 42: Screenpipe returned HTTP 503.\n');
    await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('the CLI keeps the local API token off inherited HTTP proxies', async () => {
    const proxyRequests: string[] = [];
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      proxyRequests.push(request.headers.get('Authorization') ?? 'no authorization');
      return Response.json(meeting);
    } });
    servers.push(proxy);
    const { options, directory, requests } = await fixture();
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      const output = await runExporter(options, directory, {
        [name]: proxy.url.origin, NO_PROXY: '', no_proxy: '',
      });
      expect(output.code).toBe(1);
      expect(output.stderr).toContain('Clear HTTP_PROXY');
      expect(output.stderr).not.toContain(options.token);
      expect(output.stderr).not.toContain(proxy.url.origin);
      expect(output.stdout).toBe('');
      expect(proxyRequests).toEqual([]);
      expect(requests).toEqual([]);
      await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('the CLI redacts an invalid authorization header before any request', async () => {
    const { options, directory, requests } = await fixture();
    const output = await runExporter({ ...options, token: 'synthetic-secret\r\ninvalid' }, directory);
    expect(output.code).toBe(1);
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('Meeting 42: unable to reach the local Screenpipe API.\n');
    expect(requests).toEqual([]);
  });

  test('the same meeting ID on two devices has distinct filenames and provenance', async () => {
    const { options } = await fixture();
    const [first] = await exportMeetings(options);
    const [second] = await exportMeetings({ ...options, device: 'other-device' });
    expect(first.path).not.toBe(second.path);
    const one = parseMarkdown(await readFile(first.path, 'utf8'));
    const two = parseMarkdown(await readFile(second.path, 'utf8'));
    expect(one.frontmatter.source_id).toBe('screenpipe:test-device:meeting:42');
    expect(two.frontmatter.source_id).toBe('screenpipe:other-device:meeting:42');
  });

  test('nullable metadata gets a usable title and preserves a timestamp offset', async () => {
    const start = '2026-09-20T16:00:00+05:30';
    const { options } = await fixture(() => Response.json({ ...meeting, title: null,
      attendees: null, meeting_start: start, meeting_end: '2026-09-20T16:30:00+05:30' }));
    const [result] = await exportMeetings(options);
    const parsed = parseMarkdown(await readFile(result.path, 'utf8'));
    expect(parsed.title).toBe('Screenpipe meeting 42');
    expect(parsed.frontmatter.meeting_start).toBe(start);
    expect(parsed.frontmatter.attendees).toBeNull();
  });

  test('repeated and concurrent exports preserve one complete file', async () => {
    const { options } = await fixture();
    const results = await Promise.all([exportMeetings(options), exportMeetings(options)]);
    expect(results.flat().map(row => row.status).sort()).toEqual(['created', 'unchanged']);
    expect((await exportMeetings(options))[0].status).toBe('unchanged');
    expect(await readdir(options.output)).toEqual(['screenpipe-test-device-42.md']);
  });

  test('refuses to overwrite an edited note', async () => {
    const { options } = await fixture();
    const [result] = await exportMeetings(options);
    await writeFile(result.path, 'User correction');
    await expect(exportMeetings(options)).rejects.toThrow('different content');
    expect(await readFile(result.path, 'utf8')).toBe('User correction');
    expect(await readdir(options.output)).toEqual(['screenpipe-test-device-42.md']);
  });

  test('refuses symlink destinations without modifying their target', async () => {
    const { options, directory } = await fixture();
    const [result] = await exportMeetings(options);
    await rm(result.path);
    const target = join(directory, 'private.md');
    await writeFile(target, 'Unrelated content');
    await symlink(target, result.path);
    await expect(exportMeetings(options)).rejects.toThrow('different content');
    expect(await readFile(target, 'utf8')).toBe('Unrelated content');
  });

  for (const [name, body] of [
    ['ongoing meeting', { ...meeting, meeting_end: null }],
    ['missing note', { ...meeting, note: null }],
    ['empty note', { ...meeting, note: ' \n\t' }],
    ['incorrect ID', { ...meeting, id: 43 }],
    ['invalid timestamp', { ...meeting, meeting_start: 'not a timestamp' }],
    ['reversed interval', { ...meeting, meeting_end: '2026-09-19T16:00:00Z' }],
  ] as const) {
    test(`rejects ${name} before creating files`, async () => {
      const { options } = await fixture(() => Response.json(body));
      await expect(exportMeetings(options)).rejects.toThrow(/Meeting 42:/);
      await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }

  test('a failed fetch leaves the selected batch unwritten', async () => {
    const { options } = await fixture(request => new URL(request.url).pathname === '/meetings/42'
      ? Response.json(meeting) : new Response('private upstream text', { status: 403 }));
    await expect(exportMeetings({ ...options, ids: [42, 43] })).rejects.toThrow('Meeting 43: Screenpipe returned HTTP 403.');
    await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects unauthenticated requests without returning response content', async () => {
    const { options } = await fixture();
    await expect(exportMeetings({ ...options, token: 'wrong-token' })).rejects.toThrow('HTTP 401');
  });

  test('rejects redirects without forwarding the credential', async () => {
    let contacted = false;
    const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { contacted = true; return Response.json(meeting); } });
    servers.push(target);
    const { options } = await fixture(() => Response.redirect(target.url));
    await expect(exportMeetings(options)).rejects.toThrow();
    expect(contacted).toBe(false);
  });

  test('rejects oversized responses', async () => {
    const { options } = await fixture(() => Response.json({ ...meeting, note: 'x'.repeat(2_000_001) }));
    await expect(exportMeetings(options)).rejects.toThrow('exceeds 2 MB');
  });

  test('does not include private response text in JSON errors', async () => {
    const { options } = await fixture(() => new Response('private meeting text'));
    await expect(exportMeetings(options)).rejects.toThrow('Meeting 42: invalid JSON response.');
  });

  test('rejects a successful response with no body', async () => {
    const { options } = await fixture(() => new Response(null, { status: 204 }));
    await expect(exportMeetings(options)).rejects.toThrow('Meeting 42: empty response.');
    await expect(stat(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Screenpipe export arguments', () => {
  const args = ['--device', 'test-device', '--ids', '42,42,43', '--output', '/tmp/staging'];
  test('deduplicates selected IDs and defaults to preview', () => {
    expect(parseOptions(args, 'synthetic-test-token')).toMatchObject({ ids: [42, 43], write: false });
  });
  test('requires a token without accepting it as a command argument', () => {
    expect(() => parseOptions(args, undefined)).toThrow('SCREENPIPE_LOCAL_API_KEY');
    expect(() => parseOptions([...args, '--token', 'secret'], 'synthetic-test-token')).toThrow();
  });
  for (const url of ['https://example.com', 'http://localhost', 'http://127.0.0.1/path',
    'http://user:password@127.0.0.1', 'http://127.0.0.1?token=secret']) {
    test(`refuses non-loopback origin or extra URL components: ${url}`, () => {
      expect(() => parseOptions([...args, '--api-url', url], 'synthetic-test-token')).toThrow('loopback origin');
    });
  }
  test('rejects path traversal in the device label', () => {
    expect(() => parseOptions(['--device', '../other', '--ids', '42', '--output', '/tmp/staging'], 'synthetic-test-token')).toThrow('--device');
  });
  test('rejects empty, malformed, excessive, and unsafe selections', () => {
    for (const ids of ['', '0', '-1', '1.5', '42,', '42, 43', '9007199254740992',
      Array.from({ length: 51 }, (_, index) => index + 1).join(',')]) {
      expect(() => parseOptions(['--device', 'test-device', '--ids', ids,
        '--output', '/tmp/staging'], 'synthetic-test-token')).toThrow();
    }
    expect(() => parseOptions(['--device', 'test-device', '--ids', '42'], 'synthetic-test-token')).toThrow('--output');
  });
});
