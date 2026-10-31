import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';

const cli = resolve(import.meta.dir, '../src/cli.ts');
let home: string;
let env: Record<string, string>;
let claude: string;

function call(args: string[]) {
  return spawnSync(process.execPath, ['--no-env-file', cli, ...args], {
    cwd: home, env, encoding: 'utf8', timeout: 60_000,
  });
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-discovery-format-'));
  env = keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined,
    GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_MODEL_DISCOVERY: 'off', HERMES_HOME: join(home, '.hermes'), GROK_HOME: join(home, '.grok'),
  });
  const initialized = call(['init', '--pglite', '--no-embedding', '--json']);
  expect(initialized.status).toBe(0);
  const claudeRoot = join(home, '.claude/projects/synthetic');
  const codexRoot = join(home, '.codex/sessions');
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  claude = join(claudeRoot, 'synthetic.jsonl');
  writeFileSync(claude, [
    { type: 'queue-operation', operation: 'add', sessionId: 'synthetic',
      timestamp: '2026-10-26T00:00:00Z', content: 'x'.repeat(3 * 1024 * 1024) },
    { type: 'user', sessionId: 'synthetic', uuid: 'u1', timestamp: '2026-10-26T00:00:01Z',
      message: { role: 'user', content: 'Synthetic telescope question.' } },
    { type: 'assistant', sessionId: 'synthetic', uuid: 'a1', timestamp: '2026-10-26T00:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic telescope answer.' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  // Remove the fixture's deliberate malformed tail so this scan can attest
  // coverage and exercise --since last, not only successful page writes.
  const codex = readFileSync(join(import.meta.dir, 'fixtures/transcripts/codex-rollout.jsonl'), 'utf8');
  writeFileSync(join(codexRoot, 'codex.jsonl'), codex.split('\n').filter(line => line && !line.startsWith('{malformed')).join('\n') + '\n');
}, 60_000);

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

test('mixed --all preserves native formats beyond sniff limits, imports and retries idempotently', () => {
  const preview = call(['transcripts', 'ingest', '--all', '--dry-run', '--json']);
  expect(preview.status).toBe(0);
  const plan = JSON.parse(preview.stdout);
  expect(plan.erroredFiles).toBe(0);
  expect(plan.sessionsSeen).toBe(2);
  expect(plan.pages.planned).toBe(2);
  expect(plan.files.map((file: { format: string }) => file.format).sort()).toEqual(['claude-code', 'codex']);
  const imported = call(['transcripts', 'ingest', '--all', '--json']);
  expect(imported.status).toBe(0);
  expect(JSON.parse(imported.stdout).pages.imported).toBe(2);
  const retry = call(['transcripts', 'ingest', '--all', '--json']);
  expect(retry.status).toBe(0);
  expect(JSON.parse(retry.stdout).pages).toMatchObject({ imported: 0, skipped: 2, errored: 0 });
  expect(JSON.parse(retry.stdout).cleanScan).toBe(true);
  const resumed = call(['transcripts', 'ingest', '--all', '--since', 'last', '--json']);
  expect(resumed.status).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ sessionsFiltered: 2, cleanScan: true });
}, 120_000);

test('explicit paths still sniff, explicit format still wins, and discovered files retain byte caps', () => {
  const sniffed = call(['transcripts', 'ingest', claude, '--dry-run', '--json']);
  expect(sniffed.status).toBe(1);
  expect(JSON.parse(sniffed.stdout).files[0].error).toContain('unknown format');
  const explicit = call(['transcripts', 'ingest', claude, '--format', 'claude-code', '--dry-run', '--json']);
  expect(explicit.status).toBe(0);
  expect(JSON.parse(explicit.stdout).pages.planned).toBe(1);
  const capped = call(['transcripts', 'ingest', '--all', '--max-bytes', '1mb', '--dry-run', '--json']);
  const result = JSON.parse(capped.stdout);
  expect(result.erroredFiles).toBe(1);
  expect(result.files.find((file: { path: string }) => file.path === claude).error).not.toContain('unknown format');
  expect(result.pages.planned).toBe(1);
  expect(result.cleanScan).toBe(false);
}, 120_000);

test('a global --format overrides discovered formats even in a mixed --all scan', () => {
  const overridden = call(['transcripts', 'ingest', '--all', '--format', 'codex', '--dry-run', '--json']);
  expect(overridden.status).toBe(0);
  const result = JSON.parse(overridden.stdout);
  expect(result.files.every((file: { format: string }) => file.format === 'codex')).toBe(true);
  expect(result.pages.planned).toBe(1);
}, 60_000);

test('per-file format hints do not bypass missing-file or symlink admission', async () => {
  const link = join(home, 'link.jsonl');
  const missing = join(home, 'missing.jsonl');
  symlinkSync(claude, link);
  const result = await runTranscriptsIngest({} as never, {
    paths: [link, missing, claude], sourceId: 'default', dryRun: true,
    discoveredFormats: new Map([[link, 'claude-code'], [missing, 'claude-code'], [claude, 'claude-code']]),
    userPatternsPath: join(home, 'no-patterns'),
  });
  expect(result.erroredFiles).toBe(2);
  expect(result.files[0].error).toContain('symlink');
  expect(result.files[1].errno).toBe('ENOENT');
  expect(result.files[2].error).toBeUndefined();
  expect(result.pages.planned).toBe(1);
  expect(result.cleanScan).toBe(false);
});
