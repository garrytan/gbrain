/**
 * Roadmap PR 2: gbrain setup's first-session suggestion marker and --no-suggestion (src/commands/setup-suggestion.ts),
 * end to end through the CLI for a new PGLite install (repo-less), plus the marker's unknown states with a stand-in
 * launcher. HOME and GBRAIN_HOME are a temp box.
 *
 * 1. Protects: setup --json carries one `suggestion` marker next to `history` (armed, or off and why, with the flag
 *    and the command that turn it off); --no-suggestion turns it off and the marker says so from the stored state;
 *    the flag is refused (exit 2, nothing written) outside claude-code and codex wiring; a running serve makes the
 *    marker unknown with its PID and start time and says nothing needs fixing.
 * 2. Fails when: the marker is missing, claims off without a verified stop, or names a live serve as an error.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { parseSuggestionFlag, suggestionFor } from '../src/commands/setup-suggestion.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function box(): { home: string; bin: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-suggestion-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, '#!/bin/sh\nexec \'' + process.execPath + '\' --no-env-file \'' + CLI + '\' "$@"\n');
  chmodSync(bin, 0o755);
  return { home, bin, root };
}
const CLEAN = { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
async function setup(b: { home: string; bin: string }, args: string[]) {
  const r = await runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home }, timeoutMs: 180_000 });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}

/** A stand-in launcher: prints `status` for onboarding status and `off` for onboarding off. */
function fakeLauncher(outputs: { status: string; off?: string }): string {
  const b = box();
  const path = join(b.root, 'fake-gbrain');
  writeFileSync(path, '#!/bin/sh\nif [ "$4" = off ]; then printf \'%s\\n\' \'' + (outputs.off ?? '') + '\'; else printf \'%s\\n\' \'' + outputs.status + '\'; fi\n');
  chmodSync(path, 0o755);
  return path;
}

describe('gbrain setup reports the first-session suggestion', () => {
  test('a new install is armed, and the marker sits next to history with the flag and command that turn it off', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--history', 'none']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.history).toBeDefined();
    expect(r.doc.suggestion).toMatchObject({
      version: 1, state: 'armed', delivered_sessions: 0, max_sessions: 3,
      off_flag: '--no-suggestion', off_argv: ['gbrain', 'onboarding', 'off'], off_mcp: 'onboarding_off',
    });
    expect(typeof r.doc.suggestion.window_ends_at).toBe('string');
  }, 300_000);

  test('--no-suggestion turns it off, verified from the stored state', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--history', 'none', '--no-suggestion']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.suggestion).toMatchObject({ state: 'off', reason: 'stopped' });
    expect(r.doc.suggestion.why).toContain('turned off');
  }, 300_000);

  test('--no-suggestion that cannot be confirmed exits 1 and says so on stderr', async () => {
    const b = box();
    const wrapped = join(b.root, 'bin', 'gbrain-no-stop');
    writeFileSync(wrapped, '#!/bin/sh\nif [ "$3" = onboarding ] && [ "$4" = off ]; then printf \'%s\\n\' \'{"verified":false}\'; exit 1; fi\nexec \'' + b.bin + '\' "$@"\n');
    chmodSync(wrapped, 0o755);
    const r = await setup({ home: b.home, bin: wrapped }, ['claude-code', '--history', 'none', '--no-suggestion']);
    expect(r.doc?.suggestion).toMatchObject({ state: 'unknown', reason: 'stop_unverified' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('could not confirm the first-session suggestion is off');
  }, 200_000);

  test('the flag is refused outside claude-code and codex wiring, before anything is written', async () => {
    for (const args of [['openclaw', '--no-suggestion'], ['claude-code', '--remove', '--no-suggestion'], ['codex', '--instructions-only', '--no-suggestion']]) {
      const b = box();
      const r = await setup(b, args);
      expect(r.exitCode).toBe(2);
      expect(r.stdout + r.stderr).toContain('--no-suggestion');
    }
    expect(parseSuggestionFlag(['claude-code'], 'claude-code')).toBe(false);
    expect(parseSuggestionFlag(['codex', '--no-suggestion'], 'codex')).toBe(true);
  }, 300_000);
});

describe('suggestion marker when setup cannot read the record', () => {
  test('a running serve: unknown, naming its PID and start time, and that nothing needs fixing', () => {
    const got = suggestionFor({ launcher: '/nonexistent', noSuggestion: false, dryRun: false, liveServe: { pid: 4242, started_at: '2026-11-25T10:00:00.000Z' } })!;
    expect(got.marker).toMatchObject({ state: 'unknown', reason: 'live_serve' });
    expect(got.marker.why).toContain('PID 4242');
    expect(got.marker.why).toContain('started 2026-11-25T10:00:00.000Z');
    expect(got.marker.why).toContain('needs no fix');
    expect(got.line).toContain('First-session suggestion: unknown.');
    const off = suggestionFor({ launcher: '/nonexistent', noSuggestion: true, dryRun: false, liveServe: { pid: 4242 } })!;
    expect(off.marker.why).toContain('onboarding_off');
    expect(off.failed).toBe(true);
    expect(got.failed).toBeUndefined();
  });

  test('both children read and stop the host brain setup wired, never a mount the cwd or env selects', () => {
    const b = box();
    const log = join(b.root, 'argv.log');
    const path = join(b.root, 'argv-gbrain');
    writeFileSync(path, '#!/bin/sh\necho "$@" >> \'' + log + '\'\nif [ "$4" = off ]; then printf \'%s\\n\' \'{"verified":true}\'; else printf \'%s\\n\' \'{"state":"off","reason":"stopped","why":"stopped"}\'; fi\n');
    chmodSync(path, 0o755);
    const got = suggestionFor({ launcher: path, noSuggestion: true, dryRun: false, liveServe: null })!;
    expect(got.marker).toMatchObject({ state: 'off', reason: 'stopped' });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--brain host onboarding off --by setup --json', '--brain host onboarding status --json']);
  });

  test('a dry run reports nothing', () => {
    expect(suggestionFor({ launcher: '/nonexistent', noSuggestion: true, dryRun: true, liveServe: null })).toBeNull();
  });

  test('an unverified stop and an unreadable status are unknown, never off', () => {
    const unverified = suggestionFor({ launcher: fakeLauncher({ status: '{"state":"armed"}', off: '{"verified":false}' }), noSuggestion: true, dryRun: false, liveServe: null })!;
    expect(unverified.marker).toMatchObject({ state: 'unknown', reason: 'stop_unverified' });
    expect(unverified.failed).toBe(true);
    const unreadable = suggestionFor({ launcher: fakeLauncher({ status: 'not json' }), noSuggestion: false, dryRun: false, liveServe: null })!;
    expect(unreadable.marker).toMatchObject({ state: 'unknown', reason: 'status_unreadable' });
    const armed = suggestionFor({ launcher: fakeLauncher({ status: '{"state":"armed","why":"armed","delivered_sessions":1,"max_sessions":3,"window_ends_at":null}' }), noSuggestion: false, dryRun: false, liveServe: null })!;
    expect(armed.marker).toMatchObject({ state: 'armed', delivered_sessions: 1 });
  });
});
