/**
 * GST-2768 PR 3: `gbrain transcripts archive run` is the documented command that archives now, on demand, and it
 * works with automatic maintenance turned off (`maintenance.auto false`), on a keyless personal PGLite brain.
 * The CLI runs as a subprocess because the harness roots hang off os.homedir(), which Bun fixes at process start;
 * HOME points at a throwaway harness tree holding one synthetic Claude Code session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let home: string;

async function gbrain(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined,
    HERMES_HOME: join(home, '.hermes'), GROK_HOME: join(home, '.grok'), GBRAIN_OPENCLAW_GATEWAY_URL: undefined,
    GBRAIN_NON_INTERACTIVE: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', NO_COLOR: '1',
  });
  const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], { cwd: home, env, stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gb-archive-on-demand-'));
  const init = await gbrain(['init', '--pglite', '--no-embedding', '--json']);
  if (init.exitCode !== 0) throw new Error('init failed: ' + init.stdout + '\n' + init.stderr);
}, 180_000);

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('gbrain transcripts archive run, on demand', () => {
  test('archives now with automatic maintenance turned off (maintenance.auto false)', async () => {
    for (const [key, value] of [['maintenance.auto', 'false'], ['brain.audience', 'personal']]) {
      const set = await gbrain(['config', 'set', key, value]);
      expect(set.exitCode).toBe(0);
    }
    const at = new Date(Date.now() - 3_600_000);
    const folder = join(home, '.claude', 'projects', 'synthetic-alice-example');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'on-demand-0001.jsonl'), [
      { type: 'user', sessionId: 'on-demand-0001', uuid: 'u1', timestamp: at.toISOString(), message: { role: 'user', content: 'Synthetic on-demand question.' } },
      { type: 'assistant', sessionId: 'on-demand-0001', uuid: 'a1', timestamp: new Date(at.getTime() + 5_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic on-demand answer.' }] } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');

    const run = await gbrain(['transcripts', 'archive', 'run', '--json']);
    const result = JSON.parse(run.stdout) as { enabled: boolean; written: number; days: Array<{ harness: string; status: string }> };
    expect(result.enabled).toBe(true);
    expect(result.days.filter(d => d.harness === 'claude-code' && d.status === 'written')).toHaveLength(1);

    const status = await gbrain(['transcripts', 'archive', 'status', '--json']);
    const parsed = JSON.parse(status.stdout) as { archived_days: number };
    expect(parsed.archived_days).toBe(1);
  }, 180_000);
});
