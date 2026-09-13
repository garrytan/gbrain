/**
 * #4888 — `gbrain sync --json` must keep stdout pure JSON. Every human line
 * performSync emits through slog() used to land on stdout AHEAD of the
 * envelope, so the documented `--json | jq` contract failed on the success
 * path. Under --json those lines route to stderr; JSON lines (a cost-gate
 * status line, the final envelope) stay on stdout.
 *
 * Real PGLite + a real git repo through the CLI entry (`runSync`): the leak
 * is a property of the whole command path, not of one helper.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let repoPath: string;
let home: string;

const FOO = (body: string) => `---\ntype: concept\ntitle: Foo\n---\n\n${body}\n`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-4888-home-'));
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-4888-repo-'));
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'topics'), { recursive: true });
  writeFileSync(join(repoPath, 'topics/foo.md'), FOO('baseline.'));
  execSync('git add -A && git commit -q -m initial', { cwd: repoPath, stdio: 'pipe' });
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('default', 'default', $1)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [repoPath],
  );
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** runSync with stdout and stderr split-captured (console.* AND the raw streams). */
async function run(args: string[]): Promise<{ stdout: string[]; stderr: string[] }> {
  const { runSync } = await import('../src/commands/sync.ts');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const str = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));
  const origLog = console.log;
  const origErr = console.error;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  console.log = (...a: unknown[]) => { stdout.push(a.map(str).join(' ') + '\n'); };
  console.error = (...a: unknown[]) => { stderr.push(a.map(str).join(' ') + '\n'); };
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw new Error(`__exit__${code}`); }) as typeof process.exit;
  try {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined },
      () => runSync(engine, args),
    );
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origOut;
    process.stderr.write = origErrWrite;
  }
  return { stdout, stderr };
}

const lines = (chunks: string[]) => chunks.join('').split('\n').filter((l) => l.trim().length > 0);
const parsedAll = (out: string[]) => out.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('#4888: sync --json keeps stdout pure JSON', () => {
  test('first-sync dry run: every stdout line parses; the preview prose lands on stderr', async () => {
    const { stdout, stderr } = await run(['--dry-run', '--no-pull', '--no-embed', '--json']);
    const out = lines(stdout);
    for (const l of out) expect(() => JSON.parse(l)).not.toThrow();
    const env = parsedAll(out).find((o) => o.schema_version === 1);
    expect(env?.sync_status).toBe('dry_run');
    expect(env?.added).toBe(1);
    expect(stderr.join('')).toContain('Full-sync dry run');
  }, 60_000);

  test('first sync (real import): runImport human summary lands on stderr, every stdout line parses', async () => {
    // performFullSync delegates to runImport, whose "Found N markdown files" /
    // "Import complete" lines are its own sinks — the --json wrap must cover
    // them too, or the very first `sync --json | jq` an agent scripts breaks.
    const { stdout, stderr } = await run(['--no-pull', '--no-embed', '--json']);
    const out = lines(stdout);
    for (const l of out) expect(() => JSON.parse(l)).not.toThrow();
    const env = parsedAll(out).find((o) => o.schema_version === 1);
    expect(env?.sync_status).toBe('first_sync');
    const err = stderr.join('');
    expect(err).toContain('Found 1 markdown files');
    expect(err).toContain('Import complete');
  }, 60_000);

  test('incremental dry run: the "Sync dry run" / "Modified:" prose lands on stderr, not stdout', async () => {
    // A real run sets last_commit; then one committed change to preview.
    await run(['--no-pull', '--no-embed']);
    writeFileSync(join(repoPath, 'topics/foo.md'), FOO('changed.'));
    execSync('git add -A && git commit -q -m change', { cwd: repoPath, stdio: 'pipe' });

    const { stdout, stderr } = await run(['--dry-run', '--no-pull', '--no-embed', '--json']);
    const out = lines(stdout);
    for (const l of out) expect(() => JSON.parse(l)).not.toThrow();
    const env = parsedAll(out).find((o) => o.schema_version === 1);
    expect(env?.sync_status).toBe('dry_run');
    expect(env?.modified).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Sync dry run:');
    expect(err).toContain('Modified: topics/foo.md');
  }, 60_000);

  test('without --json the preview prose still reaches stdout (interactive output unchanged)', async () => {
    const { stdout } = await run(['--dry-run', '--no-pull', '--no-embed']);
    expect(stdout.join('')).toContain('Sync dry run:');
  }, 60_000);

  // Wave review: the remaining human lines on the --json path.
  test('--retry-failed --json with no pending failures: the "nothing to retry" line is stderr, stdout parses', async () => {
    rmSync(join(home, 'sync-failures.jsonl'), { force: true });
    const { stdout, stderr } = await run(['--retry-failed', '--dry-run', '--no-pull', '--no-embed', '--json']);
    for (const l of lines(stdout)) expect(() => JSON.parse(l)).not.toThrow();
    expect(stderr.join('')).toContain('No unacknowledged sync failures to retry.');
  }, 60_000);

  test('--retry-failed --json with a pending failure: the "Retrying N" line is stderr, stdout parses', async () => {
    seedFailure();
    const { stdout, stderr } = await run(['--retry-failed', '--dry-run', '--no-pull', '--no-embed', '--json']);
    for (const l of lines(stdout)) expect(() => JSON.parse(l)).not.toThrow();
    expect(stderr.join('')).toContain('Retrying 1 previously-failed file(s)');
  }, 60_000);

  test('--skip-failed --json: the "Acknowledged N" line is stderr, stdout parses', async () => {
    seedFailure();
    const { stdout, stderr } = await run(['--skip-failed', '--dry-run', '--no-pull', '--no-embed', '--json']);
    for (const l of lines(stdout)) expect(() => JSON.parse(l)).not.toThrow();
    expect(stderr.join('')).toContain('Acknowledged 1 pre-existing failure(s).');
  }, 60_000);

  test('sync trigger --source <id> --json prints one JSON line with job_id on stdout', async () => {
    const { stdout } = await run(['trigger', '--source', 'default', '--json']);
    const out = lines(stdout);
    expect(out).toHaveLength(1);
    expect(typeof JSON.parse(out[0]).job_id).toBe('number');
  }, 60_000);
});

/** One open ledger row for the default source (the shape sync-failure-ledger writes). */
function seedFailure(): void {
  const now = new Date().toISOString();
  writeFileSync(
    join(home, 'sync-failures.jsonl'),
    JSON.stringify({
      source_id: 'default', path: 'topics/broken.md', error: 'boom', code: 'UNKNOWN', commit: 'abc',
      first_seen: now, ts: now, attempts: 1, state: 'open', acknowledged: false, acknowledged_at: null,
    }) + '\n',
  );
}
