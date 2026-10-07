/**
 * Fix wave 11 config refusals, end to end through `gbrain config set`:
 * `cycle.lint_exclude` refuses a path (#6134), and `dream.patterns.last_run`
 * is recorded state that cannot be set, only unset (#6177). Both exit 2 with
 * the rendered invalid_params refusal, write nothing, and name a real fix.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';

describe('gbrain config set wave-11 refusals', () => {
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-config-w11-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath }) + '\n');
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    await engine.disconnect();
  }, 240_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('cycle.lint_exclude: a path is refused, basenames are written', async () => {
    const bad = await runCli(['config', 'set', 'cycle.lint_exclude', 'wiki/attachments'], { home, timeoutMs: 120_000 });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('Error [invalid_params]: Invalid cycle.lint_exclude');
    expect(bad.stderr).toContain('Fix: gbrain config set cycle.lint_exclude');
    const ok = await runCli(['config', 'set', 'cycle.lint_exclude', 'attachments,drafts.md'], { home, timeoutMs: 120_000 });
    expect(ok.exitCode).toBe(0);
  }, 300_000);

  test('dream.patterns.last_run cannot be set; the fix is unset', async () => {
    const set = await runCli(['config', 'set', 'dream.patterns.last_run', '{}'], { home, timeoutMs: 120_000 });
    expect(set.exitCode).toBe(2);
    expect(set.stderr).toContain('Error [invalid_params]: dream.patterns.last_run is recorded by the patterns phase');
    expect(set.stderr).toContain('Fix: gbrain config unset dream.patterns.last_run');
    const get = await runCli(['config', 'get', 'dream.patterns.last_run'], { home, timeoutMs: 120_000 });
    expect(get.stdout.trim()).toBe('');
  }, 300_000);
});
