// v0.38 Phase C: gbrain schema CLI smoke tests.
//
// Tests the runSchema dispatch + each subcommand's output shape via
// the public CLI entrypoint. Hermetic — spawns the real CLI through
// test/helpers/cli-spawn.ts (async Bun.spawn; DATABASE_URL /
// GBRAIN_DATABASE_URL always stripped; opts.home pins BOTH HOME and
// GBRAIN_HOME in the child). The bundled-pack reads and the error
// paths that exit before touching config are independent of each
// other, so they run once through runCliBatch (width 2 — the
// machine-wide cap, see cli-spawn.ts) in the describe's beforeAll and
// each test asserts on its cached result. Anything that writes config
// (`schema use <pack>`) or needs a pre-seeded home stays a sequential
// await against a per-test home.

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCliBatch, type CliResult } from './helpers/cli-spawn.ts';

// Default-isolated GBRAIN_HOME for every batched call. Without this,
// tests that read `~/.gbrain/config.json` inherit the developer's real
// brain config — and sibling Conductor worktrees writing to the same
// config (e.g. via `schema use` or `config set` during their own tests)
// cause flakes (the failing test pre-fix saw `schema_pack: "gbrain-base-v2"`
// from another worktree, which doesn't exist in the bundle, and got
// exit 1 instead of the asserted 0).
let DEFAULT_GBRAIN_HOME: string;

beforeAll(() => {
  DEFAULT_GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-schema-cli-default-'));
});

afterAll(() => {
  rmSync(DEFAULT_GBRAIN_HOME, { recursive: true, force: true });
});

describe('gbrain schema CLI (Phase C)', () => {
  // Every argv here is read-only against the shared DEFAULT_GBRAIN_HOME:
  // bundled-pack reads, the default-resolution `active`, and error paths
  // verified to exit before any config write (no-arg `use` exits 2 at the
  // usage check in runUse; unknown subcommands exit 2 in the dispatch
  // switch). Do NOT add anything that writes config or depends on another
  // row's side effects — batch order is not execution order.
  const READ_ONLY_ARGVS: string[][] = [
    ['schema'],
    ['schema', 'list'],
    ['schema', 'show', 'gbrain-base'],
    ['schema', 'validate', 'gbrain-base'],
    ['schema', 'show', 'gbrain-recommended'],
    ['schema', 'validate', 'gbrain-recommended'],
    ['schema', 'show', 'gbrain-base-v2'],
    ['schema', 'active'],
    ['schema', 'show', 'nonexistent-pack'],
    ['schema', 'frobnicate'],
    ['schema', 'use'],
  ];

  const batched = new Map<string, CliResult>();

  beforeAll(async () => {
    const results = await runCliBatch(READ_ONLY_ARGVS, { home: DEFAULT_GBRAIN_HOME });
    READ_ONLY_ARGVS.forEach((argv, i) => batched.set(argv.join(' '), results[i]));
  }, 120_000);

  function cached(...argv: string[]): CliResult {
    const r = batched.get(argv.join(' '));
    if (!r) throw new Error(`not in READ_ONLY_ARGVS batch: gbrain ${argv.join(' ')}`);
    return r;
  }

  test('schema with no subcommand shows help text', () => {
    // Note: `schema --help` is intercepted by the CLI's parent help system
    // and prints generic help (`gbrain --help` for full command list). The
    // schema-specific help fires when no subcommand is provided.
    const r = cached('schema');
    expect(r.stdout + r.stderr).toMatch(/schema|active|list|show|validate|use/i);
  });

  test('schema list shows all bundled packs', () => {
    const r = cached('schema', 'list');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Bundled packs:');
    expect(r.stdout).toContain('gbrain-base');
    expect(r.stdout).toContain('gbrain-recommended');
    expect(r.stdout).toContain('gbrain-base-v2');
    expect(r.stdout).toContain('gbrain-investor');
  });

  test('schema show gbrain-base prints manifest details', () => {
    const r = cached('schema', 'show', 'gbrain-base');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('gbrain-base v1.0.0');
    // v0.41.11.0: page types extended from 22 to 24 by promoting
    // `conversation` and `atom` into gbrain-base.
    // v0.41.23.0: extended to 25 by adding `extract_receipt` for the
    // unified extract receipt-writer surface (D-EXTRACT-19 belt+suspenders).
    // v0.42.56.0 (#2390): extended to 27 by adding the Life Chronicle
    // `event` + `diary` temporal types (life/events/, life/diary/).
    expect(r.stdout).toContain('Page types (27)');
    expect(r.stdout).toContain('event :: temporal');
    expect(r.stdout).toContain('diary :: temporal');
    expect(r.stdout).toContain('Link verbs (12)');
    expect(r.stdout).toContain('Takes kinds: fact, take, bet, hunch');
    expect(r.stdout).toContain('person :: entity');
    expect(r.stdout).toContain('company :: entity');
  });

  test('schema validate gbrain-base passes', () => {
    const r = cached('schema', 'validate', 'gbrain-base');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('✓');
    expect(r.stdout).toContain('valid manifest');
  });

  test('schema show/validate exposes bundled gbrain-recommended', () => {
    const show = cached('schema', 'show', 'gbrain-recommended');
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('gbrain-recommended v1.0.0');
    expect(show.stdout).toContain('Page types (');
    expect(show.stdout).toContain('meeting :: temporal');

    const validate = cached('schema', 'validate', 'gbrain-recommended');
    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain('valid manifest');
  });

  test('schema show exposes bundled gbrain-base-v2 successor pack', () => {
    const r = cached('schema', 'show', 'gbrain-base-v2');
    expect(r.exitCode).toBe(0);
    // v1.2.0 (v0.47 open-loop engine): +owes_to +awaiting_reply_from — 15
    // link verbs became 17. (#2117 history: 14 became 15 with `advises`.)
    expect(r.stdout).toContain('gbrain-base-v2 v1.2.0');
    expect(r.stdout).toContain('Page types (');
    expect(r.stdout).toContain('Link verbs (17)');
  });

  test('schema active loads configured gbrain-recommended with real types', async () => {
    // Needs a pre-seeded config.json, so it gets its own home + spawn
    // (never the shared read-only batch).
    const home = mkdtempSync(join(tmpdir(), 'gbrain-schema-active-recommended-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ schema_pack: 'gbrain-recommended' }), 'utf-8');
      const r = await runCli(['schema', 'active'], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Active pack: gbrain-recommended');
      expect(r.stdout).not.toContain('Page types: 0');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('schema active reports default resolution', () => {
    const r = cached('schema', 'active');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Active pack:');
    expect(r.stdout).toContain('Pack identity:');
  });

  test('schema show unknown-pack errors with hint', () => {
    const r = cached('schema', 'show', 'nonexistent-pack');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('Unknown pack');
    expect(r.stderr).toContain('schema list');
  });

  test('unknown subcommand exits with hint', () => {
    const r = cached('schema', 'frobnicate');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Unknown schema subcommand');
  });

  test('schema use without arg shows usage hint', () => {
    const r = cached('schema', 'use');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Usage:');
  });
});

describe('gbrain schema use (Phase C, gap-fill T3)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-schema-use-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('writes schema_pack to ~/.gbrain/config.json on happy path', async () => {
    const r = await runCli(['schema', 'use', 'gbrain-base'], { home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Active schema pack set to: gbrain-base');
    expect(r.stdout).toContain('schema active');
    const cfgPath = join(home, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.schema_pack).toBe('gbrain-base');
  }, 60_000);

  test('preserves pre-existing config fields when writing schema_pack', async () => {
    // Pre-seed a config with engine + a custom key so the merge preserves them.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const cfgPath = join(home, '.gbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', openai_key: 'sk-fake' }, null, 2), 'utf-8');
    const r = await runCli(['schema', 'use', 'gbrain-base'], { home });
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.openai_key).toBe('sk-fake');
    expect(cfg.schema_pack).toBe('gbrain-base');
  }, 60_000);

  test('overwrites prior schema_pack value on re-run', async () => {
    // First set a placeholder, then overwrite via the CLI.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const cfgPath = join(home, '.gbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', schema_pack: 'something-else' }, null, 2), 'utf-8');
    const r = await runCli(['schema', 'use', 'gbrain-base'], { home });
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.schema_pack).toBe('gbrain-base');
  }, 60_000);

  test('unknown pack rejected with exit 1 + paste-ready hint', async () => {
    const r = await runCli(['schema', 'use', 'no-such-pack-xyz'], { home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Unknown pack');
    expect(r.stderr).toContain('schema list');
    // Importantly: a failed `use` must NOT have written a config.
    const cfgPath = join(home, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(false);
  }, 60_000);
});
