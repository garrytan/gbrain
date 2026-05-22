import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseGlobalFlags, cliOptsToProgressOptions, DEFAULT_CLI_OPTIONS, setCliOptions, getCliOptions, _resetCliOptionsForTest } from '../src/core/cli-options.ts';

describe('parseGlobalFlags', () => {
  test('empty argv → defaults, empty rest', () => {
    const r = parseGlobalFlags([]);
    expect(r.cliOpts).toEqual(DEFAULT_CLI_OPTIONS);
    expect(r.rest).toEqual([]);
  });

  test('strips --quiet from argv and sets quiet=true', () => {
    // Per-command handlers that historically parsed their own --quiet
    // (skillpack-check) now read the resolved CliOptions singleton via
    // getCliOptions() — see src/core/cli-options.ts.
    const r = parseGlobalFlags(['--quiet', 'doctor', '--fast']);
    expect(r.cliOpts.quiet).toBe(true);
    expect(r.cliOpts.progressJson).toBe(false);
    expect(r.rest).toEqual(['doctor', '--fast']);
  });

  test('strips --progress-json from argv', () => {
    const r = parseGlobalFlags(['--progress-json', 'doctor']);
    expect(r.cliOpts.progressJson).toBe(true);
    expect(r.rest).toEqual(['doctor']);
  });

  test('--progress-interval=500 form', () => {
    const r = parseGlobalFlags(['--progress-interval=500', 'embed']);
    expect(r.cliOpts.progressInterval).toBe(500);
    expect(r.rest).toEqual(['embed']);
  });

  test('--progress-interval 500 space-separated form', () => {
    const r = parseGlobalFlags(['--progress-interval', '500', 'embed']);
    expect(r.cliOpts.progressInterval).toBe(500);
    expect(r.rest).toEqual(['embed']);
  });

  test('global flag interleaved mid-argv still stripped', () => {
    const r = parseGlobalFlags(['doctor', '--progress-json', '--fast']);
    expect(r.cliOpts.progressJson).toBe(true);
    expect(r.rest).toEqual(['doctor', '--fast']);
  });

  test('invalid --progress-interval value passes through (per-command parser can handle it)', () => {
    const r = parseGlobalFlags(['--progress-interval=abc', 'doctor']);
    // Unparseable value → leave the flag in rest, default interval kept.
    expect(r.cliOpts.progressInterval).toBe(DEFAULT_CLI_OPTIONS.progressInterval);
    expect(r.rest).toEqual(['--progress-interval=abc', 'doctor']);
  });

  test('negative --progress-interval rejected', () => {
    const r = parseGlobalFlags(['--progress-interval=-1', 'doctor']);
    expect(r.cliOpts.progressInterval).toBe(DEFAULT_CLI_OPTIONS.progressInterval);
    expect(r.rest).toContain('--progress-interval=-1');
  });

  test('unknown flags pass through unchanged', () => {
    const r = parseGlobalFlags(['doctor', '--fast', '--json', '--foo=bar']);
    expect(r.rest).toEqual(['doctor', '--fast', '--json', '--foo=bar']);
    expect(r.cliOpts).toEqual(DEFAULT_CLI_OPTIONS);
  });

  test('all global flags combined', () => {
    const r = parseGlobalFlags(['--quiet', '--progress-json', '--progress-interval=250', 'sync']);
    expect(r.cliOpts).toEqual({ quiet: true, progressJson: true, progressInterval: 250 });
    expect(r.rest).toEqual(['sync']);
  });
});

describe('getCliOptions / setCliOptions singleton', () => {
  test('defaults when never set', () => {
    _resetCliOptionsForTest();
    expect(getCliOptions()).toEqual(DEFAULT_CLI_OPTIONS);
  });

  test('setCliOptions applies + getCliOptions returns a copy', () => {
    _resetCliOptionsForTest();
    setCliOptions({ quiet: false, progressJson: true, progressInterval: 250 });
    expect(getCliOptions().progressJson).toBe(true);
    expect(getCliOptions().progressInterval).toBe(250);
  });
});

describe('cli.ts global-flag stripping (integration)', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

  test('gbrain --progress-json --version works (global flag stripped before dispatch)', () => {
    const res = spawnSync('bun', [CLI, '--progress-json', '--version'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('gbrain ');
  });

  test('gbrain --quiet --progress-interval=500 version works (flags interleaved, all stripped)', () => {
    const res = spawnSync('bun', [CLI, '--quiet', '--progress-interval=500', 'version'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('gbrain ');
  });
});

describe('CLI integration: progress streams to the right channel', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

  test('gbrain --progress-json --version emits only the version on stdout', () => {
    // `version` is a single-shot command that goes through the main()
    // dispatch path. We want to confirm --progress-json doesn't force
    // stray progress onto stdout for commands that don't use a reporter.
    const res = spawnSync('bun', [CLI, '--progress-json', '--version'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^gbrain /);
    // No JSON progress object should end up on stdout.
    expect(res.stdout).not.toContain('"event":"start"');
  });

  test('gbrain --quiet skillpack-check returns exit code with no stdout', () => {
    // Regression guard for the flag-collision that skillpack-check hit
    // when --quiet briefly passed through argv. Now it reads the singleton.
    const res = spawnSync('bun', [CLI, '--quiet', 'skillpack-check'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    // Exit may be 0 or 1 depending on whether a brain is configured;
    // what matters is stdout stays empty.
    expect(res.stdout).toBe('');
  });
});

describe('cliOptsToProgressOptions', () => {
  test('--quiet → quiet mode', () => {
    const opts = cliOptsToProgressOptions({ quiet: true, progressJson: false, progressInterval: 1000 });
    expect(opts.mode).toBe('quiet');
  });

  test('--progress-json → json mode with interval', () => {
    const opts = cliOptsToProgressOptions({ quiet: false, progressJson: true, progressInterval: 500 });
    expect(opts.mode).toBe('json');
    expect(opts.minIntervalMs).toBe(500);
  });

  test('defaults → auto mode', () => {
    const opts = cliOptsToProgressOptions(DEFAULT_CLI_OPTIONS);
    expect(opts.mode).toBe('auto');
    expect(opts.minIntervalMs).toBe(1000);
  });

  test('quiet takes priority over progressJson', () => {
    const opts = cliOptsToProgressOptions({ quiet: true, progressJson: true, progressInterval: 1000 });
    expect(opts.mode).toBe('quiet');
  });
});
