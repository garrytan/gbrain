import { describe, test, expect } from 'bun:test';
import { parseGlobalFlags, cliOptsToProgressOptions, DEFAULT_CLI_OPTIONS } from '../src/core/cli-options.ts';

describe('parseGlobalFlags', () => {
  test('empty argv → defaults, empty rest', () => {
    const r = parseGlobalFlags([]);
    expect(r.cliOpts).toEqual(DEFAULT_CLI_OPTIONS);
    expect(r.rest).toEqual([]);
  });

  test('strips --quiet from argv and sets quiet=true', () => {
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
