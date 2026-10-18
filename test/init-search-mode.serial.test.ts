/**
 * `gbrain init --search-mode <mode>` through the real binary: the operator's
 * choice is recorded (`search.mode_source: operator`) and the `--json`
 * document carries no first-run `search_mode` decision; on a brain with
 * another mode it refuses (exit 2, naming both fixes) unless `--force`; a
 * plain keyless `init --json` still asks, with conservative applied.
 *
 * Serial: real subprocesses and PGLite datastores in temp homes.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const KEYLESS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined };
const INIT = ['init', '--pglite', '--no-embedding', '--json'];

function decisionIds(stdout: string): string[] {
  const doc = JSON.parse(stdout) as { notices?: Array<{ decisions?: Array<{ id: string }> }> };
  return (doc.notices ?? []).flatMap(n => (n.decisions ?? []).map(d => d.id));
}

describe('gbrain init --search-mode', () => {
  test('records the operator\'s choice, asks nothing, refuses a different mode later unless --force', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-search-mode-'));
    const opts = { home, env: KEYLESS, timeoutMs: 180_000 };

    const chosen = await runCli([...INIT, '--search-mode', 'tokenmax'], opts);
    expect(chosen.exitCode).toBe(0);
    expect(decisionIds(chosen.stdout)).not.toContain('search_mode');
    expect((await runCli(['config', 'get', 'search.mode'], opts)).stdout.trim()).toBe('tokenmax');
    expect((await runCli(['config', 'get', 'search.mode_source'], opts)).stdout.trim()).toBe('operator');

    const refused = await runCli([...INIT, '--search-mode', 'balanced'], opts);
    expect(refused.exitCode).toBe(2);
    const err = JSON.parse(refused.stdout) as { code: string; message: string };
    expect(err.code).toBe('invalid_params');
    expect(err.message).toContain('This brain already has search.mode tokenmax');
    expect(err.message).toContain('gbrain config set search.mode balanced');
    expect(err.message).toContain('--force');
    expect((await runCli(['config', 'get', 'search.mode'], opts)).stdout.trim()).toBe('tokenmax');

    const forced = await runCli([...INIT, '--search-mode', 'balanced', '--force'], opts);
    expect(forced.exitCode).toBe(0);
    expect((await runCli(['config', 'get', 'search.mode'], opts)).stdout.trim()).toBe('balanced');
  }, 300_000);

  test('an invalid mode is refused before anything is written', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-search-mode-'));
    const bad = await runCli([...INIT, '--search-mode', 'max'], { home, env: KEYLESS, timeoutMs: 120_000 });
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toContain('--search-mode must be one of conservative, balanced, tokenmax');
  }, 180_000);

  test('a plain keyless init --json still carries the search_mode decision, conservative applied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-search-mode-'));
    const opts = { home, env: KEYLESS, timeoutMs: 180_000 };
    const plain = await runCli(INIT, opts);
    expect(plain.exitCode).toBe(0);
    expect(decisionIds(plain.stdout)).toContain('search_mode');
    expect((await runCli(['config', 'get', 'search.mode_source'], opts)).stdout.trim()).toBe('auto');
  }, 300_000);
});
