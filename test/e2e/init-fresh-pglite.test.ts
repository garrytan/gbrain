/**
 * T12 — fresh PGLite init E2E for the v0.37 env-detection + picker + D6 wave.
 *
 * Subprocess-driven so we exercise the real CLI argv parsing, env handling,
 * exit codes, and config persistence — exactly the failure modes the bug
 * reporter hit. Each test gets its own throw-away `GBRAIN_HOME` so test runs
 * are hermetic.
 *
 * Scope covered:
 *  - Happy path: OPENAI_API_KEY set → auto-pick OpenAI, persists embedding_model + dim
 *  - Fail-loud non-TTY no-key (D3 regression)
 *  - D6 regression: bug-reporter's three no-op config keys exit 1 with Levenshtein
 *  - `--no-embedding` D9 opt-in: init succeeds with sentinel; gbrain import refuses
 *  - D11 preflight: explicit bad --embedding-dimensions refuses BEFORE touching disk
 *
 * Picker interactive flow (real TTY) is covered by the real-PTY serial test
 * at test/init-picker-pty.serial.test.ts (keyless provider choice plus a
 * non-default search mode, driven through a true pseudo-terminal). This file
 * stays piped-stdin on purpose: it exercises the NON-TTY branches.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLI = `bun run ${REPO_ROOT}/src/cli.ts`;

/** Run a CLI invocation with a clean GBRAIN_HOME + chosen env. Returns { stdout, stderr, exitCode }. */
async function runCli(args: string[], opts: { env?: NodeJS.ProcessEnv; gbrainHome: string; cwd?: string; stdinIsTTY?: boolean } = { gbrainHome: '' }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', `${REPO_ROOT}/src/cli.ts`, ...args], {
      env: {
        // Start from a minimal env to avoid the ambient host env (which
        // might have OPENAI_API_KEY already set, contaminating our tests).
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // GBRAIN_HOME isolates state per test.
        GBRAIN_HOME: opts.gbrainHome,
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd ?? REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-e2e-init-'));
}

// ============================================================================

describe('v0.37 T12 — fresh init env-detection (D1, D2, D3) + persistence (D5)', () => {
  let tmpHome: string;

  beforeAll(() => { tmpHome = makeTempHome(); });
  afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  test('OPENAI_API_KEY auto-picks OpenAI, persists embedding_model + embedding_dimensions', async () => {
    const r = await runCli(['init', '--pglite'], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test-only-for-init-resolution-NOT-CALLED' },
    });
    // Init may or may not succeed (depends on whether OpenAI key is real for
    // any side effect — but init.ts has no live embed call, just config
    // writes + schema). Assert the auto-pick stderr notice fired.
    expect(r.stderr).toMatch(/Detected OPENAI_API_KEY|Using openai:text-embedding-3-large/);
    expect(r.exitCode).toBe(0);

    // Config persisted with the right embedding fields.
    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.embedding_model).toBe('openai:text-embedding-3-large');
    expect(cfg.embedding_dimensions).toBe(1536);
    expect(cfg.engine).toBe('pglite');
  }, 240000);
});

// ============================================================================

describe('v0.45 DX wave — non-TTY no-key defaults to keyless (typo still fail-loud)', () => {
  let tmpHome: string;
  let typoHome: string;

  beforeAll(() => { tmpHome = makeTempHome(); typoHome = makeTempHome(); });
  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(typoHome, { recursive: true, force: true });
  });

  test('--non-interactive with zero provider keys → keyless init succeeds with loud notice', async () => {
    const r = await runCli(['init', '--pglite', '--non-interactive'], {
      gbrainHome: tmpHome,
      env: {}, // no provider keys
    });
    // Keyless is a first-class posture: the naive first command completes.
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('keyless mode');
    // The notice names the upgrade affordance — the re-init recipe that
    // actually works, NOT `config set embedding_model` (which config.ts
    // hard-refuses as a schema-sizing no-op).
    expect(r.stderr).toContain('gbrain init --force --pglite --embedding-model');
    expect(r.stderr).not.toContain('config set embedding_model');
    // Config persisted with the deferred-embedding sentinel.
    const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
    expect(cfg.embedding_disabled).toBe(true);
    expect(cfg.engine).toBe('pglite');
  }, 240000);

  test('--non-interactive with env-key typo stays fail-loud with Levenshtein hint', async () => {
    const r = await runCli(['init', '--pglite', '--non-interactive'], {
      gbrainHome: typoHome,
      env: { OPENAPI_API_KEY: 'sk-test-typo' },
    });
    // A near-miss key signals the user MEANT to configure a provider —
    // completing keyless would silently bury their typo.
    expect(r.exitCode).toBe(1);
    // D13 typo detection: surfaces "did you mean OPENAI_API_KEY"
    expect(r.stderr).toMatch(/did you mean OPENAI_API_KEY/i);
    // The hint leads with the keyless-continue option.
    expect(r.stderr).toContain('--no-embedding');
  }, 60000);

  test('--non-interactive with multiple provider keys auto-picks the canonical default', async () => {
    const multiHome = makeTempHome();
    try {
      // v0.46.3: the canonical new-install default is voyage:voyage-4
      // (NEW_INSTALL_DEFAULT_EMBEDDING_MODEL); a ZE key no longer counts —
      // sunset recipes are excluded from auto-pick entirely.
      const r = await runCli(['init', '--pglite', '--non-interactive'], {
        gbrainHome: multiHome,
        env: {
          OPENAI_API_KEY: 'sk-test-only-for-init-resolution-NOT-CALLED',
          VOYAGE_API_KEY: 'pa-test-only-for-init-resolution-NOT-CALLED',
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('Multiple embedding providers env-ready');
      expect(r.stderr).toContain('Override with --embedding-model');
      const cfg = JSON.parse(readFileSync(join(multiHome, '.gbrain', 'config.json'), 'utf-8'));
      // Canonical default wins when its key is present — voyage-4, NOT the
      // quality-sorted models[0] (voyage-4-large).
      expect(cfg.embedding_model).toBe('voyage:voyage-4');
      expect(cfg.embedding_dimensions).toBe(1024);
    } finally {
      rmSync(multiHome, { recursive: true, force: true });
    }
  }, 240000);

  test('--non-interactive with ONLY a sunset-provider key continues keyless (ZE excluded)', async () => {
    const zeHome = makeTempHome();
    try {
      const r = await runCli(['init', '--pglite', '--non-interactive'], {
        gbrainHome: zeHome,
        env: { ZEROENTROPY_API_KEY: 'ze-test-only-for-init-resolution-NOT-CALLED' },
      });
      // Sunset exclusion means zero READY providers → keyless continue, not
      // an auto-pick onto a provider that dies 2026-09-04.
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('keyless');
      const cfg = JSON.parse(readFileSync(join(zeHome, '.gbrain', 'config.json'), 'utf-8'));
      expect(cfg.embedding_disabled).toBe(true);
      expect(cfg.embedding_model).toBeUndefined();
    } finally {
      rmSync(zeHome, { recursive: true, force: true });
    }
  }, 240000);
});

// ============================================================================

describe('v0.45 DX wave — --supabase non-TTY guard + multi-key no-canonical fail-loud', () => {
  test('init --supabase without a TTY fails loud and names the --url escape hatch', async () => {
    // Legacy behavior was a silent exit-0 no-op (stdin closed → readLine
    // never resolved → process ended with NO config written) — the worst
    // failure shape for a scripted/agent caller.
    const home = makeTempHome();
    try {
      const r = await runCli(['init', '--supabase'], { gbrainHome: home, env: {} });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('needs an interactive terminal');
      expect(r.stderr).toContain('--url');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120000);

  test('multiple provider keys with NO canonical candidate stays fail-loud with disambiguation hint', async () => {
    // The canonical default provider (voyage, v0.46.3) has no key here, so the
    // non-TTY auto-pick cannot resolve the ambiguity — it must fail loud
    // (D2/D3), not guess between openai and mistral.
    const home = makeTempHome();
    try {
      const r = await runCli(['init', '--pglite', '--non-interactive'], {
        gbrainHome: home,
        env: {
          OPENAI_API_KEY: 'sk-test-only-for-init-resolution-NOT-CALLED',
          MISTRAL_API_KEY: 'mi-test-only-for-init-resolution-NOT-CALLED',
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/Multiple embedding providers env-ready/);
      expect(r.stderr).toMatch(/Disambiguate by passing --embedding-model/);
      // Fail-loud path exits BEFORE any config write.
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120000);
});

// ============================================================================

describe('v0.37 T12 — D6 regression: bug-reporter no-op keys exit 1 with Levenshtein', () => {
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = makeTempHome();
    // Bootstrap a brain so `gbrain config set` has somewhere to write.
    await runCli(['init', '--pglite', '--embedding-model', 'openai:text-embedding-3-large'], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
  });
  afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  test('gbrain config set embedding.provider openai → exit 1 with suggestion', async () => {
    const r = await runCli(['config', 'set', 'embedding.provider', 'openai'], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Unknown config key');
  }, 60000);

  test('gbrain config set embedding.model openai:text-embedding-3-large → suggests embedding_model', async () => {
    const r = await runCli(['config', 'set', 'embedding.model', 'openai:text-embedding-3-large'], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Did you mean "embedding_model"/);
  }, 60000);

  test('gbrain config set embedding.dimensions 1536 → suggests embedding_dimensions', async () => {
    const r = await runCli(['config', 'set', 'embedding.dimensions', '1536'], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Did you mean "embedding_dimensions"/);
  }, 60000);

  test('gbrain config set --force foo.bar baz → accepts with WARN', async () => {
    const r = await runCli(['config', 'set', 'foo.bar.unknown', 'somevalue', '--force'], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('writing unknown key');
  }, 60000);

  test('gbrain config set search.mode conservative → accepts (known key)', async () => {
    const r = await runCli(['config', 'set', 'search.mode', 'conservative'], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(r.exitCode).toBe(0);
  }, 60000);
});

// ============================================================================

describe('v0.37 T12 — D9 --no-embedding deferred-setup mode', () => {
  let tmpHome: string;

  beforeAll(() => { tmpHome = makeTempHome(); });
  afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  test('init --pglite --no-embedding succeeds with embedding_disabled sentinel', async () => {
    const r = await runCli(['init', '--pglite', '--no-embedding'], {
      gbrainHome: tmpHome,
      env: {}, // no provider keys — opt-in mode shouldn't care
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('--no-embedding: deferred setup');

    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.embedding_disabled).toBe(true);
    // Mutually exclusive with embedding_model being set.
    expect(cfg.embedding_model).toBeUndefined();
  }, 120000);

  test('gbrain import refuses with config-set hint after --no-embedding init', async () => {
    // Seed a markdown file to import.
    const repoDir = join(tmpHome, 'sample-repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'test.md'), '# test\nhello world');

    const r = await runCli(['import', repoDir], {
      gbrainHome: tmpHome,
      env: {},
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/deferred setup|no-embedding|gbrain config set embedding_model/);
  }, 120000);

  test('gbrain import --no-embed flag bypasses the refusal (chunks land without vectors)', async () => {
    // The CLI flag --no-embed (existing, separate from --no-embedding init flag)
    // should still work after --no-embedding init — import succeeds, just doesn't
    // embed. Validates we didn't accidentally block all imports.
    const repoDir = join(tmpHome, 'sample-repo');
    const r = await runCli(['import', repoDir, '--no-embed'], {
      gbrainHome: tmpHome,
      env: {},
    });
    expect(r.exitCode).toBe(0);
  }, 120000);
});

// ============================================================================

describe('v0.37 T12 — D11 preflight refuses BEFORE disk writes', () => {
  let tmpHome: string;

  beforeAll(() => { tmpHome = makeTempHome(); });
  afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  test('--embedding-dimensions 9999 (invalid for OpenAI text-3-large) refuses early', async () => {
    const r = await runCli([
      'init', '--pglite',
      '--embedding-model', 'openai:text-embedding-3-large',
      '--embedding-dimensions', '9999',
    ], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Refusing to init|rejects custom dimensions 9999|accepts dimensions 1\.\.3072/);
    // No brain file written on failure path.
    expect(existsSync(join(tmpHome, 'brain.pglite'))).toBe(false);
    // No config persisted either (preflight runs BEFORE saveConfig).
    expect(existsSync(join(tmpHome, '.gbrain', 'config.json'))).toBe(false);
  }, 60000);

  test('--embedding-dimensions 99999 (above pgvector cap) refuses', async () => {
    const r = await runCli([
      'init', '--pglite',
      '--embedding-model', 'openai:text-embedding-3-large',
      '--embedding-dimensions', '99999',
    ], {
      gbrainHome: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/exceed pgvector|Refusing to init/);
  }, 60000);
});

// ============================================================================

describe('v0.37 T12 — happy path with picker-bypassing explicit flag', () => {
  let tmpHome: string;

  beforeAll(() => { tmpHome = makeTempHome(); });
  afterAll(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  test('explicit --embedding-model wins over env detection', async () => {
    const r = await runCli([
      'init', '--pglite',
      '--embedding-model', 'voyage:voyage-3-large',
      '--embedding-dimensions', '1024',
    ], {
      gbrainHome: tmpHome,
      // OpenAI key set, but explicit Voyage flag overrides per precedence chain.
      env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'pa-test' },
    });
    expect(r.exitCode).toBe(0);

    const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
    expect(cfg.embedding_model).toBe('voyage:voyage-3-large');
    expect(cfg.embedding_dimensions).toBe(1024);
  }, 120000);
});
