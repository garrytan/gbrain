/**
 * Keyless `gbrain dream` exit-0 contract — TODOS.md "P2 — Keyless `gbrain
 * dream` contract test".
 *
 * The documented nightly cron (INSTALL_FOR_AGENTS.md Step 7 / the dream.ts
 * docstring's `0 2 * * * gbrain dream --json`) runs `gbrain dream`
 * unconditionally, including on `init --no-embedding` installs (keyless
 * machines). The contract: a full keyless dream MUST exit 0 with the
 * documented degraded posture — key-needing phases skip or refuse with
 * structured, documented messages; nothing crashes; the cron never sees a
 * nonzero from "no keys" alone.
 *
 * What the cycle actually does keyless today (pinned here, verified against
 * a live run):
 *   - chat-dependent phases skip cleanly (`propose_takes` → the gateway's
 *     "no Anthropic API key configured" diagnosis);
 *   - the embed phase surfaces `EmbeddingDisabledError` as a structured
 *     phase FAILURE (runEmbedCore's assertEmbeddingEnabled throws; the
 *     CLI-only clean refusal in runEmbed/isKeylessStaleRefusal does NOT
 *     cover the cycle's runEmbedCore call) — so the report status is
 *     'partial', never 'failed', and `gbrain dream` exits 1 only on
 *     'failed' (src/commands/dream.ts). If the cycle's embed phase ever
 *     learns the same keyless clean-skip the CLI spelling has, the pins
 *     below move from 'partial'/fail-set-['embed'] to a clean skip —
 *     update them deliberately in that commit.
 *
 * Test shape mirrors test/agent-scheduler-contract.serial.test.ts (keyless
 * PGLite brain, real CLI spawn, exit-code assertions). Non-serial on
 * purpose: no process.env mutation — the child env is built from an
 * ALLOWLIST, so every provider credential the canonical fold recognizes
 * (src/core/ai/provider-env.ts mergedProviderEnv: ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
 * VOYAGE_API_KEY, OPENROUTER_API_KEY, ZEROENTROPY_API_KEY,
 * DASHSCOPE_API_KEY, AZURE_OPENAI_*) is absent by construction, and the
 * fixture's config.json sets no config-based keys either.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { spawnSync, execFileSync } from 'child_process';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const SKIP = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

interface PhaseResultish {
  phase: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  summary: string;
  error?: { class: string; code: string; message: string };
}
interface CycleReportish {
  schema_version: string;
  status: string;
  brain_dir: string | null;
  phases: PhaseResultish[];
  totals: Record<string, number>;
}
interface RunResult { exitCode: number; stdout: string; stderr: string }

describe.skipIf(SKIP)('keyless `gbrain dream` exits 0 (nightly-cron contract)', () => {
  let home = '';
  let repoDir = '';
  let env: Record<string, string>;

  function gbrain(args: string[], timeoutMs: number): RunResult {
    const res = spawnSync(process.execPath, ['run', CLI, ...args], {
      cwd: REPO, // near-repo cwd keeps Bun's transpile cache warm
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return { exitCode: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  /**
   * `dream --json` prints the CycleReport as the LAST pretty-printed JSON
   * object on stdout; on the first sync of a checkout the sync phase's
   * full-import writes human lines to stdout first (the #394 quieting covers
   * the embed phase, not sync's import). Parse from the first line that is
   * exactly '{'.
   */
  function parseReport(stdout: string): CycleReportish {
    const lines = stdout.split('\n');
    const start = lines.findIndex((l) => l === '{');
    if (start === -1) throw new Error(`no JSON object found on stdout:\n${stdout.slice(-2000)}`);
    return JSON.parse(lines.slice(start).join('\n')) as CycleReportish;
  }

  function failedPhases(report: CycleReportish): string[] {
    return report.phases.filter((p) => p.status === 'fail').map((p) => p.phase);
  }

  function byName(report: CycleReportish, phase: string): PhaseResultish {
    const p = report.phases.find((x) => x.phase === phase);
    if (!p) throw new Error(`phase ${phase} missing from report: ${report.phases.map((x) => x.phase).join(', ')}`);
    return p;
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gb-dream-keyless-'));
    repoDir = join(home, 'brain');

    const bunDir = dirname(process.execPath || '/usr/local/bin');
    env = {
      // Allowlist-built env: NO inherited vars, so every ambient provider
      // key/endpoint is stripped by construction (see file docstring).
      PATH: `${bunDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      GBRAIN_HOME: home,
      TMPDIR: tmpdir(),
      // Keep the startup update-check marker off: env -i children have no
      // NODE_ENV=test, and a stale cache would fire a detached, real-network
      // `gbrain check-update --refresh-cache` per spawn + an
      // UPGRADE_AVAILABLE stderr line that would pollute the posture pins.
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
    };

    // Keyless brain — init --no-embedding's persisted end state.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({
        engine: 'pglite',
        database_path: join(home, '.gbrain', 'brain.pglite'),
        embedding_disabled: true,
      }) + '\n',
    );
    const init = gbrain(['init', '--migrate-only'], 120_000);
    if (init.exitCode !== 0) throw new Error(`init --migrate-only failed (${init.exitCode}):\n${init.stderr.slice(-2000)}`);

    // A real checkout with ONE REAL PAGE (anti-vacuity: an engine-only brain
    // skips the whole filesystem half of the cycle; the documented install
    // has a brain repo, so the sync/lint/extract phases must run keyless
    // too). Repo-local git identity — HOME=tmp has no global gitconfig.
    mkdirSync(join(repoDir, 'people'), { recursive: true });
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repoDir, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        env: {
          ...env,
          GIT_AUTHOR_DATE: '2026-08-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-08-01T00:00:00Z',
        },
      });
    writeFileSync(
      join(repoDir, 'people', 'alice-example.md'),
      '# Alice Example\n\nA real page so nothing here passes vacuously.\n',
    );
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Dream Keyless Test']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed page']);

    // Wire the checkout as the brain dir the way pre-v0.18 default-source
    // brains do (dream.ts resolveBrainDir tier 3: the sync.repo_path config
    // key) — no --dir on the cron line, exactly like the documented install.
    const cfg = gbrain(['config', 'set', 'sync.repo_path', repoDir], 60_000);
    if (cfg.exitCode !== 0) throw new Error(`config set sync.repo_path failed (${cfg.exitCode}):\n${cfg.stderr.slice(-2000)}`);
  }, 240_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('1. full keyless dream --json exits 0 with the documented degraded posture', () => {
    const r = gbrain(['dream', '--json'], 180_000);
    if (r.exitCode !== 0) {
      throw new Error(`keyless dream exited ${r.exitCode}\nstderr:\n${r.stderr.slice(-2500)}\nstdout:\n${r.stdout.slice(-1500)}`);
    }
    expect(r.exitCode).toBe(0);

    const report = parseReport(r.stdout);
    expect(report.schema_version).toBe('1');
    // 'partial', never 'failed': the embed phase fails structurally keyless
    // (see file docstring) but dream only exits 1 on report.status ===
    // 'failed'. A move to 'ok'/'clean' here means the embed phase learned
    // the keyless clean-skip — re-pin deliberately, don't loosen.
    expect(report.status).toBe('partial');

    // Anti-vacuity: the cycle really ran the filesystem half — the seed page
    // synced into the brain on the first pass.
    expect(byName(report, 'sync').status).toBe('ok');
    expect(report.totals.pages_synced).toBeGreaterThanOrEqual(1);

    // Documented keyless/degraded skip posture, pinned to the real strings:
    // chat-dependent proposal phase names the missing key + the remedy...
    const propose = byName(report, 'propose_takes');
    expect(propose.status).toBe('skipped');
    expect(propose.summary).toContain('no Anthropic API key configured');
    expect(propose.summary).toContain('ANTHROPIC_API_KEY');
    // ...and synthesize skips on its own config gate, not a key crash.
    const synthesize = byName(report, 'synthesize');
    expect(synthesize.status).toBe('skipped');
    expect(synthesize.summary).toContain('dream.synthesize.session_corpus_dir is unset');

    // The ONLY failing phase is embed, and its error is the documented
    // deferred-setup refusal (EmbeddingDisabledError text) — a structured
    // posture message, not a crash.
    expect(failedPhases(report)).toEqual(['embed']);
    const embed = byName(report, 'embed');
    expect(embed.error?.message ?? '').toContain('--no-embedding');
    expect(embed.error?.message ?? '').toContain('deferred setup');

    // No phase reports a crash: the embed refusal above is the single error
    // in the whole report, and nothing anywhere smells like an unhandled
    // programmer error.
    for (const p of report.phases) {
      if (p.phase !== 'embed') expect(p.error).toBeUndefined();
      const text = `${p.summary} ${p.error?.message ?? ''}`;
      expect(text).not.toMatch(/TypeError|ReferenceError|is not a function|undefined is not/);
    }
  }, 300_000);

  test('2. a second invocation is also 0 (idempotent nightly re-run)', () => {
    const r = gbrain(['dream', '--json'], 180_000);
    if (r.exitCode !== 0) {
      throw new Error(`second keyless dream exited ${r.exitCode}\nstderr:\n${r.stderr.slice(-2500)}\nstdout:\n${r.stdout.slice(-1500)}`);
    }
    expect(r.exitCode).toBe(0);

    const report = parseReport(r.stdout);
    expect(report.status).toBe('partial');
    // Same degraded posture on re-run — embed is still the only failure and
    // nothing new broke because the first cycle already banked its work.
    expect(failedPhases(report)).toEqual(['embed']);
    expect(byName(report, 'embed').error?.message ?? '').toContain('--no-embedding');
  }, 300_000);

  test('3. the plain (human) spelling exits 0 too, naming the degraded posture', () => {
    const r = gbrain(['dream'], 180_000);
    if (r.exitCode !== 0) {
      throw new Error(`plain keyless dream exited ${r.exitCode}\nstderr:\n${r.stderr.slice(-2500)}\nstdout:\n${r.stdout.slice(-1500)}`);
    }
    expect(r.exitCode).toBe(0);
    // printHuman's partial rendering: the header line + the embed refusal
    // text so an operator reading the cron log sees WHY embed shows ✗.
    expect(r.stdout).toContain('Dream cycle (partial)');
    expect(r.stdout).toContain('--no-embedding');
  }, 300_000);
});
