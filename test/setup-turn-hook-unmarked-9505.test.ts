/**
 * #9505: Claude Code can rewrite ~/.claude/settings.json without the
 * `_gbrain` marker setup writes on its hook entries. Setup owns its entries by
 * hash through the connection receipt, so a re-run reports them current; the
 * per-turn hook check (setup and doctor `harness_wiring`) must recognize the
 * same entry instead of reporting `turn_hook_not_loaded` (missing) with a fix
 * that re-runs setup and changes nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { inspectTurnHook } from '../src/core/setup/turn-hook-check.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** Two setup runs spawn the CLI (brain init, MCP smoke, hook run). */
const TWO_SETUP_RUNS_MS = 120_000;

const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };

function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-9505-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { home, bin, env: { ...CLEAN, HOME: home, GBRAIN_HOME: home } };
}

/** What a settings rewrite that keeps only the keys it knows leaves behind. */
function dropMarkers(settingsPath: string): void {
  const doc = JSON.parse(readFileSync(settingsPath, 'utf8'));
  for (const groups of Object.values(doc.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)) {
    for (const g of groups) for (const e of g.hooks) delete e._gbrain;
  }
  writeFileSync(settingsPath, JSON.stringify(doc, null, 2));
}

describe('setup claude-code re-run after the hook markers are dropped (#9505)', () => {
  test('the re-run keeps the hooks, finds the per-turn hook, runs it and exits 0', async () => {
    const b = box();
    const setup = (args: string[]) => runCli(['setup', 'claude-code', ...args, '--gbrain-bin', b.bin], { env: b.env });
    expect((await setup(['--json'])).exitCode).toBe(0);
    const settings = join(b.home, '.claude', 'settings.json');
    dropMarkers(settings);
    expect(readFileSync(settings, 'utf8')).not.toContain('_gbrain');

    await withEnv(b.env, async () => {
      expect(inspectTurnHook('claude-code')).toMatchObject({ state: 'wired', via: 'setup', source: settings });
    });

    const again = await setup(['--json']);
    const doc = JSON.parse(again.stdout);
    expect(doc.steps.map((s: { action: string }) => s.action)).toEqual(['keep', 'keep', 'keep']);
    expect(doc.turn_hook_check).toMatchObject({ ok: true, reason: 'ran' });
    expect(again.exitCode).toBe(0);
  }, TWO_SETUP_RUNS_MS);
});
