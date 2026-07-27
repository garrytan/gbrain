/**
 * Tier 2 e2e: spawn REAL openclaw, install our plugin from a built bundle of
 * `src/openclaw-context-engine.ts`, and assert the OpenClaw runtime actually
 * loads it, registers our default-export metadata, accepts it as the
 * `contextEngine` slot, and runs `plugins doctor` with zero error-level
 * diagnostics for our plugin id.
 *
 * Why this exists:
 *   The unit/e2e tests in test/context-engine.test.ts and
 *   test/e2e/openclaw-context-engine-plugin.test.ts both run STANDALONE —
 *   they mock the OpenClaw SDK or call our engine factory directly. Codex
 *   outside-voice F1 flagged that nothing in the repo proves OpenClaw's
 *   actual plugin loader walks our entry file, calls register(api), and
 *   accepts the registration. This test closes that gap.
 *
 * What this exercises end-to-end:
 *   1. `bun build` our entry → JS bundle (the same build the release would
 *      ship to ClawHub).
 *   2. `openclaw plugins install --link` against an isolated `--profile`
 *      directory.
 *   3. `openclaw plugins inspect <id> --json` reads our default-export shape
 *      back from the runtime registry (`status: 'loaded'`, `imported: true`,
 *      id/name/description match).
 *   4. `openclaw config set plugins.slots.contextEngine gbrain-context` →
 *      `openclaw config validate` confirms the slot binding is accepted.
 *   5. `openclaw plugins doctor` surfaces zero error-level diagnostics for
 *      our id.
 *   6. Public-SDK round-trip: import `registerContextEngine` from
 *      `openclaw/plugin-sdk` and register our factory directly, exercising
 *      the same registry our entry's register() hits.
 *
 * Skips gracefully when `openclaw` CLI is unavailable (Tier 2 like
 * test/e2e/skills.test.ts). Uses an isolated `--profile` so the user's real
 * openclaw state is untouched; cleans up the profile + plugin install in
 * afterAll regardless of test outcome.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';

// ── Tier 2 gating ──────────────────────────────────────────────────────────
const OPENCLAW = which('openclaw');
const SKIP = !OPENCLAW;
const SKIP_MSG = '[openclaw-plugin-load-real] openclaw CLI not available; skipping Tier 2 e2e';

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const path = r.stdout.trim();
  return path || null;
}

// Hardcoded plugin id matches src/openclaw-context-engine.ts default export.
const PLUGIN_ID = 'gbrain-context-engine';
const ENGINE_ID = 'gbrain-context';
// Use a process-unique profile name so two concurrent test runs (e.g.,
// Conductor sibling workspaces) don't collide on `~/.openclaw-<profile>`.
const PROFILE = `gbrain-ctx-e2e-${process.pid}`;
const PROFILE_DIR = join(homedir(), `.openclaw-${PROFILE}`);

let fixtureDir = '';
let repoRoot = '';

function runOpenclaw(args: string[], opts: { timeoutMs?: number } = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(OPENCLAW!, ['--profile', PROFILE, ...args], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    env: { ...process.env },
  });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function cleanup() {
  if (!OPENCLAW) return;
  // Best-effort: uninstall the plugin and rm the profile dir. Both may
  // already be gone (e.g., beforeAll partial failure); ignore errors.
  try {
    runOpenclaw(['plugins', 'uninstall', '--force', PLUGIN_ID], { timeoutMs: 30_000 });
  } catch { /* noop */ }
  try {
    if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch { /* noop */ }
  try {
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  } catch { /* noop */ }
}

describe('openclaw-plugin-load-real (Tier 2 e2e)', () => {
  beforeAll(async () => {
    if (SKIP) {
      console.warn(SKIP_MSG);
      return;
    }

    repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
      .stdout.trim();
    if (!repoRoot) throw new Error('not in a git repo — cannot resolve plugin source path');

    fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-ctx-plugin-real-'));

    // Write the fixture's package.json + openclaw.plugin.json from templates.
    const fixtureTemplate = join(repoRoot, 'test', 'fixtures', 'openclaw-plugin-real');
    writeFileSync(
      join(fixtureDir, 'package.json'),
      readFileSync(join(fixtureTemplate, 'package.json.template'), 'utf8'),
    );
    writeFileSync(
      join(fixtureDir, 'openclaw.plugin.json'),
      readFileSync(join(fixtureTemplate, 'openclaw.plugin.json.template'), 'utf8'),
    );

    // Build our real entry to a single JS bundle. This is the same source
    // (`src/openclaw-context-engine.ts`) that the release ships; only the
    // packaging layer (test fixture's package.json) is test-specific.
    const buildResult = spawnSync(
      'bun',
      [
        'build',
        join(repoRoot, 'src', 'openclaw-context-engine.ts'),
        '--target=bun',
        '--outfile',
        join(fixtureDir, 'entry.js'),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (buildResult.status !== 0) {
      throw new Error(`bun build failed (exit ${buildResult.status}): ${buildResult.stderr}`);
    }
    if (!existsSync(join(fixtureDir, 'entry.js'))) {
      throw new Error('bun build did not produce entry.js');
    }

    // Install via openclaw plugins install --link into the isolated profile.
    // `--dangerously-force-unsafe-install` is required because openclaw's
    // dangerous-code scanner flags the surrounding gbrain repo (tests use
    // child_process etc.); the test fixture is dev-trusted, same provenance
    // as the test runner.
    const install = runOpenclaw([
      'plugins', 'install',
      '--link',
      '--dangerously-force-unsafe-install',
      fixtureDir,
    ], { timeoutMs: 60_000 });
    if (install.exitCode !== 0) {
      throw new Error(
        `openclaw plugins install failed (exit ${install.exitCode}).\n` +
        `stdout: ${install.stdout}\nstderr: ${install.stderr}`,
      );
    }
  });

  afterAll(() => {
    cleanup();
  });

  it.skipIf(SKIP)(
    'openclaw imports the entry file and reports status=loaded',
    () => {
      const r = runOpenclaw(['plugins', 'inspect', PLUGIN_ID, '--json'], { timeoutMs: 30_000 });
      expect(r.exitCode).toBe(0);

      const inspect = JSON.parse(r.stdout);
      expect(inspect.plugin).toBeDefined();
      // status=loaded means: openclaw imported the entry.js module, read the
      // default export, and called register(api) without throwing.
      expect(inspect.plugin.status).toBe('loaded');
      expect(inspect.plugin.imported).toBe(true);
      expect(inspect.plugin.activated).toBe(true);
    },
  );

  it.skipIf(SKIP)(
    'default export carries the expected id / name / description metadata',
    () => {
      const r = runOpenclaw(['plugins', 'inspect', PLUGIN_ID, '--json'], { timeoutMs: 30_000 });
      expect(r.exitCode).toBe(0);
      const inspect = JSON.parse(r.stdout);

      // Openclaw reads these directly from the default export of our entry.
      // If we rename a field in src/openclaw-context-engine.ts, this fails.
      expect(inspect.plugin.id).toBe(PLUGIN_ID);
      expect(inspect.plugin.name).toBe('GBrain Context Engine');
      expect(inspect.plugin.description).toContain('Deterministic temporal/spatial context injection');
    },
  );

  it.skipIf(SKIP)(
    'register(api) ran without producing error-level diagnostics',
    () => {
      const r = runOpenclaw(['plugins', 'inspect', PLUGIN_ID, '--json'], { timeoutMs: 30_000 });
      expect(r.exitCode).toBe(0);
      const inspect = JSON.parse(r.stdout);

      const errors = (inspect.diagnostics ?? []).filter((d: { level: string }) => d.level === 'error');
      expect(errors).toEqual([]);

      // The trust warning is expected for --link installs — it's openclaw
      // telling the operator that --link bypasses install-record provenance.
      // We assert it's there so a future openclaw change that elevates it to
      // error-level surfaces here too.
      const warns = (inspect.diagnostics ?? []).filter((d: { level: string }) => d.level === 'warn');
      const hasTrustWarning = warns.some((d: { message: string }) =>
        d.message.includes('install/load-path provenance'),
      );
      expect(hasTrustWarning).toBe(true);
    },
  );

  it.skipIf(SKIP)(
    'plugins.slots.contextEngine binding to gbrain-context validates cleanly',
    () => {
      // Wiring our id into the slot is the runtime hand-off — when
      // openclaw initializes an agent, it reads this slot and resolves the
      // engine from the contextEngine registry. config validate fails if
      // the slot value doesn't reference a known engine.
      const setResult = runOpenclaw(
        ['config', 'set', 'plugins.slots.contextEngine', ENGINE_ID],
        { timeoutMs: 30_000 },
      );
      expect(setResult.exitCode).toBe(0);

      const validateResult = runOpenclaw(['config', 'validate'], { timeoutMs: 30_000 });
      expect(validateResult.exitCode).toBe(0);
      expect(validateResult.stdout).toContain('Config valid');
    },
  );

  it.skipIf(SKIP)(
    'plugins doctor produces zero errors for our plugin id',
    () => {
      const r = runOpenclaw(['plugins', 'doctor'], { timeoutMs: 30_000 });
      // Doctor may exit non-zero overall if ANY plugin has issues; the
      // assertion we care about is that OUR id is not in an error line.
      // Match a "${PLUGIN_ID}: <message>" pattern with error keywords.
      const combined = `${r.stdout}\n${r.stderr}`;
      const lines = combined.split('\n').filter(l => l.includes(PLUGIN_ID));
      const errorLines = lines.filter(l =>
        /error|failed|cannot|missing|not registered/i.test(l)
        && !l.includes('without install/load-path provenance'), // expected trust warning
      );
      if (errorLines.length > 0) {
        console.error('Unexpected error lines for', PLUGIN_ID, ':\n', errorLines.join('\n'));
      }
      expect(errorLines).toEqual([]);
    },
  );

  it.skipIf(SKIP)(
    'openclaw public SDK registerContextEngine accepts our factory shape',
    async () => {
      // Programmatic round-trip via the SDK that plugin entries actually
      // use. This is the API our register(api) calls; importing and using
      // it directly proves our factory's call signature matches what
      // openclaw's runtime expects. If openclaw renames the export or
      // changes the factory contract, this test fails.
      // Try the bare specifier first (works if openclaw is installed in the
      // workspace's node_modules). Fall back to the global install location
      // discovered via `npm root -g` (common for users who installed
      // openclaw with `npm install -g openclaw`). The fallback uses an
      // absolute path so Bun's resolver doesn't need a registered
      // module-mapping. If both fail, fail loudly — this is the round-trip
      // test, silently skipping defeats its purpose now that the suite-
      // level fixture proved openclaw is installed and reachable.
      let registerContextEngine: ((id: string, factory: () => unknown) => void) | undefined;

      const importErrors: string[] = [];
      try {
        // @ts-ignore — bare specifier resolution depends on node_modules.
        const sdk = await import('openclaw/plugin-sdk');
        registerContextEngine = sdk.registerContextEngine;
      } catch (err) {
        importErrors.push(`bare 'openclaw/plugin-sdk': ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!registerContextEngine) {
        // Bare specifier failed — resolve via the installed openclaw binary
        // itself. `which openclaw` gave us a shim path; `realpathSync`
        // follows the symlink chain to the actual openclaw module directory
        // (e.g., /opt/homebrew/lib/node_modules/openclaw/openclaw.mjs).
        // From there, dist/plugin-sdk/index.js is the public SDK entry.
        // This works regardless of how openclaw was installed (Homebrew,
        // bare npm -g, nvm, asdf, volta) because it follows the actual
        // filesystem link.
        try {
          const realBin = realpathSync(OPENCLAW!);
          const openclawModuleDir = dirname(realBin);
          const sdkPath = join(openclawModuleDir, 'dist', 'plugin-sdk', 'index.js');
          if (existsSync(sdkPath)) {
            // @ts-ignore — absolute-path dynamic import bypasses node_modules resolution.
            const sdk = await import(sdkPath);
            registerContextEngine = sdk.registerContextEngine;
          } else {
            importErrors.push(`SDK not found at ${sdkPath} (resolved from openclaw bin ${realBin})`);
          }
        } catch (err) {
          importErrors.push(`bin-relative resolve: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!registerContextEngine) {
        throw new Error(
          `openclaw/plugin-sdk could not be resolved from any known location. ` +
          `Errors:\n  ${importErrors.join('\n  ')}\n` +
          `This test runs only when openclaw CLI is installed; SDK resolution should follow.`,
        );
      }
      expect(typeof registerContextEngine).toBe('function');

      const { createGBrainContextEngine } = await import('../../src/core/context-engine.ts');

      const tmp = mkdtempSync(join(tmpdir(), 'gbrain-ctx-sdk-rt-'));
      try {
        mkdirSync(join(tmp, 'memory'), { recursive: true });
        writeFileSync(join(tmp, 'memory', 'heartbeat-state.json'), '{}');
        writeFileSync(join(tmp, 'memory', 'upcoming-flights.json'), '{}');

        // Use a process-unique id so we don't collide with whatever the
        // suite-level plugin installation already wrote into the registry.
        const dynamicId = `${ENGINE_ID}-sdk-rt-${process.pid}`;

        // Should not throw. If openclaw's API contract drifts (e.g., requires
        // additional args, returns Promise instead of void), this fails.
        registerContextEngine!(
          dynamicId,
          () => createGBrainContextEngine({ workspaceDir: tmp }),
        );

        // Also verify the engine the factory produces still has the
        // expected ContextEngine interface shape (info, ingest, assemble,
        // compact) — these are the methods openclaw will call.
        const engine = createGBrainContextEngine({ workspaceDir: tmp });
        expect(engine.info.id).toBe(ENGINE_ID);
        expect(typeof engine.ingest).toBe('function');
        expect(typeof engine.assemble).toBe('function');
        expect(typeof engine.compact).toBe('function');

        // Assemble actually produces the Live Context block — same code
        // path openclaw will hit when it resolves the slot during an agent
        // turn. Proves the FULL load-and-call path works against openclaw's
        // public SDK.
        const result = await engine.assemble({ sessionId: 'sdk-roundtrip', messages: [] });
        expect(result.systemPromptAddition).toContain('Live Context');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
