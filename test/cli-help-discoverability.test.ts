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
 * These tests spawn `bun run src/cli.ts` as a subprocess so they
 * exercise the real dispatcher flow end-to-end (no mocking of
 * cli.ts internals).
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Absolute path to the CLI entrypoint so `cwd` can be overridden (needed for
// the `sources detach --help` regression test below, which must run with the
// spawned process's cwd pointed at a scratch directory).
const CLI_ENTRY = join(process.cwd(), 'src/cli.ts');

function runCli(args: string[], opts: { cwd?: string } = {}): { stdout: string; stderr: string; status: number } {
  // Hermetic no-brain environment, matching cli-help-without-brain.serial.test.ts:
  // GBRAIN_HOME alone is not enough — loadConfig also honours GBRAIN_DATABASE_URL
  // and DATABASE_URL, so a developer or CI runner exporting either would let the
  // CLI connect anyway and these assertions would go inert.
  const env: Record<string, string | undefined> = {
    ...process.env,
    GBRAIN_HOME: '/tmp/gbrain-test-help-nonexistent',
  };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  // --no-env-file: bun auto-loads .env from cwd, and GBRAIN_DATABASE_URL is
  // honored unconditionally, so a local .env would put back exactly what the
  // deletes above removed.
  const result = spawnSync('bun', ['--no-env-file', 'run', CLI_ENTRY, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('WARN-5 — `gbrain capture --help` reaches the detailed HELP constant', () => {
  test('output contains every documented flag', () => {
    const { stdout, status } = runCli(['capture', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--slug');
    expect(stdout).toContain('--type');
    expect(stdout).toContain('--file');
    expect(stdout).toContain('--stdin');
    expect(stdout).toContain('--source');
    expect(stdout).toContain('--quiet');
    expect(stdout).toContain('--json');
  });

  test('output is NOT the generic short-circuit fallback', () => {
    const { stdout } = runCli(['capture', '--help']);
    // Pre-fix output was: "Usage: gbrain capture\n\ngbrain capture - run gbrain --help ..."
    // Post-fix HELP is much longer and includes Examples.
    expect(stdout).toContain('Examples:');
    expect(stdout.split('\n').length).toBeGreaterThan(10);
    expect(stdout).not.toMatch(/^Usage: gbrain capture\s*$/m);
  });

  test('-h short flag also works', () => {
    const { stdout, status } = runCli(['capture', '-h']);
    expect(status).toBe(0);
    expect(stdout).toContain('--file PATH');
  });
});

describe('WARN-6 — main `gbrain --help` lists capture/brainstorm/lsd', () => {
  test('output mentions all three commands by name', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    // Must appear as command names (not just words in prose somewhere)
    expect(stdout).toMatch(/^\s*capture\s/m);
    expect(stdout).toMatch(/^\s*brainstorm\s/m);
    expect(stdout).toMatch(/^\s*lsd\s/m);
  });

  test('BRAIN section heading is present and groups the three commands', () => {
    const { stdout } = runCli(['--help']);
    expect(stdout).toContain('BRAIN');
    // The 3 commands should appear AFTER the BRAIN heading in textual order.
    const brainIdx = stdout.indexOf('BRAIN');
    expect(brainIdx).toBeGreaterThan(-1);
    expect(stdout.indexOf('capture', brainIdx)).toBeGreaterThan(brainIdx);
    expect(stdout.indexOf('brainstorm', brainIdx)).toBeGreaterThan(brainIdx);
    expect(stdout.indexOf('lsd', brainIdx)).toBeGreaterThan(brainIdx);
  });

  test('regression: existing top-level commands still listed', () => {
    // Snapshot guard against accidentally deleting other groups when we
    // added the BRAIN section. Spot-check a few commands from different
    // groups (SETUP, PAGES, SEARCH, IMPORT/EXPORT).
    const { stdout } = runCli(['--help']);
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
  test('main `gbrain --help` does not advertise install-cron', () => {
    // Pre-fix: `sync --install-cron  Install persistent sync daemon` was
    // listed in the top-level help with no flag parsing or handler behind
    // it anywhere in src/commands/sync.ts — `gbrain sync --install-cron`
    // silently ran an ordinary sync instead of installing anything.
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('install-cron');
    expect(stdout).not.toContain('Install persistent sync daemon');
  });

  test('main `gbrain --help` points sync users at the real continuous-daemon command', () => {
    const { stdout } = runCli(['--help']);
    // autopilot --install already runs sync+extract+embed on a schedule
    // (docs/architecture/KEY_FILES.md); point discoverability there instead
    // of promising a separate sync-only cron installer that never existed.
    expect(stdout).toMatch(/sync --watch \[--interval N\][^\n]*\n\s*See also: autopilot --install/);
  });

  test('`gbrain sync --help` never listed install-cron either', () => {
    const { stdout, status } = runCli(['sync', '--help']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('install-cron');
  });
});

describe('#1175 — main `gbrain --help` SOURCES block matches the real subcommand set', () => {
  test('archive and its lifecycle siblings are listed', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
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

  test('`gbrain extract --help` reaches detailed command help without a configured brain', () => {
    const { stdout, stderr, status } = runCli(['extract', '--help']);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: gbrain extract');
    expect(stdout).not.toContain('run gbrain --help for the full command list');
    for (const flag of implementedFlags) expect(stdout).toContain(flag);
  });

  test('`gbrain extract -h` reaches the same detailed command help', () => {
    const { stdout, status } = runCli(['extract', '-h']);
    expect(status).toBe(0);
    expect(stdout).toContain('--stale');
    expect(stdout).toContain('--include-frontmatter');
  });

  test('main `gbrain --help` documents every implemented extract flag', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    const extractStart = stdout.indexOf('  extract <links|timeline|all>');
    const publishStart = stdout.indexOf('  publish <page.md>', extractStart);
    expect(extractStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(extractStart);
    const extractHelp = stdout.slice(extractStart, publishStart);
    for (const flag of implementedFlags) expect(extractHelp).toContain(flag);
  });
});

describe('sources --help reaches its own usage block instead of the circular generic stub', () => {
  test('`gbrain sources --help` reaches detailed command help without a configured brain', () => {
    const { stdout, stderr, status } = runCli(['sources', '--help']);
    expect(status).toBe(0);
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

  test('`gbrain sources -h` reaches the same detailed command help', () => {
    const { stdout, status } = runCli(['sources', '-h']);
    expect(status).toBe(0);
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
  test('`sources list --help` prints help and does not dispatch into runList (no null-engine crash)', () => {
    const { stdout, stderr, status } = runCli(['sources', 'list', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Subcommands:');
    expect(stdout).not.toContain('run gbrain --help for the full command list');
    // Pre-fix this crashed inside runList with something like
    // "null is not an object (evaluating 'engine.executeRaw')".
    expect(stderr).not.toContain('executeRaw');
    expect(stderr).not.toContain('TypeError');
  });

  test('`sources detach --help` prints help and does NOT delete .gbrain-source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sources-detach-help-'));
    const dotfile = join(dir, '.gbrain-source');
    writeFileSync(dotfile, 'example-source\n');
    try {
      const { stdout, status } = runCli(['sources', 'detach', '--help'], { cwd: dir });
      expect(status).toBe(0);
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
  test('`sources webhook --help` prints the webhook-specific usage (set/show/rotate/clear), not the general SOURCES block', () => {
    const { stdout, status } = runCli(['sources', 'webhook', '--help']);
    expect(status).toBe(0);
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

  test('`sources webhook set x --help` prints webhook help and does NOT reach runWebhookSet', () => {
    const { stdout, stderr, status } = runCli(['sources', 'webhook', 'set', 'x', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: gbrain sources webhook');
    // runWebhookSet's own usage-error / not-found text must never appear —
    // its presence would mean the guard let dispatch fall through to it.
    expect(stdout).not.toContain('Source "x" not found');
    expect(stderr).not.toContain('Source "x" not found');
    expect(stderr).not.toContain('--github-repo');
    expect(stderr).not.toContain('TypeError');
  });
});
