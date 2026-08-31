/**
 * v0.39.3.0 WARN-5 + WARN-6 — CLI help discoverability.
 *
 * WARN-5: `gbrain capture --help` was showing only the generic
 * `Usage: gbrain capture` line because `capture` was missing from
 * CLI_ONLY_SELF_HELP (src/cli.ts:34-53). Fix added it to the set AND
 * added a pre-engine-bind `--help` short-circuit at handleCliOnly so
 * the HELP constant is reachable on a fresh tmpdir with no config.
 *
 * WARN-6: `capture`, `brainstorm`, `lsd` were missing from the main
 * `gbrain --help` text. Added a BRAIN section to printHelp.
 *
 * These tests spawn `bun src/cli.ts` as a subprocess so they exercise
 * the real dispatcher flow end-to-end (no mocking of cli.ts internals).
 * Help output is read-only, so calls route through runCliMemo
 * (test/helpers/cli-spawn.ts) — one spawn per unique argv (`--help`
 * repeats 8x, `takes --help` 3x, ...). The lone un-memoized call is
 * `sources detach --help`: it depends on cwd and asserts a filesystem
 * non-side-effect, both outside the memo's argv+home key.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCliMemo } from './helpers/cli-spawn.ts';

// Hermetic no-brain environment, matching cli-help-without-brain.serial.test.ts:
// GBRAIN_HOME alone is not enough — loadConfig also honours GBRAIN_DATABASE_URL
// and DATABASE_URL, so a developer or CI runner exporting either would let the
// CLI connect anyway and these assertions would go inert. cli-spawn strips both
// from every child env; opts.home points HOME + GBRAIN_HOME at a nonexistent
// dir. The helper also spawns with `bun --no-env-file` (as the old local
// wrapper did) so a repo-root .env cannot re-add the stripped vars.
const NO_BRAIN_HOME = '/tmp/gbrain-test-help-nonexistent';

// Memoized: identical argv returns the cached CliResult without respawning.
// Safe here because every invocation is a pure --help/-h read.
function help(args: string[]) {
  return runCliMemo(args, { home: NO_BRAIN_HOME });
}

describe('WARN-5 — `gbrain capture --help` reaches the detailed HELP constant', () => {
  test('output contains every documented flag', async () => {
    const { stdout, exitCode } = await help(['capture', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--slug');
    expect(stdout).toContain('--type');
    expect(stdout).toContain('--file');
    expect(stdout).toContain('--stdin');
    expect(stdout).toContain('--source');
    expect(stdout).toContain('--quiet');
    expect(stdout).toContain('--json');
  });

  test('output is NOT the generic short-circuit fallback', async () => {
    const { stdout } = await help(['capture', '--help']);
    // Pre-fix output was: "Usage: gbrain capture\n\ngbrain capture - run gbrain --help ..."
    // Post-fix HELP is much longer and includes Examples.
    expect(stdout).toContain('Examples:');
    expect(stdout.split('\n').length).toBeGreaterThan(10);
    expect(stdout).not.toMatch(/^Usage: gbrain capture\s*$/m);
  });

  test('-h short flag also works', async () => {
    const { stdout, exitCode } = await help(['capture', '-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--file PATH');
  });
});

describe('WARN-6 — main `gbrain --help` lists capture/brainstorm/lsd', () => {
  test('output mentions all three commands by name', async () => {
    const { stdout, exitCode } = await help(['--help']);
    expect(exitCode).toBe(0);
    // Must appear as command names (not just words in prose somewhere)
    expect(stdout).toMatch(/^\s*capture\s/m);
    expect(stdout).toMatch(/^\s*brainstorm\s/m);
    expect(stdout).toMatch(/^\s*lsd\s/m);
  });

  test('BRAIN section heading is present and groups the three commands', async () => {
    const { stdout } = await help(['--help']);
    expect(stdout).toContain('BRAIN');
    // The 3 commands should appear AFTER the BRAIN heading in textual order.
    const brainIdx = stdout.indexOf('BRAIN');
    expect(brainIdx).toBeGreaterThan(-1);
    expect(stdout.indexOf('capture', brainIdx)).toBeGreaterThan(brainIdx);
    expect(stdout.indexOf('brainstorm', brainIdx)).toBeGreaterThan(brainIdx);
    expect(stdout.indexOf('lsd', brainIdx)).toBeGreaterThan(brainIdx);
  });

  test('regression: existing top-level commands still listed', async () => {
    // Snapshot guard against accidentally deleting other groups when we
    // added the BRAIN section. Spot-check a few commands from different
    // groups (SETUP, PAGES, SEARCH, IMPORT/EXPORT).
    const { stdout } = await help(['--help']);
    expect(stdout).toContain('init');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('get');
    expect(stdout).toContain('search');
    expect(stdout).toContain('query');
    expect(stdout).toContain('import');
    expect(stdout).toContain('export');
    expect(stdout).toContain('files');
    expect(stdout).toContain('embed');
  });
});

describe('#2795 — `sync --install-cron` help line no longer promises an unbuilt feature', () => {
  test('main `gbrain --help` does not advertise install-cron', async () => {
    // Pre-fix: `sync --install-cron  Install persistent sync daemon` was
    // listed in the top-level help with no flag parsing or handler behind
    // it anywhere in src/commands/sync.ts — `gbrain sync --install-cron`
    // silently ran an ordinary sync instead of installing anything.
    const { stdout, exitCode } = await help(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('install-cron');
    expect(stdout).not.toContain('Install persistent sync daemon');
  });

  test('main `gbrain --help` points sync users at the real continuous-daemon command', async () => {
    const { stdout } = await help(['--help']);
    // autopilot --install already runs sync+extract+embed on a schedule
    // (docs/architecture/KEY_FILES.md); point discoverability there instead
    // of promising a separate sync-only cron installer that never existed.
    expect(stdout).toMatch(/sync --watch \[--interval N\][^\n]*\n\s*See also: autopilot --install/);
  });

  test('`gbrain sync --help` never listed install-cron either', async () => {
    const { stdout, exitCode } = await help(['sync', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('install-cron');
  });
});

describe('#1175 — main `gbrain --help` SOURCES block matches the real subcommand set', () => {
  test('archive and its lifecycle siblings are listed', async () => {
    const { stdout, exitCode } = await help(['--help']);
    expect(exitCode).toBe(0);
    // Pre-fix the SOURCES block listed only list/add/remove; the soft-delete
    // alternative that `sources remove` itself recommends was undiscoverable.
    expect(stdout).toMatch(/^\s*sources archive <id>\s/m);
    expect(stdout).toMatch(/^\s*sources restore <id>\s/m);
    expect(stdout).toMatch(/^\s*sources archived\s/m);
    expect(stdout).toMatch(/^\s*sources purge/m);
    expect(stdout).toMatch(/^\s*sources status\s/m);
    // Pointer at the full per-subcommand help for the long tail.
    expect(stdout).toMatch(/^\s*sources --help\s/m);
  });
});

describe('#4003 — `gbrain auth --help` reaches the detailed usage block', () => {
  test('output contains the real auth subcommand usage, not the generic stub', async () => {
    const { stdout, exitCode } = await help(['auth', '--help']);
    expect(exitCode).toBe(0);
    // Pre-fix: `auth` was missing from CLI_ONLY_SELF_HELP, so this printed
    // only "gbrain auth - run gbrain --help for the full command list."
    expect(stdout).toContain('GBrain Token Management');
    expect(stdout).toContain('gbrain auth create <name>');
    expect(stdout).toContain('gbrain auth register-client');
    expect(stdout).not.toContain('run gbrain --help for the full command list');
  });

  test('-h short flag also works', async () => {
    const { stdout, exitCode } = await help(['auth', '-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain Token Management');
  });

  test('main `gbrain --help` lists auth', async () => {
    const { stdout, exitCode } = await help(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\s*auth </m);
    expect(stdout).toMatch(/^\s*auth --help\s/m);
  });
});

describe('#4083 follow-up — auth subcommand + --help shows usage, never executes', () => {
  // Caught by automated PR review on #4083: once `auth` joined
  // CLI_ONLY_SELF_HELP, the generic --help short-circuit in cli.ts stopped
  // intercepting `gbrain auth <subcommand> --help` before it reached
  // runAuth. Without an early --help check inside runAuth itself, a
  // trailing --help on a real subcommand fell through to that
  // subcommand's real handler instead of showing help — e.g. `gbrain auth
  // create foo --help` would mint a real token named "foo".
  test('`gbrain auth create <name> --help` shows usage, does not create a token', async () => {
    const { stdout, exitCode } = await help(['auth', 'create', 'definitely-not-a-real-token-name', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain Token Management');
    expect(stdout).not.toContain('Token created for');
  });

  test('`gbrain auth revoke <name> --help` shows usage, does not attempt a revoke', async () => {
    const { stdout, exitCode } = await help(['auth', 'revoke', 'definitely-not-a-real-token-name', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain Token Management');
  });

  test('`gbrain auth register-client <name> --help` shows usage, does not register a client', async () => {
    const { stdout, exitCode } = await help(['auth', 'register-client', 'definitely-not-a-real-client', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain Token Management');
  });

  test('-h works the same way as --help on a subcommand', async () => {
    const { stdout, exitCode } = await help(['auth', 'create', 'definitely-not-a-real-token-name', '-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain Token Management');
    expect(stdout).not.toContain('Token created for');
  });
});

describe('#3834 — extract flags are discoverable from both help surfaces', () => {
  const implementedFlags = [
    '--by-mention',
    '--catch-up',
    '--concurrency',
    '--explain',
    '--from-meetings',
    '--include-frontmatter',
    '--infer-dates',
    '--ner',
    '--source-id',
    '--stale',
    '--workers',
  ];

  test('`gbrain extract --help` reaches detailed command help without a configured brain', async () => {
    const { stdout, stderr, exitCode } = await help(['extract', '--help']);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: gbrain extract');
    expect(stdout).not.toContain('run gbrain --help for the full command list');
    for (const flag of implementedFlags) expect(stdout).toContain(flag);
  });

  test('`gbrain extract -h` reaches the same detailed command help', async () => {
    const { stdout, exitCode } = await help(['extract', '-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--stale');
    expect(stdout).toContain('--include-frontmatter');
  });

  test('main `gbrain --help` documents every implemented extract flag', async () => {
    const { stdout, exitCode } = await help(['--help']);
    expect(exitCode).toBe(0);
    const extractStart = stdout.indexOf('  extract <links|timeline|all>');
    const publishStart = stdout.indexOf('  publish <page.md>', extractStart);
    expect(extractStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(extractStart);
    const extractHelp = stdout.slice(extractStart, publishStart);
    for (const flag of implementedFlags) expect(extractHelp).toContain(flag);
  });
});

describe('sources --help reaches its own usage block instead of the circular generic stub', () => {
  test('`gbrain sources --help` reaches detailed command help without a configured brain', async () => {
    const { stdout, stderr, exitCode } = await help(['sources', '--help']);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Subcommands:');
    // Pre-fix output was the generic short-circuit, which itself points back
    // at `gbrain --help` — a circular pointer, since the top-level help's own
    // SOURCES block promises `sources --help` as the place to find these.
    expect(stdout).not.toContain('run gbrain --help for the full command list');
    // Subcommands the top-level `gbrain --help` SOURCES block does NOT list
    // (it only lists list/add/remove/archive/restore/archived/purge/status)
    // and instead defers to `sources --help` for.
    expect(stdout).toContain('rename');
    expect(stdout).toContain('set-cr-mode');
    expect(stdout).toContain('federate');
    expect(stdout).toContain('attach');
    expect(stdout).toContain('harden');
  });

  test('`gbrain sources -h` reaches the same detailed command help', async () => {
    const { stdout, exitCode } = await help(['sources', '-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('set-cr-mode');
    expect(stdout).not.toContain('run gbrain --help for the full command list');
  });
});

describe('regression: nested `sources <sub> --help` must print help, not dispatch to <sub>', () => {
  // `hasHelpFlag` in src/cli.ts matches --help/-h in ANY position, which is
  // what routes `sources list --help` into SELF_HELP_WITHOUT_ENGINE with a
  // placeholder null engine. Before the sources.ts guard, runSources's
  // switch dispatched on args[0] only ('list'), so the '--help' in position
  // 1 was silently dropped and runList(nullEngine, ['--help']) actually ran
  // — crashing on the placeholder engine. Some subcommands (`detach`) don't
  // even touch the engine and would perform their real, destructive action
  // instead of crashing.
  test('`sources list --help` prints help and does not dispatch into runList (no null-engine crash)', async () => {
    const { stdout, stderr, exitCode } = await help(['sources', 'list', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Subcommands:');
    expect(stdout).not.toContain('run gbrain --help for the full command list');
    // Pre-fix this crashed inside runList with something like
    // "null is not an object (evaluating 'engine.executeRaw')".
    expect(stderr).not.toContain('executeRaw');
    expect(stderr).not.toContain('TypeError');
  });

  test('`sources detach --help` prints help and does NOT delete .gbrain-source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sources-detach-help-'));
    const dotfile = join(dir, '.gbrain-source');
    writeFileSync(dotfile, 'example-source\n');
    try {
      // Un-memoized on purpose: the spawned process's cwd must point at the
      // scratch directory, and the assertion is a filesystem non-side-effect
      // — neither is part of runCliMemo's argv+home cache key.
      const { stdout, exitCode } = await runCli(['sources', 'detach', '--help'], {
        home: NO_BRAIN_HOME,
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Subcommands:');
      // The regression: runDetach() takes no engine and unconditionally
      // unlinks .gbrain-source — with no guard, `detach --help` silently
      // deletes the caller's dotfile instead of showing usage.
      expect(existsSync(dotfile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('`sources webhook --help` reaches its own detailed help, not the general block or runWebhook*', () => {
  test('`sources webhook --help` prints the webhook-specific usage (set/show/rotate/clear), not the general SOURCES block', async () => {
    const { stdout, exitCode } = await help(['sources', 'webhook', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: gbrain sources webhook');
    expect(stdout).toContain('rotate <id>');
    expect(stdout).toContain('clear <id>');
    expect(stdout).toContain('One-time reveal');
    // The general block's opening line + a subcommand only it lists —
    // absence of both confirms this reached SOURCES_WEBHOOK_HELP, not
    // printHelp().
    expect(stdout).not.toContain('gbrain sources — manage multi-source brain configuration');
    expect(stdout).not.toContain('add <id> --path');
  });

  test('`sources webhook set x --help` prints webhook help and does NOT reach runWebhookSet', async () => {
    const { stdout, stderr, exitCode } = await help(['sources', 'webhook', 'set', 'x', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: gbrain sources webhook');
    // runWebhookSet's own usage-error / not-found text must never appear —
    // its presence would mean the guard let dispatch fall through to it.
    expect(stdout).not.toContain('Source "x" not found');
    expect(stderr).not.toContain('Source "x" not found');
    expect(stderr).not.toContain('--github-repo');
    expect(stderr).not.toContain('TypeError');
  });
});

describe('`gbrain takes --help` reaches the detailed subcommand block', () => {
  test('every mutate + read subcommand is listed', async () => {
    const { stdout, exitCode } = await help(['takes', '--help']);
    expect(exitCode).toBe(0);
    // Pre-fix these were undiscoverable from the CLI: `takes` was in CLI_ONLY
    // but not CLI_ONLY_SELF_HELP, so the generic stub fired before runTakes.
    expect(stdout).toContain('takes add');
    expect(stdout).toContain('takes update');
    expect(stdout).toContain('takes supersede');
    expect(stdout).toContain('takes resolve');
    expect(stdout).toContain('takes scorecard');
    expect(stdout).toContain('takes calibration');
    expect(stdout).toContain('takes search');
  });

  test('output is NOT the generic short-circuit fallback', async () => {
    const { stdout } = await help(['takes', '--help']);
    // Pre-fix output was exactly: "Usage: gbrain takes\n\ngbrain takes - run
    // gbrain --help for the full command list."
    expect(stdout).not.toContain('run gbrain --help for the full command list');
    expect(stdout).not.toMatch(/^Usage: gbrain takes\s*$/m);
    expect(stdout.split('\n').length).toBeGreaterThan(10);
  });

  test('help works with no brain configured (pre-engine-bind branch)', async () => {
    // `help` points GBRAIN_HOME at a nonexistent dir. Without the pre-engine
    // branch this printed "No brain configured. Run: gbrain init".
    const { stdout, exitCode } = await help(['takes', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('No brain configured');
    expect(stdout).toContain('--dir <path>');
  });
});
