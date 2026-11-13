/**
 * #7700: `transcripts ingest --all` discovered each file under a native
 * harness root with a known format, then kept only the paths, so detection
 * ran again on every file. A Claude Code log whose leading bookkeeping record
 * is larger than the detector's 2 MiB fallback window then failed as
 * `unknown format`, while `--format claude-code` parsed the same file.
 *
 * Protects: the --all lane carries the format discovery established for each
 * file into the import, so that log parses; a mixed scan keeps each file's own
 * format. Seams: none. The CLI runs as a subprocess because the harness roots
 * hang off os.homedir(), which Bun fixes at process start; HOME points at a
 * throwaway harness tree holding a keyless PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptsIngestResult } from '../src/core/transcripts/ingest.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let home: string;

async function gbrain(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined,
    HERMES_HOME: join(home, '.hermes'), GROK_HOME: join(home, '.grok'),
    GBRAIN_NON_INTERACTIVE: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', NO_COLOR: '1',
  });
  const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
    cwd: home, env, stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gb-transcripts-7700-'));
  const init = await gbrain(['init', '--pglite', '--no-embedding', '--json']);
  if (init.exitCode !== 0) throw new Error(`init failed: ${init.stdout}\n${init.stderr}`);
}, 180_000);

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

async function ingestAllDryRun(): Promise<TranscriptsIngestResult> {
  const run = await gbrain(['transcripts', 'ingest', '--all', '--dry-run', '--json', '--quiet']);
  try {
    return JSON.parse(run.stdout) as TranscriptsIngestResult;
  } catch {
    throw new Error(`exit ${run.exitCode}: ${run.stdout}\n${run.stderr}`);
  }
}

let claudeLog = '';

describe('#7700: --all keeps the format discovery established', () => {
  test('a Claude Code log with a leading record over 2 MiB imports under --all', async () => {
    const folder = join(home, '.claude', 'projects', 'synthetic');
    mkdirSync(folder, { recursive: true });
    claudeLog = join(folder, 'synthetic.jsonl');
    writeFileSync(claudeLog, [
      { type: 'queue-operation', operation: 'add', sessionId: 'synthetic', timestamp: '2026-10-26T00:00:00Z', content: 'x'.repeat(3 * 1024 * 1024) },
      { type: 'user', sessionId: 'synthetic', uuid: 'u1', timestamp: '2026-10-26T00:00:01Z', message: { role: 'user', content: 'Synthetic question.' } },
      { type: 'assistant', sessionId: 'synthetic', uuid: 'a1', timestamp: '2026-10-26T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer.' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const result = await ingestAllDryRun();
    expect(result.files.map((f) => ({ path: f.path, format: f.format, error: f.error }))).toEqual([
      { path: claudeLog, format: 'claude-code', error: undefined },
    ]);
    expect(result).toMatchObject({ erroredFiles: 0, sessionsSeen: 1, driftFiles: 0 });
    expect(result.pages.planned).toBe(1);
  }, 120_000);

  test('a mixed scan keeps each file on its own discovered format', async () => {
    const codexDir = join(home, '.codex', 'sessions', '2026', '10', '26');
    mkdirSync(codexDir, { recursive: true });
    const codex = join(codexDir, 'rollout-synthetic.jsonl');
    const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
    writeFileSync(codex, [
      line('2026-10-26T01:00:00.000Z', 'session_meta', { id: 'codex-synthetic', timestamp: '2026-10-26T01:00:00.000Z', cwd: '/tmp/acme-example', cli_version: '0.159.3' }),
      line('2026-10-26T01:00:01.000Z', 'event_msg', { type: 'user_message', message: 'Synthetic codex question.' }),
      line('2026-10-26T01:00:02.000Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic codex answer.' }] }),
    ].join('\n') + '\n');

    const result = await ingestAllDryRun();
    expect(Object.fromEntries(result.files.map((f) => [f.path, f.format ?? f.error]))).toEqual({ [claudeLog]: 'claude-code', [codex]: 'codex' });
    expect(result).toMatchObject({ erroredFiles: 0, sessionsSeen: 2 });
  }, 120_000);
});
