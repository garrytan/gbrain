/**
 * GST-3747: the CLI and a real serve --http agree on personal sources.
 *
 * 1. Protects: `gbrain <read> --as <member>` previews exactly what that member's key reads over a real
 *    `gbrain serve --http`: another member's personal source is out of get (named and unnamed), search, query, find and
 *    --source __all__, naming it is refused with permission_denied, the member's own personal source stays, and the
 *    owner (preview and key) reads everything. `gbrain access check --token` reports the same reads_now. A page --as
 *    cannot read (a folder rule) gets the same not-found answer as a missing slug, so the hint names no source.
 * 2. Fails when: --as shows a personal source the member's key does not read (or hides one it does), a member key
 *    reads another member's personal source over HTTP, or access check disagrees with what the key reads.
 * 3. Existing coverage: test/access-member-personal-sources.test.ts (in-process dispatch, PGLite and Postgres),
 *    test/access-as.serial.test.ts (--as readers and privacy).
 * 4. Real seams: src/cli.ts as subprocesses on a keyless repo-less PGLite brain set up with the documented commands
 *    (sources add, access member add, access member source add, access owner set, put, auth create), then a real
 *    `gbrain serve --http` answering MCP tools/call over fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeDeepResearchId } from '../src/core/deep-research-id.ts';
import { OWNER_MEMBER, PERSONAL_KEYS, PERSONAL_PAGES, personalCliReads, personalPageText, personalReads, readNames, readingExactly, type PersonalKey } from './helpers/personal-sources-fixture.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
const MEMBERS = ['owner-example', 'pat-example', 'quin-example'] as const;
let root: string, home: string;
const tokens: Record<string, string> = {};
const previewSeen: Record<string, Record<string, PersonalKey[]>> = {};

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GBRAIN_ENFORCED_MEMBER']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function cli(args: string[], stdin?: string) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(), stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function must(args: string[], stdin?: string) {
  const r = await cli(args, stdin);
  if (r.exitCode !== 0) throw new Error(`gbrain ${args.join(' ')} failed (${r.exitCode}):\n${r.stdout}\n${r.stderr}`);
  return r;
}

async function previewSeenBy(member: string): Promise<Record<string, PersonalKey[]>> {
  const out: Record<string, PersonalKey[]> = {};
  for (const key of PERSONAL_KEYS) {
    for (const [label, args] of personalCliReads(key)) {
      const r = await cli([...args, '--as', member]);
      (out[label] ??= []);
      if (readNames(label, r.stdout, key)) out[label]!.push(key);
    }
  }
  return out;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-personal-sources-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  await must(['init', '--pglite', '--no-embedding', '--non-interactive']);
  for (const key of PERSONAL_KEYS) await must(['sources', 'add', PERSONAL_PAGES[key].source]);
  for (const member of MEMBERS) await must(['access', 'member', 'add', member]);
  await must(['access', 'owner', 'set', OWNER_MEMBER]);
  for (const key of PERSONAL_KEYS) {
    const p = PERSONAL_PAGES[key];
    if (p.member) await must(['access', 'member', 'source', 'add', p.member, p.source]);
    await must(['put', p.slug, '--source-id', p.source], personalPageText(key));
  }
  for (const [name, member, sources] of [['owner-key', OWNER_MEMBER, null], ['pat-key', 'pat-example', null], ['quin-key', 'quin-example', null],
    ['quin-named', 'quin-example', `${PERSONAL_PAGES.team.source},${PERSONAL_PAGES.pat.source}`]] as const) {
    const r = await must(['auth', 'create', name, '--member', member, ...(sources ? ['--sources', sources] : [])]);
    const token = /gbrain_[A-Za-z0-9_-]+/.exec(r.stdout + r.stderr)?.[0];
    if (!token) throw new Error(`auth create ${name} printed no token`);
    tokens[name] = token;
  }
}, 300_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('--as previews personal sources the way member keys read them (repo-less PGLite)', () => {
  test('--as a member reads its own personal source and never another member\'s; --as the owner reads everything', async () => {
    for (const member of MEMBERS) previewSeen[member] = await previewSeenBy(member);
    expect(previewSeen['quin-example']).toEqual(readingExactly(['quin', 'team']));
    expect(previewSeen['pat-example']).toEqual(readingExactly(['pat', 'team']));
    expect(previewSeen[OWNER_MEMBER]).toEqual(readingExactly(PERSONAL_KEYS));
  }, 600_000);

  test('--as naming another member\'s personal source is refused with permission_denied', async () => {
    for (const args of [['get', PERSONAL_PAGES.pat.slug, '--source', PERSONAL_PAGES.pat.source], ['search', PERSONAL_PAGES.pat.canary, '--source-id', PERSONAL_PAGES.pat.source]]) {
      const r = await cli([...args, '--as', 'quin-example', '--json']);
      expect({ args, exit: r.exitCode === 0 }).toEqual({ args, exit: false });
      expect(r.stdout + r.stderr).not.toContain(PERSONAL_PAGES.pat.canary);
      expect(JSON.parse(r.stdout)).toMatchObject({ code: 'permission_denied' });
    }
  }, 120_000);

  test('--as on a write keeps refusing --source __all__ instead of writing to one source', async () => {
    await must(['put', 'notes/keep-me', '--source-id', 'default'], '---\ntype: note\ntitle: Keep\n---\n# Keep\n\nStill here.\n');
    for (const args of [['delete', 'notes/keep-me'], ['put', 'notes/keep-me']]) {
      const r = await cli([...args, '--source', '__all__', '--as', 'quin-example', '--json'], '---\ntype: note\ntitle: Keep\n---\n# Keep\n\nReplaced.\n');
      expect({ args, exit: r.exitCode === 0, code: JSON.parse(r.stdout).code }).toEqual({ args, exit: false, code: 'invalid_params' });
    }
    expect((await must(['get', 'notes/keep-me', '--source', 'default'])).stdout).toContain('Still here.');
  }, 120_000);

  test('--as moves off a brain default that is another member\'s personal source instead of refusing', async () => {
    await must(['sources', 'default', PERSONAL_PAGES.pat.source]);
    try {
      const r = await cli(['search', PERSONAL_PAGES.quin.canary, '--as', 'quin-example']);
      expect({ exit: r.exitCode, quin: r.stdout.includes(PERSONAL_PAGES.quin.canary), pat: (r.stdout + r.stderr).includes(PERSONAL_PAGES.pat.canary) }).toEqual({ exit: 0, quin: true, pat: false });
    } finally {
      await must(['sources', 'default', 'default']);
    }
  }, 120_000);

  test('--as fetch of another member\'s personal page answers like a missing page', async () => {
    const fetch = async (source: string, slug: string) => cli(['fetch', encodeDeepResearchId(source, slug), '--as', 'quin-example', '--json']);
    const hidden = await fetch(PERSONAL_PAGES.pat.source, PERSONAL_PAGES.pat.slug);
    const absent = await fetch(PERSONAL_PAGES.team.source, 'chats/absent-page');
    expect(hidden.stdout + hidden.stderr).not.toContain(PERSONAL_PAGES.pat.canary);
    const shape = (r: { stdout: string; exitCode: number }) => ({ exit: r.exitCode, ...(({ code, message, suggestion }) => ({ code, message, suggestion }))(JSON.parse(r.stdout)) });
    expect(shape(hidden)).toEqual(shape(absent));
    expect((await fetch(PERSONAL_PAGES.quin.source, PERSONAL_PAGES.quin.slug)).stdout).toContain(PERSONAL_PAGES.quin.canary);
  }, 120_000);

  test('the plain local CLI is unchanged: it reads every source', async () => {
    const r = await must(['search', PERSONAL_PAGES.pat.canary, '--source', '__all__']);
    expect(r.stdout).toContain(PERSONAL_PAGES.pat.canary);
  }, 60_000);

  test('access check --token reports what each key reads', async () => {
    const readsNow = async (token: string, as?: string) => (JSON.parse((await must(['access', 'check', '--token', token, ...(as ? ['--as', as] : []), '--json'])).stdout).reads_now as string[]).slice().sort();
    const own = (key: PersonalKey) => ['default', PERSONAL_PAGES[key].source, PERSONAL_PAGES.team.source].sort();
    expect(await readsNow('quin-key')).toEqual(own('quin'));
    expect(await readsNow('quin-key', 'quin-example')).toEqual(own('quin'));
    expect(await readsNow('pat-key')).toEqual(own('pat'));
    expect(await readsNow('owner-key')).toEqual(['default', ...PERSONAL_KEYS.map(k => PERSONAL_PAGES[k].source)].sort());
    expect(await readsNow('quin-named')).toEqual([PERSONAL_PAGES.pat.source, PERSONAL_PAGES.team.source].sort());
  }, 120_000);
});

describe('--as answers a page it cannot read exactly like an absent one', () => {
  const HIDDEN = 'private/pat/plan';
  const ABSENT = 'private/pat/nothing';
  const team = PERSONAL_PAGES.team.source;

  beforeAll(async () => {
    await must(['access', 'rule', 'add', '--id', 'folder-pat', '--prefix', 'private/pat/', '--readers', `member:pat-example,member:${OWNER_MEMBER}`, '--source', team, '--yes']);
    await must(['put', HIDDEN, '--source-id', team], '---\ntype: note\ntitle: Plan\n---\n# Plan\n\nThe plan zebracanaryfolder is late.\n');
  }, 120_000);

  test('get under --as: text and JSON, exit code included, are the same for a folder-ruled page and a missing slug', async () => {
    const answer = async (slug: string, extra: string[]) => {
      const r = await cli(['get', slug, ...extra, '--as', 'quin-example']);
      return { exit: r.exitCode, stdout: r.stdout.replaceAll(slug, '<slug>'), stderr: r.stderr.replaceAll(slug, '<slug>') };
    };
    for (const extra of [['--source', team], [], ['--source', team, '--json'], ['--json']]) {
      const hidden = await answer(HIDDEN, extra);
      expect(hidden.stdout + hidden.stderr).not.toContain('zebracanaryfolder');
      expect(hidden.exit).not.toBe(0);
      expect({ extra, ...hidden }).toEqual({ extra, ...await answer(ABSENT, extra) });
    }
  }, 240_000);

  test('the plain local CLI still names the source a page lives in', async () => {
    const r = await cli(['get', HIDDEN, '--source', 'default', '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(JSON.parse(r.stdout).suggestion).toContain(`Page exists in source '${team}'`);
  }, 120_000);
});

describe('a real serve --http reads personal sources the way --as previewed them', () => {
  let server: ChildProcess | undefined;
  let base = '';

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await res.text();
    const data = body.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).pop() ?? body;
    const result = (JSON.parse(data) as { result?: { isError?: boolean; content?: Array<{ text: string }> } }).result ?? {};
    return { isError: result.isError === true, text: (result.content ?? []).map(c => c.text).join('\n') };
  }

  async function keySeenBy(token: string): Promise<Record<string, PersonalKey[]>> {
    const out: Record<string, PersonalKey[]> = {};
    for (const key of PERSONAL_KEYS) {
      for (const [label, op, params] of personalReads(key)) {
        const { text } = await call(token, op, params);
        (out[label] ??= []);
        if (readNames(label, text, key)) out[label]!.push(key);
      }
    }
    return out;
  }

  beforeAll(async () => {
    const port = await new Promise<number>((done, fail) => {
      const s = createServer();
      s.once('error', fail);
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); });
    });
    base = `http://127.0.0.1:${port}`;
    server = spawn('bun', ['run', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', base], { cwd: root, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let serr = '';
    server.stderr?.on('data', (d: Buffer) => { serr += d.toString(); });
    for (let i = 0; i < 240; i++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
      await Bun.sleep(500);
    }
    throw new Error(`serve --http did not become ready:\n${serr}`);
  }, 180_000);

  afterAll(async () => {
    if (!server) return;
    server.kill('SIGTERM');
    await new Promise(done => { if (server!.exitCode !== null) done(null); else server!.once('exit', done); });
  });

  test('each member key reads exactly what --as previewed for its member', async () => {
    const quin = await keySeenBy(tokens['quin-key']!);
    expect(quin).toEqual(readingExactly(['quin', 'team']));
    expect(await keySeenBy(tokens['pat-key']!)).toEqual(readingExactly(['pat', 'team']));
    expect(await keySeenBy(tokens['owner-key']!)).toEqual(readingExactly(PERSONAL_KEYS));
    if (previewSeen['quin-example']) expect(quin).toEqual(previewSeen['quin-example']);
  }, 600_000);

  test('a member key naming another member\'s personal source is refused; a grant that names it keeps it', async () => {
    const named = await call(tokens['quin-key']!, 'get_page', { slug: PERSONAL_PAGES.pat.slug, source_id: PERSONAL_PAGES.pat.source });
    expect(named.isError).toBe(true);
    expect(named.text).toContain('permission_denied');
    expect(named.text).not.toContain(PERSONAL_PAGES.pat.canary);
    const granted = await call(tokens['quin-named']!, 'get_page', { slug: PERSONAL_PAGES.pat.slug, source_id: PERSONAL_PAGES.pat.source });
    expect(granted.text).toContain(PERSONAL_PAGES.pat.canary);
  }, 120_000);
});
