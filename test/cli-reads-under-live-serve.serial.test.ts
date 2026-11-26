/**
 * CLI reads under a live PGLite serve (gskills G8): the stdio `gbrain serve`
 * that `gbrain setup claude-code|codex` wires up holds the brain's
 * single-writer lock, so a skill script's `gbrain find`, `list`, `search`,
 * `query`, `backlinks`, `tags`, `timeline`, `graph`, `whois`,
 * `entity` and `waiting` used to fail `pglite_busy`. They now go
 * through that serve's persistence socket and print what the same command
 * prints with no serve running: same JSON (degraded stamp and notices
 * included), exit 0.
 *
 * Fails when: a listed read refuses or opens its own engine while a serve owns
 * the brain, or its delegated output differs from the cold output.
 *
 * Lane: serial (spawns a real serve and cold PGLite inits).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const home = mkdtempSync(join(tmpdir(), 'gbrain-g8-reads-'));
const cli = (args: string[], extra: Record<string, string> = {}) => runCli(args, { home, cwd: home, timeoutMs: 90_000, env: extra });
const env = (): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL' && k !== 'GBRAIN_DATABASE_URL') e[k] = v;
  return { ...e, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
};
let serve: ReturnType<typeof Bun.spawn> | null = null;

const READS: Array<[string, string[]]> = [
  ['find', ['find', 'alice', '--json']],
  ['list', ['list', '--json']],
  ['search', ['search', 'alice', '--json']],
  ['query', ['query', 'alice', '--json']],
  ['backlinks', ['backlinks', 'companies/acme-example', '--json']],
  ['tags', ['tags', 'people/alice-example', '--json']],
  ['timeline', ['timeline', 'people/alice-example', '--json']],
  ['graph', ['graph', 'people/alice-example', '--json']],
  ['whois', ['whois', 'alice', '--json']],
  ['entity', ['entity', 'people/alice-example', '--json']],
  ['waiting', ['waiting', '--json', '--as-of', '2026-01-01T00:00:00.000Z']],
  ['query --explain-target', ['query', 'zzzz', '--explain-target', 'people/alice-example', '--json']],
];
/** Human output that reads the serve's retrieval meta: the empty-result cause after "No results.". */
const TEXT_READS: Array<[string, string[]]> = [
  ['search (no results)', ['search', 'zzzz']],
  ['find (outside-guest page)', ['find', 'notes/guestnote-zz']],
  ['list (outside-guest page)', ['list', '--source', 'guests']],
];
const GUEST_LINE = '[outside guest · unattributed · ';
const cold = new Map<string, string>();
const coldText = new Map<string, string>();
let coldEntityMiss: number | null = null;
/** Fields that differ between any two runs (timing, and the read-touch stamp the previous read wrote). */
const VOLATILE = new Set(['latency_ms', 'last_retrieved_at']);
/**
 * The explain-target fix retries the serve's own arguments, which carry the source as routing and no `--json`, so
 * its argv and command name the same retry without those flags; every other field matches the cold run.
 */
const VOLATILE_FOR: Record<string, string[]> = { 'query --explain-target': ['argv', 'command'] };
const stable = (stdout: string, name = '') => {
  const skip = new Set([...VOLATILE, ...(VOLATILE_FOR[name] ?? [])]);
  return JSON.stringify(JSON.parse(stdout), (k, v) => (skip.has(k) ? undefined : v));
};

beforeAll(async () => {
  expect((await cli(['init', '--pglite', '--no-embedding'])).exitCode).toBe(0);
  const page = '---\ntitle: Alice Example\ntype: person\n---\nAlice works at Acme. See [[companies/acme-example]].\n';
  const put = Bun.spawn({ cmd: [process.execPath, '--no-env-file', CLI, 'put', 'people/alice-example'], cwd: home, env: env(), stdin: new Blob([page]), stdout: 'ignore', stderr: 'pipe' });
  expect(await put.exited).toBe(0);
  // A second federated source: an unpinned read spans both, with or without a serve.
  mkdirSync(join(home, 'notes'));
  expect((await cli(['sources', 'add', 'notes', '--path', join(home, 'notes')])).exitCode).toBe(0);
  const note = Bun.spawn({ cmd: [process.execPath, '--no-env-file', CLI, 'put', 'notes/alice-notes', '--source', 'notes'], cwd: home, env: env(),
    stdin: new Blob(['---\ntitle: Alice Notes\ntype: concept\n---\nNotes about Alice.\n']), stdout: 'ignore', stderr: 'pipe' });
  expect(await note.exited).toBe(0);
  // An outside-guest source: its page's human output carries the guest warning line, with or without a serve.
  expect((await cli(['sources', 'add', 'guests'])).exitCode).toBe(0);
  const guest = Bun.spawn({ cmd: [process.execPath, '--no-env-file', CLI, 'put', 'notes/guestnote-zz', '--source', 'guests'], cwd: home, env: env(),
    stdin: new Blob(['---\ntitle: Guest Note\ntype: note\n---\nA note an outside guest left.\n']), stdout: 'ignore', stderr: 'pipe' });
  expect(await guest.exited).toBe(0);
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).database_path });
  // initGuestSource refuses a source that already holds pages, so the fixture writes the two guest records itself.
  await engine.executeRaw(`UPDATE sources SET config = config || '{"federated": true, "guest": true}'::jsonb WHERE id = 'guests'`);
  await engine.executeRaw("INSERT INTO guest_sources (source_id, writers) VALUES ('guests', ARRAY[]::text[])");
  await engine.disconnect();
  coldEntityMiss = (await cli(['entity', 'nobody-zzz', '--json'], { GBRAIN_FAIL_ON_EMPTY: '1' })).exitCode;
  for (const [name, args] of READS) {
    const r = await cli(args);
    expect(r.exitCode).toBe(0);
    cold.set(name, stable(r.stdout, name));
  }
  for (const [name, args] of TEXT_READS) {
    const r = await cli(args);
    expect(r.exitCode).toBe(0);
    coldText.set(name, r.stdout);
  }
  serve = Bun.spawn({ cmd: [process.execPath, '--no-env-file', CLI, 'serve'], cwd: home, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: env() });
  // The serve owns the brain once a delegated read answers.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = await cli(['get', 'people/alice-example']);
    if (r.exitCode === 0) break;
    if (Date.now() > deadline) throw new Error(`serve never answered: ${r.stderr}`);
    await Bun.sleep(500);
  }
}, 240_000);

afterAll(async () => {
  serve?.kill();
  await serve?.exited;
  rmSync(home, { recursive: true, force: true });
});

describe('read-only CLI commands while a live serve owns the PGLite brain', () => {
  for (const [name, args] of READS) {
    test(`gbrain ${name} answers through the serve with the cold path's JSON`, async () => {
      const r = await cli(args);
      expect(r.stderr).not.toContain('pglite_busy');
      expect(r.exitCode).toBe(0);
      expect(stable(r.stdout, name)).toBe(cold.get(name)!);
    }, 90_000);
  }
  for (const [name, args] of TEXT_READS) {
    test(`gbrain ${name} prints the cold path's text through the serve`, async () => {
      const r = await cli(args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(coldText.get(name)!);
    }, 90_000);
  }

  test('an outside-guest page keeps its warning line through the serve', async () => {
    for (const name of ['find (outside-guest page)', 'list (outside-guest page)']) {
      expect(coldText.get(name)!).toContain(GUEST_LINE);
      expect((await cli(TEXT_READS.find(([n]) => n === name)![1])).stdout).toContain(GUEST_LINE);
    }
  }, 90_000);

  test('the federated set reaches both sources, as with no serve', async () => {
    const slugs = (JSON.parse((await cli(['list', '--json'])).stdout) as Array<{ slug: string }>).map(p => p.slug);
    expect(slugs).toContain('people/alice-example');
    expect(slugs).toContain('notes/alice-notes');
  }, 90_000);

  test('an entity miss exits 12 under GBRAIN_FAIL_ON_EMPTY=1, as with no serve', async () => {
    expect(coldEntityMiss).toBe(12);
    expect((await cli(['entity', 'nobody-zzz', '--json'], { GBRAIN_FAIL_ON_EMPTY: '1' })).exitCode).toBe(12);
  }, 90_000);

  test('a read whose settings the serve does not share never answers from the serve', async () => {
    const r = await cli(['search', 'alice', '--json'], { GBRAIN_SEARCH_EXCLUDE: 'people/' });
    expect(r.stdout).not.toContain('people/alice-example');
    expect(r.exitCode).not.toBe(0);
  }, 90_000);
});
