// v0.38 Phase C: gbrain schema CLI smoke tests.
//
// Tests the runSchema dispatch + each subcommand's output shape via
// the public CLI entrypoint. Hermetic — uses Bun's subprocess to run
// the CLI like a user would.

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

// Default-isolated GBRAIN_HOME for every gbrain() call. Without this,
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

function gbrain(
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; code: number } {
  // bun's spawnSync does NOT inherit env mutations done via process.env = ...,
  // so pass env explicitly. CLAUDE.md flags this pattern as load-bearing for
  // any subprocess test that needs GBRAIN_HOME isolation.
  const env = { ...process.env, GBRAIN_HOME: DEFAULT_GBRAIN_HOME, ...extraEnv };
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

describe('gbrain schema CLI (Phase C)', () => {
  test('schema with no subcommand shows help text', () => {
    // Note: `schema --help` is intercepted by the CLI's parent help system
    // and prints generic help (`gbrain --help` for full command list). The
    // schema-specific help fires when no subcommand is provided.
    const r = gbrain(['schema']);
    expect(r.stdout + r.stderr).toMatch(/schema|active|list|show|validate|use/i);
  });

  test('schema list shows gbrain-base bundled', () => {
    const r = gbrain(['schema', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Bundled packs:');
    expect(r.stdout).toContain('gbrain-base');
  });

  test('schema show gbrain-base prints manifest details', () => {
    const r = gbrain(['schema', 'show', 'gbrain-base']);
    expect(r.code).toBe(0);
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
    const r = gbrain(['schema', 'validate', 'gbrain-base']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓');
    expect(r.stdout).toContain('valid manifest');
  });

  test('schema active reports default resolution', () => {
    const r = gbrain(['schema', 'active']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Active pack:');
    expect(r.stdout).toContain('Pack identity:');
  });

  test('schema show unknown-pack errors with hint', () => {
    const r = gbrain(['schema', 'show', 'nonexistent-pack']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown pack');
    expect(r.stderr).toContain('schema list');
  });

  test('unknown subcommand exits with hint', () => {
    const r = gbrain(['schema', 'frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown schema subcommand');
  });

  test('schema use without arg shows usage hint', () => {
    const r = gbrain(['schema', 'use']);
    expect(r.code).toBe(2);
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

  test('writes schema_pack to ~/.gbrain/config.json on happy path', () => {
    const r = gbrain(['schema', 'use', 'gbrain-base'], { GBRAIN_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Active schema pack set to: gbrain-base');
    expect(r.stdout).toContain('schema active');
    const cfgPath = join(home, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.schema_pack).toBe('gbrain-base');
  });

  test('preserves pre-existing config fields when writing schema_pack', () => {
    // Pre-seed a config with engine + a custom key so the merge preserves them.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const cfgPath = join(home, '.gbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', openai_key: 'sk-fake' }, null, 2), 'utf-8');
    const r = gbrain(['schema', 'use', 'gbrain-base'], { GBRAIN_HOME: home });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.openai_key).toBe('sk-fake');
    expect(cfg.schema_pack).toBe('gbrain-base');
  });

  test('overwrites prior schema_pack value on re-run', () => {
    // First set a placeholder, then overwrite via the CLI.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const cfgPath = join(home, '.gbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', schema_pack: 'something-else' }, null, 2), 'utf-8');
    const r = gbrain(['schema', 'use', 'gbrain-base'], { GBRAIN_HOME: home });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.schema_pack).toBe('gbrain-base');
  });

  test('unknown pack rejected with exit 1 + paste-ready hint', () => {
    const r = gbrain(['schema', 'use', 'no-such-pack-xyz'], { GBRAIN_HOME: home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown pack');
    expect(r.stderr).toContain('schema list');
    // Importantly: a failed `use` must NOT have written a config.
    const cfgPath = join(home, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(false);
  });
});
