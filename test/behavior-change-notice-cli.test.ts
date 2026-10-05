/**
 * The `behavior_changes` notice on the real CLI (fix wave lane B3, W-A3).
 *
 * Protects: `gbrain init` stamps the database it creates as a fresh install,
 * so later commands stay silent; a brain with no recorded baseline that was
 * created before the grace window (a `bun install -g` upgrade with no
 * upgrade-state.json) gets the disclosure on stderr once, on the first
 * command (an [AGENT] block off a TTY), and never again; `gbrain doctor`
 * shows it without consuming it.
 * Fails when: init stops stamping, the CLI startup hook stops delivering or
 * marking, or doctor writes the marker.
 * Seams: the real `src/cli.ts` in a subprocess with a throwaway HOME; the
 * brain's age is set by editing `sources.created_at` between commands.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from './helpers/cli-spawn.ts';

const BLOCK = 'why: [behavior_changes]';
const env = { GBRAIN_CHAT_FALLBACK_CHAIN: undefined, GBRAIN_NO_ONBOARD_NUDGE: '1' };

/** Backdate the brain's creation in a child process, between CLI commands (the CLI holds the PGLite lock while it runs). */
async function ageBrain(home: string, dataDir: string): Promise<void> {
  const script = join(home, 'age-brain.ts');
  const enginePath = join(import.meta.dir, '..', 'src', 'core', 'pglite-engine.ts');
  writeFileSync(script, `
    const { PGLiteEngine: Engine } = await import(${JSON.stringify(enginePath)});
    const engine = new Engine();
    await engine.connect({ database_path: ${JSON.stringify(dataDir)} });
    await engine.executeRaw("UPDATE sources SET created_at = now() - interval '3 days'");
    await engine.disconnect();
  `);
  const child = Bun.spawn([process.execPath, '--no-env-file', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
}

describe('behavior_changes on the CLI', () => {
  test('init marks a fresh install; an older unrecorded brain gets the notice once; doctor only reads it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-behavior-cli-'));
    const opts = { home, cwd: home, timeoutMs: 120_000, env };
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], opts);
    expect(init.exitCode).toBe(0);
    const dir = join(home, '.gbrain', 'notices', 'behavior-changes');
    const baselines = readdirSync(dir).filter(f => f.endsWith('.baseline'));
    expect(baselines).toHaveLength(1);

    const dataDir = join(home, '.gbrain', 'brain.pglite');
    expect(existsSync(dataDir)).toBe(true);
    await ageBrain(home, dataDir);
    const fresh = await runCli(['list', '--limit', '1'], opts);
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stderr).not.toContain(BLOCK);

    // The same brain as an upgrader sees it: no baseline was ever recorded.
    rmSync(join(dir, baselines[0]!));
    const doctor = await runCli(['doctor', '--only', 'behavior_changes', '--json'], opts);
    expect(doctor.stdout).toContain('one-time disclosure');
    expect(doctor.stderr).not.toContain(BLOCK);
    expect(readdirSync(dir).some(f => f.endsWith('.shown'))).toBe(false);

    const first = await runCli(['list', '--limit', '1'], opts);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain(BLOCK);
    expect(first.stderr).toContain('cycle.lint_fix false');
    const second = await runCli(['list', '--limit', '1'], opts);
    expect(second.stderr).not.toContain(BLOCK);
  }, 300_000);
});
