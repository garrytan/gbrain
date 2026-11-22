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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const home = mkdtempSync(join(tmpdir(), 'gbrain-g8-reads-'));
const cli = (args: string[]) => runCli(args, { home, cwd: home, timeoutMs: 90_000 });
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
];
const cold = new Map<string, string>();
const coldText = new Map<string, string>();
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
});
