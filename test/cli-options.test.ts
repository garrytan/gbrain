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
    expect(r.cliOpts).toEqual({ quiet: true, progressJson: true, progressInterval: 250, timeoutMs: null, explain: false, brain: null });
    expect(r.rest).toEqual(['sync']);
  });

  // v0.40.4 — --explain flag
  test('--explain sets cliOpts.explain', () => {
    const r = parseGlobalFlags(['--explain', 'search', 'test query']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['search', 'test query']);
  });

  test('--explain absent → false default', () => {
    const r = parseGlobalFlags(['search', 'test query']);
    expect(r.cliOpts.explain).toBe(false);
  });

  test('--explain works in any argv position', () => {
    const r = parseGlobalFlags(['search', '--explain', 'test query']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['search', 'test query']);
  });

  // #4541 — the global claim is scoped to the search/query formatter commands.
  // Pre-fix, parseGlobalFlags claimed --explain for EVERY command, starving
  // extract (`extract --explain timeline` fell through to the WRITE-pass
  // extraction), whoknows, and onboard, which parse the flag themselves.
  test('#4541: extract keeps its own --explain (handed back in place)', () => {
    const r = parseGlobalFlags(['extract', '--explain', 'timeline']);
    expect(r.cliOpts.explain).toBe(false);
    expect(r.rest).toEqual(['extract', '--explain', 'timeline']);
  });

  test('#4541: whoknows keeps its own --explain', () => {
    const r = parseGlobalFlags(['whoknows', 'fintech compliance', '--explain']);
    expect(r.cliOpts.explain).toBe(false);
    expect(r.rest).toEqual(['whoknows', 'fintech compliance', '--explain']);
  });

  test('#4541: onboard keeps its own --explain', () => {
    const r = parseGlobalFlags(['onboard', '--check', '--explain']);
    expect(r.cliOpts.explain).toBe(false);
    expect(r.rest).toEqual(['onboard', '--check', '--explain']);
  });

  test('#4541: query still claims --explain globally', () => {
    const r = parseGlobalFlags(['query', 'who is alice-example', '--explain']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['query', 'who is alice-example']);
  });

  test('#4541: ask (query alias) still claims --explain globally', () => {
    const r = parseGlobalFlags(['ask', 'who is alice-example', '--explain']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['ask', 'who is alice-example']);
  });

  test('wave-g: call claims --explain — never handed into op positional args', () => {
    // `gbrain call <op>` maps leftover argv into op params; a handed-back
    // --explain would surface as an unknown-parameter error instead of
    // being ignored (the pre-#4541 global behavior).
    const r = parseGlobalFlags(['call', 'query', '--explain']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['call', 'query']);
  });

  // #4557 — #4541 only fixed the case where --explain follows the command
  // (`extract --explain timeline`). It missed the documented global-flag-
  // FIRST invocation style (`gbrain --progress-json doctor` per this file's
  // own header comment): a handed-back --explain landed at its ORIGINAL
  // position, which for `--explain extract timeline` is rest[0] — and
  // cli.ts dispatches on `args[0]` as the command, so the literal string
  // '--explain' got treated as the command and dispatch broke for EVERY
  // non-claiming command invoked this way.
  test('#4557: --explain before a non-claiming command does not break dispatch', () => {
    const r = parseGlobalFlags(['--explain', 'extract', 'timeline']);
    expect(r.rest[0]).toBe('extract'); // the command, not '--explain'
    expect(r.cliOpts.explain).toBe(false);
    expect(r.rest).toEqual(['extract', '--explain', 'timeline']);
  });

  test('#4557: --explain-before-command keeps the exact shape --explain-after-command already had', () => {
    // The fix must not touch the already-correct after-command case while
    // fixing the before-command one — both invocation styles of the same
    // command should hand the flag back in the identical spot relative to
    // the command and any following positional value.
    const before = parseGlobalFlags(['--explain', 'extract', 'timeline']);
    const after = parseGlobalFlags(['extract', '--explain', 'timeline']);
    expect(before.rest).toEqual(after.rest);
  });

  test('#4557: repeated --explain before the command matches the pre-existing repeated-flag shape after it (documented, not fixed here)', () => {
    // Out of scope for this fix: extract-explain.ts resolves its <kind>
    // argument via a naive `args.indexOf('--explain') + 1`, so a SECOND
    // --explain shadows the first one's intended value regardless of
    // where the pair sits relative to the command — this was already true
    // pre-#4557 for `extract --explain --explain timeline` (unaffected by
    // this change) and stays true post-#4557 for the previously-broken
    // `--explain --explain extract timeline` too. This test pins parity
    // between the two placements, not correctness of the double-flag case
    // itself — a real fix belongs in extract-explain.ts's kind lookup.
    const before = parseGlobalFlags(['--explain', '--explain', 'extract', 'timeline']);
    const after = parseGlobalFlags(['extract', '--explain', '--explain', 'timeline']);
    expect(before.rest).toEqual(after.rest);
    expect(before.rest).toEqual(['extract', '--explain', '--explain', 'timeline']);
  });

  test('#4557: --quiet --explain <non-claiming command> preserves both flags and dispatch', () => {
    const r = parseGlobalFlags(['--quiet', '--explain', 'extract', 'timeline']);
    expect(r.cliOpts.quiet).toBe(true);
    expect(r.rest[0]).toBe('extract');
    expect(r.rest).toEqual(['extract', '--explain', 'timeline']);
  });

  test('#4557: --explain before an unrecognized command still dispatches on the command, not --explain', () => {
    const r = parseGlobalFlags(['--explain', 'not-a-real-command']);
    expect(r.rest[0]).toBe('not-a-real-command');
    expect(r.rest).toEqual(['not-a-real-command', '--explain']);
  });

  test('#4557: --explain before query still claims globally (unaffected by the reorder fix)', () => {
    const r = parseGlobalFlags(['--explain', 'query', 'who is alice-example']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['query', 'who is alice-example']);
  });

  test('#4557: bare --explain with no command at all does not throw', () => {
    const r = parseGlobalFlags(['--explain']);
    expect(r.cliOpts.explain).toBe(false);
    expect(r.rest).toEqual(['--explain']);
  });
});

describe('getCliOptions / setCliOptions singleton', () => {
  test('defaults when never set', () => {
    _resetCliOptionsForTest();
    expect(getCliOptions()).toEqual(DEFAULT_CLI_OPTIONS);
  });

  test('setCliOptions applies + getCliOptions returns a copy', () => {
    _resetCliOptionsForTest();
    setCliOptions({ quiet: false, progressJson: true, progressInterval: 250, timeoutMs: null, explain: false, brain: null });
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

  // #4557 — end-to-end proof that the parseGlobalFlags fix actually reaches
  // real command dispatch in cli.ts, not just the unit-tested return value.
  // No DB/engine needed: an unrecognized command hits the dispatcher's
  // `Unknown command: <command>` error (src/cli.ts) before any engine
  // connect, so this differentiates "the real command was dispatched on"
  // from "the literal '--explain' string was dispatched on" — the exact
  // failure this fix corrects.
  test('#4557: gbrain --explain <command> dispatches on the command, not on --explain', () => {
    const res = spawnSync('bun', [CLI, '--explain', 'not-a-real-command-4557'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown command: not-a-real-command-4557');
    expect(res.stderr).not.toContain('Unknown command: --explain');
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
    const opts = cliOptsToProgressOptions({ quiet: true, progressJson: false, progressInterval: 1000, timeoutMs: null, explain: false, brain: null });
    expect(opts.mode).toBe('quiet');
  });

  test('--progress-json → json mode with interval', () => {
    const opts = cliOptsToProgressOptions({ quiet: false, progressJson: true, progressInterval: 500, timeoutMs: null, explain: false, brain: null });
    expect(opts.mode).toBe('json');
    expect(opts.minIntervalMs).toBe(500);
  });

  test('defaults → auto mode', () => {
    const opts = cliOptsToProgressOptions(DEFAULT_CLI_OPTIONS);
    expect(opts.mode).toBe('auto');
    expect(opts.minIntervalMs).toBe(1000);
  });

  test('quiet takes priority over progressJson', () => {
    const opts = cliOptsToProgressOptions({ quiet: true, progressJson: true, progressInterval: 1000, timeoutMs: null, explain: false, brain: null });
    expect(opts.mode).toBe('quiet');
  });
});

// v0.31.1: --timeout flag tests
describe('--timeout flag', () => {
  test('--timeout=30s → 30000ms', () => {
    const r = parseGlobalFlags(['--timeout=30s', 'search', 'X']);
    expect(r.cliOpts.timeoutMs).toBe(30_000);
    expect(r.rest).toEqual(['search', 'X']);
  });

  test('--timeout 1.5s → 1500ms', () => {
    const r = parseGlobalFlags(['--timeout', '1.5s', 'search']);
    expect(r.cliOpts.timeoutMs).toBe(1500);
    expect(r.rest).toEqual(['search']);
  });

  test('--timeout=2m → 120000ms', () => {
    const r = parseGlobalFlags(['--timeout=2m']);
    expect(r.cliOpts.timeoutMs).toBe(120_000);
  });

  test('--timeout=500ms → 500ms', () => {
    const r = parseGlobalFlags(['--timeout=500ms']);
    expect(r.cliOpts.timeoutMs).toBe(500);
  });

  test('--timeout=500 (bare number, default ms)', () => {
    const r = parseGlobalFlags(['--timeout=500']);
    expect(r.cliOpts.timeoutMs).toBe(500);
  });

  test('--timeout=garbage → falls through, timeoutMs stays null', () => {
    const r = parseGlobalFlags(['--timeout=garbage', 'search']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toContain('--timeout=garbage');
  });

  test('--timeout=0 rejected (must be positive)', () => {
    const r = parseGlobalFlags(['--timeout=0']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toContain('--timeout=0');
  });

  test('default timeoutMs is null (per-command default applies)', () => {
    const r = parseGlobalFlags(['search', 'X']);
    expect(r.cliOpts.timeoutMs).toBe(null);
  });
});

describe('--brain flag (brain axis routing)', () => {
  test('--brain <id> space form: parsed + stripped from rest', () => {
    const r = parseGlobalFlags(['query', 'X', '--brain', 'media-team']);
    expect(r.cliOpts.brain).toBe('media-team');
    expect(r.rest).toEqual(['query', 'X']);
  });

  test('--brain=<id> equals form: parsed + stripped from rest', () => {
    const r = parseGlobalFlags(['--brain=media-team', 'query', 'X']);
    expect(r.cliOpts.brain).toBe('media-team');
    expect(r.rest).toEqual(['query', 'X']);
  });

  test('--brain host is a valid explicit value', () => {
    const r = parseGlobalFlags(['stats', '--brain', 'host']);
    expect(r.cliOpts.brain).toBe('host');
  });

  test('missing value throws (loud, never a silent host fallback)', () => {
    expect(() => parseGlobalFlags(['query', 'X', '--brain'])).toThrow(/--brain requires a value/);
    expect(() => parseGlobalFlags(['--brain=', 'query'])).toThrow(/--brain requires a value/);
    // A following flag is not a value.
    expect(() => parseGlobalFlags(['--brain', '--quiet'])).toThrow(/--brain requires a value/);
  });

  test('malformed id throws (validated at parse time)', () => {
    expect(() => parseGlobalFlags(['--brain', 'Bad_Id!'])).toThrow(/Invalid --brain value/);
    expect(() => parseGlobalFlags(['--brain=$(rm -rf /)'])).toThrow(/Invalid --brain value/);
  });

  test('--brain-* per-command flags pass through untouched (skillopt collision guard)', () => {
    const r = parseGlobalFlags(['skillopt', '--brain-wide-max-cost-usd', '5']);
    expect(r.cliOpts.brain).toBe(null);
    expect(r.rest).toEqual(['skillopt', '--brain-wide-max-cost-usd', '5']);
  });

  test('default brain is null (ambient resolution applies)', () => {
    const r = parseGlobalFlags(['query', 'X']);
    expect(r.cliOpts.brain).toBe(null);
  });
});

describe('childGlobalFlags propagates --brain', () => {
  test('explicit brain rides into child gbrain subprocess commands', async () => {
    const { childGlobalFlags } = await import('../src/core/cli-options.ts');
    expect(childGlobalFlags({ ...DEFAULT_CLI_OPTIONS, brain: 'media-team' }))
      .toContain('--brain=media-team');
    expect(childGlobalFlags({ ...DEFAULT_CLI_OPTIONS })).not.toContain('--brain');
  });
});
