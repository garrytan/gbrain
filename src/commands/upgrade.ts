import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, realpathSync } from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { VERSION } from '../version.ts';

const CORTEX_GITHUB_REPO = process.env.CORTEX_RELEASE_REPO || 'Versatly/Cortex';
const CORTEX_PACKAGE_NAME = 'cortex-brain';
const CORTEX_CLI = 'cortex';
const CORTEX_HOME_DIR = '.cortex';
const CORTEX_RELEASES_URL = `https://github.com/${CORTEX_GITHUB_REPO}/releases`;

export async function runUpgrade(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: cortex upgrade\n\nSelf-update the CLI.\n\nDetects install method (bun, binary, clawhub) and runs the appropriate update.\nAfter upgrading, shows what\'s new and offers to set up new features.');
    return;
  }

  // Capture old version BEFORE upgrading (Codex finding: old binary runs this code)
  const oldVersion = VERSION;
  const method = detectInstallMethod();

  console.log(`Detected install method: ${method}`);

  let upgraded = false;
  switch (method) {
    case 'bun-link': {
      const linkInfo = detectBunLink();
      if (!linkInfo) {
        console.error('bun-link detected but could not resolve repo root.');
        break;
      }
      console.log(`Upgrading bun-link source clone at ${linkInfo.repoRoot}...`);
      try {
        execFileSync('git', ['-C', linkInfo.repoRoot, 'pull', '--ff-only'], { stdio: 'inherit', timeout: 120_000 });
        execFileSync('bun', ['install'], { cwd: linkInfo.repoRoot, stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        console.error('Auto-upgrade failed. Try manually:');
        console.error(`  cd ${linkInfo.repoRoot} && git pull && bun install`);
      }
      break;
    }

    case 'bun': {
      console.log('Upgrading via bun...');
      const bunGlobalRoot = resolveBunGlobalRoot();
      try {
        execFileSync('bun', ['update', CORTEX_PACKAGE_NAME], { cwd: bunGlobalRoot, stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        console.error('Upgrade failed. Try running manually:');
        console.error(`  cd ${bunGlobalRoot} && bun update ${CORTEX_PACKAGE_NAME}`);
      }
      break;
    }

    case 'binary':
      console.log('Binary self-update not yet implemented.');
      console.log('Download the latest binary from GitHub Releases:');
      console.log(`  ${CORTEX_RELEASES_URL}`);
      break;

    case 'clawhub':
      console.log('Upgrading via ClawHub...');
      try {
        execSync(`clawhub update ${CORTEX_PACKAGE_NAME}`, { stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        console.error(`ClawHub upgrade failed. Try: clawhub update ${CORTEX_PACKAGE_NAME}`);
      }
      break;

    default:
      console.error('Could not detect installation method.');
      console.log('Try one of:');
      console.log(`  bun update ${CORTEX_PACKAGE_NAME}`);
      console.log(`  clawhub update ${CORTEX_PACKAGE_NAME}`);
      console.log(`  Download from ${CORTEX_RELEASES_URL}`);
  }

  if (upgraded) {
    const newVersion = verifyUpgrade();
    // Save old version for post-upgrade migration detection
    saveUpgradeState(oldVersion, newVersion);
    // Run post-upgrade feature discovery (reads migration files from the NEW binary).
    // Timeout bumped 300s → 1800s (30 min) in v0.15.2 because v0.12.0 graph
    // backfill on 50K+ brains regularly exceeded the old ceiling. The heartbeat
    // wiring added in v0.15.2 makes the long wait observable; a hard 300s
    // cap would still kill legit migrations mid-run. Override via
    // CORTEX_POST_UPGRADE_TIMEOUT_MS env var.
    const postUpgradeTimeoutMs = Number(
      process.env.CORTEX_POST_UPGRADE_TIMEOUT_MS || 1_800_000,
    );
    try {
      execSync(`${CORTEX_CLI} post-upgrade`, { stdio: 'inherit', timeout: postUpgradeTimeoutMs });
    } catch (e) {
      // post-upgrade is best-effort, don't fail the upgrade. BUT leave a
      // trail so `cortex doctor` can surface it and give the user a clear
      // paste-ready recovery command. Silent failure here is how users end
      // up with half-upgraded tenant brains and no signal.
      recordUpgradeError({
        phase: 'post-upgrade',
        fromVersion: oldVersion,
        toVersion: newVersion,
        error: e instanceof Error ? e.message : String(e),
        hint: 'Run: cortex apply-migrations --yes',
      });
    }
    // Run features scan to show what's new and what to fix
    try {
      execSync(`${CORTEX_CLI} features`, { stdio: 'inherit', timeout: 30_000 });
    } catch {
      // features scan is best-effort
    }
  }
}

export function resolveBunGlobalRoot(): string {
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) {
    return join(bunInstall, 'install', 'global');
  }

  const defaultRoot = join(process.env.HOME || '', '.bun', 'install', 'global');
  if (isBunGlobalRoot(defaultRoot)) {
    return defaultRoot;
  }

  const installRoot = findBunInstallRootFromArgv();
  return installRoot ?? defaultRoot;
}

function isBunGlobalRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'));
}

function findBunInstallRootFromArgv(): string | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;

    let dir = dirname(realpathSync(argv1));
    for (let i = 0; i < 10; i++) {
      if (basename(dir) === CORTEX_PACKAGE_NAME && basename(dirname(dir)) === 'node_modules') {
        const root = dirname(dirname(dir));
        if (isBunGlobalRoot(root)) return root;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function verifyUpgrade(): string {
  try {
    const output = execSync(`${CORTEX_CLI} --version`, { encoding: 'utf-8', timeout: 10_000 }).trim();
    console.log(`Upgrade complete. Now running: ${output}`);
    return output.replace(/^cortex\s*/i, '').trim();
  } catch {
    console.log('Upgrade complete. Could not verify new version.');
    return '';
  }
}

/**
 * Append a structured record to ~/.cortex/upgrade-errors.jsonl when a
 * best-effort phase of the upgrade fails (e.g., `cortex post-upgrade`
 * silently bombing). Without this trail, users end up with half-upgraded
 * tenant brains and no signal. `cortex doctor` reads this file and surfaces the
 * paste-ready recovery hint. Failures here are themselves best-effort.
 */
export function recordUpgradeError(record: {
  phase: string;
  fromVersion: string;
  toVersion: string;
  error: string;
  hint: string;
}): void {
  try {
    const dir = join(process.env.HOME || '', CORTEX_HOME_DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'upgrade-errors.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      phase: record.phase,
      from_version: record.fromVersion,
      to_version: record.toVersion,
      error: record.error,
      hint: record.hint,
    }) + '\n';
    appendFileSync(path, line);
  } catch {
    // Recording errors is itself best-effort. The user will still see the
    // underlying failure in stdout/stderr from the original command.
  }
}

function saveUpgradeState(oldVersion: string, newVersion: string) {
  try {
    const dir = join(process.env.HOME || '', CORTEX_HOME_DIR);
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'upgrade-state.json');
    const state: Record<string, unknown> = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf-8'))
      : {};
    state.last_upgrade = {
      from: oldVersion,
      to: newVersion,
      ts: new Date().toISOString(),
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

/**
 * Post-upgrade feature discovery + migration application.
 *
 * Two responsibilities:
 *   1. Print feature_pitch headlines for migrations newer than the prior
 *      binary (cosmetic; runs only when upgrade-state.json is readable and
 *      has a from/to pair).
 *   2. Invoke `cortex apply-migrations --yes` so the mechanical side of
 *      every outstanding migration actually executes (schema, smoke, prefs,
 *      host rewrites, autopilot install). This is the Codex H8 fix:
 *      previously runPostUpgrade early-returned when upgrade-state.json
 *      was missing, which meant every broken-v0.11.0 install stayed broken.
 *      apply-migrations now runs unconditionally (idempotent; cheap when
 *      nothing is pending).
 *
 * Migration enumeration uses the TS registry at
 * src/commands/migrations/index.ts (Codex K) — no filesystem walk of
 * skills/migrations/*.md, so compiled binaries see the same set source
 * installs do.
 */
export async function runPostUpgrade(args: string[] = []): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: cortex post-upgrade');
    console.log('Prints feature pitches for new migrations and runs apply-migrations.');
    console.log('Idempotent — safe to re-run any time.');
    return;
  }

  // v0.35.8.0: lay down ~/.cortex/.gitignore retroactively. Existing users
  // never re-run `cortex init`, so init-only coverage misses them entirely
  // (codex F-CDX-8). Idempotent + non-clobbering — safe to run every upgrade.
  try {
    const { ensureGitignore } = await import('../core/config.ts');
    ensureGitignore();
  } catch {
    // Best-effort hygiene; never block upgrade.
  }
  // Cosmetic: print feature pitches for migrations newer than the prior binary.
  try {
    const statePath = join(process.env.HOME || '', CORTEX_HOME_DIR, 'upgrade-state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const from = state?.last_upgrade?.from;
      if (from) {
        const { migrations } = await import('./migrations/index.ts');
        for (const m of migrations) {
          if (isNewerThan(m.version, from)) {
            console.log('');
            console.log(`NEW: ${m.featurePitch.headline}`);
            if (m.featurePitch.description) console.log(m.featurePitch.description);
            if (m.featurePitch.recipe) {
              console.log(`Run \`cortex integrations show ${m.featurePitch.recipe}\` to set it up.`);
            }
            console.log('');
          }
        }
      }
    }
  } catch {
    // Pitch printing is cosmetic — don't gate migrations on it.
  }

  // Mechanical: run every outstanding migration. Idempotent; exits 0 quickly
  // when nothing is pending. Stays inside the same process so a long Phase F
  // (autopilot install) doesn't hit a subprocess boundary.
  try {
    const { runApplyMigrations } = await import('./apply-migrations.ts');
    await runApplyMigrations(['--yes', '--non-interactive']);
  } catch (e) {
    // Surface the error but don't throw — post-upgrade is best-effort.
    // Users can re-run `cortex apply-migrations` manually if they want
    // to retry.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\napply-migrations failed: ${msg}`);
    console.error('Run `cortex apply-migrations --yes` manually to retry.');
  }

  // v0.28.5 (X1): explicitly apply pending schema migrations.
  // apply-migrations runs orchestrator migrations and only WARNs about
  // schema-version drift (apply-migrations.ts:296-302). Without this hook,
  // `cortex upgrade` leaves wedged tenant memories wedged when this hook is
  // missing, forcing operators to read WARN output and run `cortex init --migrate-only`.
  // Close that loop here.
  // A1's hasPendingMigrations probe in connectEngine is belt-and-suspenders
  // for any path that bypasses upgrade (autopilot, direct CLI on stale brain).
  try {
    const { loadConfig: lcSchema, toEngineConfig: toCfgSchema } = await import('../core/config.ts');
    const { createEngine } = await import('../core/engine-factory.ts');
    const cfgSchema = lcSchema();
    if (cfgSchema) {
      const engine = await createEngine(toCfgSchema(cfgSchema));
      try {
        await engine.connect(toCfgSchema(cfgSchema));
        await engine.initSchema();
        console.log('  Schema up to date.');

        // v0.32.3 search-lite mode banner. One-shot: fires at most once per
        // install (state persisted via `search.mode_upgrade_notice_shown`).
        // Reframes from "behavior is regressing" to "named modes available"
        // per [CDX-1+2+3]: the production query op still defaults expand=true
        // and limit=20; tenant behavior is unchanged.
        try {
          const shown = await engine.getConfig('search.mode_upgrade_notice_shown');
          const existingMode = await engine.getConfig('search.mode');
          if (shown !== 'true' && !existingMode) {
            console.log('');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('[cortex] v0.32.3 added named search modes (conservative/balanced/tokenmax).');
            console.log('[cortex] Your current behavior is unchanged; the `query` op still defaults');
            console.log('[cortex] expand=true and limit=20, same as v0.31.x.');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('');
            console.log('[AGENT] Relay this matrix to your operator and ask which mode they want.');
            console.log('[AGENT] Recommended default: tokenmax (preserves current retrieval shape).');
            console.log('[AGENT] Run `cortex config set search.mode <mode>` after they decide.');
            console.log('');
            console.log('Per-query cost @ 10K queries/mo (typical small-tenant volume):');
            console.log('');
            console.log('                  Haiku 4.5    Sonnet 4.6   Opus 4.7');
            console.log('                  ($1/M)       ($3/M)       ($5/M)');
            console.log('  conservative    $40/mo       $120/mo      $200/mo');
            console.log('  balanced        $100/mo      $300/mo      $500/mo');
            console.log('  tokenmax        $200/mo      $600/mo      $1,000/mo');
            console.log('');
            console.log('  (scales linearly — multiply by 10 for 100K/mo)');
            console.log('  25x corner-to-corner spread. Natural diagonal pairings span ~4x.');
            console.log('');
            console.log('To pick:');
            console.log('  cortex search modes              # see what is running');
            console.log('  cortex config set search.mode <conservative|balanced|tokenmax>');
            console.log('  cortex search tune               # data-driven recommendations');
            console.log('');
            console.log('tokenmax bumps limit to 50 (current default is 20). To preserve');
            console.log('your EXACT current shape:');
            console.log('  cortex config set search.mode tokenmax');
            console.log('  cortex config set search.searchLimit 20');
            console.log('');
            await engine.setConfig('search.mode_upgrade_notice_shown', 'true');
          }
        } catch {
          // Banner is cosmetic; never block the upgrade.
        }

        // v0.32.7 CJK wave: chunker-version bump → re-embed sweep.
        // Idempotent — `runReindex` short-circuits when no pages are pending.
        try {
          const { runPostUpgradeReembedPrompt } = await import('../core/post-upgrade-reembed.ts');
          const { getEmbeddingModel } = await import('../core/ai/gateway.ts');
          let modelString = 'openai:text-embedding-3-large';
          try { modelString = getEmbeddingModel(); } catch { /* gateway not configured — keep default */ }
          const promptResult = await runPostUpgradeReembedPrompt(engine, modelString);
          if (promptResult.proceeded) {
            const { runReindex } = await import('./reindex.ts');
            await runReindex(engine, ['--markdown']);
          }
        } catch (re) {
          const msg = re instanceof Error ? re.message : String(re);
          console.warn(`\nChunker-bump reindex skipped: ${msg}`);
          console.warn('Run `cortex reindex --markdown` manually when ready.');
        }
      } finally {
        try { await engine.disconnect(); } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    // Non-fatal: connection or DDL failure here falls back to the existing
    // user-facing WARN. apply-migrations.ts:296-302 already surfaces the
    // hint to run `cortex init --migrate-only`.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`\nSchema auto-apply skipped: ${msg}`);
    console.warn('Run `cortex init --migrate-only` manually if your tenant brain is wedged.');
  }

  // v0.25.1: agent-readable advisory listing recommended skills the
  // workspace hasn't installed yet. No-op when everything is installed.
  try {
    const { printAdvisoryIfRecommended } = await import('../core/skillpack/post-install-advisory.ts');
    const { VERSION } = await import('../version.ts');
    printAdvisoryIfRecommended({ version: VERSION, context: 'upgrade' });
  } catch {
    // Best-effort cosmetic surface; never block post-upgrade.
  }

  // v0.36 DX: skillpack reference sweep. After an upgrade, the Cortex bundle
  // may have shipped changes to scaffolded skills the host already has on
  // disk. Run `reference --all` automatically and print a one-line-per-skill
  // summary so the agent + operator see what drifted without manually
  // running the sweep. Skipped silently when:
  //   - CORTEX_SKIP_REFERENCE_SWEEP=1 in env
  //   - no target workspace can be auto-detected (Cortex installed but
  //     never scaffolded anywhere)
  //   - the detected workspace IS the Cortex repo (dev-mode, would just
  //     compare Cortex against itself)
  //   - every scaffolded skill is identical (nothing to say)
  await postUpgradeReferenceSweep();

  // v0.41.18.0 (A4 + A18, T14): post-upgrade onboard banner. Fail-open;
  // doesn't engine-connect (lightweight TTY check only). The actual
  // recommendations need engine access via `cortex onboard --check`;
  // the banner just nudges the user to run it.
  try {
    const { runUpgradeBanner } = await import('../core/onboard/init-nudge.ts');
    // The banner doesn't actually use the engine today; passing null-equivalent
    // would require a type widening. Skip the engine arg and let the banner
    // print the static nudge text.
    await runUpgradeBanner(null as never);
  } catch {
    // Fail-open per A18: never crash post-upgrade from the banner.
  }
}

/**
 * Run `reference --all` against the auto-detected host workspace and print
 * a one-line-per-skill summary of any drift. Best-effort; failures are
 * swallowed so a broken sweep never blocks post-upgrade.
 *
 * Exported (with optional `opts` test seam) for unit testing the gate
 * logic + output shape. Production callers pass no args — both paths are
 * auto-detected.
 */
export async function postUpgradeReferenceSweep(
  opts: { cortexRoot?: string; targetWorkspace?: string } = {},
): Promise<void> {
  if (process.env.CORTEX_SKIP_REFERENCE_SWEEP) return;
  try {
    const { autoDetectSkillsDirReadOnly } = await import('../core/repo-root.ts');
    const { findCortexRoot } = await import('../core/skillpack/bundle.ts');
    const { runReferenceAllForCortex } = await import('../core/skillpack/reference.ts');
    const path = await import('path');

    // Allow tests to inject; default to auto-detection.
    let targetWorkspace = opts.targetWorkspace;
    if (!targetWorkspace) {
      const detected = autoDetectSkillsDirReadOnly();
      if (!detected.dir) return;
      targetWorkspace = path.resolve(detected.dir, '..');
    }

    const cortexRoot = opts.cortexRoot ?? findCortexRoot();
    if (!cortexRoot) return;

    // Dev-mode guard: the detected workspace IS the Cortex repo. Sweeping
    // Cortex against itself is always identical; print nothing.
    if (path.resolve(targetWorkspace) === path.resolve(cortexRoot)) return;

    const result = runReferenceAllForCortex({ cortexRoot, targetWorkspace });
    // Print only skills that (a) the host has actually scaffolded, AND
    // (b) have at least one differs or missing entry. Pure-`missing`
    // skills the host never scaffolded are noise; skip them.
    const drifted = result.skills.filter(
      s =>
        s.summary.identical + s.summary.differs > 0 &&
        (s.summary.differs > 0 || s.summary.missing > 0),
    );
    if (drifted.length === 0) return;

    console.log('');
    console.log('Skillpack reference sweep (post-upgrade):');
    for (const s of drifted) {
      console.log(
        `  ${s.slug.padEnd(40)} differs:${s.summary.differs} missing:${s.summary.missing}`,
      );
    }
    console.log('');
    console.log(
      'Run `cortex skillpack reference <slug>` to inspect per-skill diffs.\nSee `skills/_AGENT_README.md` for what your agent should do on update.\nSkip this sweep: `CORTEX_SKIP_REFERENCE_SWEEP=1`.',
    );
  } catch {
    // Best-effort. Never block post-upgrade.
  }
}

// findMigrationsDir + extractFeaturePitch removed in v0.11.1: migration data
// now lives in the TS registry at src/commands/migrations/index.ts so
// compiled binaries don't depend on filesystem skills/migrations/*.md
// (Codex K).

function isNewerThan(version: string, baseline: string): boolean {
  const v = version.split('.').map(Number);
  const b = baseline.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (b[i] || 0)) return true;
    if ((v[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

export function detectInstallMethod(): 'bun' | 'bun-link' | 'binary' | 'clawhub' | 'unknown' {
  const execPath = process.execPath || '';

  // v0.28.5 cluster D: bun-link signal first.
  // bun link puts a symlink at ~/.bun/bin/cortex -> either the source's bin
  // entry (compiled CLI) OR src/cli.ts directly. Either way, realpath
  // resolves into a directory we can walk up from to find a .git/config
  // pointing at our repo.
  const bunLinkResult = detectBunLink();
  if (bunLinkResult) return 'bun-link';

  // Check if running from node_modules. Sub-classify and warn loudly when the
  // package does not look like the official Cortex runtime.
  if (execPath.includes('node_modules') || process.argv[1]?.includes('node_modules')) {
    const verdict = classifyBunInstall();
    if (verdict === 'suspect') {
      printInvalidPackageRecovery();
    }
    return 'bun';
  }

  // Check if running as compiled binary
  if (execPath.endsWith('/cortex') || execPath.endsWith('\\cortex.exe')) {
    return 'binary';
  }

  // Check if clawhub is available (use --version, not which, to avoid false positives)
  try {
    execSync('clawhub --version', { stdio: 'pipe', timeout: 5_000 });
    return 'clawhub';
  } catch {
    // not available
  }

  return 'unknown';
}

/**
 * Detect bun-link source-clone installs (closes #656, fixes #368).
 *
 * Walk up from argv[1] looking for a `.git/config` whose remote url
 * contains the configured Cortex release repository (case-insensitive substring).
 *
 * v0.28.5 gated on lstatSync(argv1).isSymbolicLink(), but bun resolves
 * the entire symlink chain before setting process.argv[1], so the check
 * always returned false and short-circuited detection. Now we skip the
 * symlink check and use argv[1] directly — it is already the real path
 * inside the checkout, which is exactly what the git-config walk needs.
 *
 * Returns { repoRoot } when confident; null otherwise (caller falls
 * through to the existing detection chain).
 */
function detectBunLink(): { repoRoot: string } | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;

    let dir = dirname(resolve(argv1));
    for (let i = 0; i < 6; i++) {
      const gitConfigPath = join(dir, '.git', 'config');
      if (existsSync(gitConfigPath)) {
        try {
          const cfg = readFileSync(gitConfigPath, 'utf-8');
          if (cfg.toLowerCase().includes(CORTEX_GITHUB_REPO.toLowerCase())) {
            return { repoRoot: dir };
          }
        } catch { /* unreadable config — not our case */ }
        return null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * v0.28.5 cluster D, signal 2 — bun install authenticity check (closes #658).
 *
 * When a global package install points at the wrong package, this function
 * reads the install directory's package.json and checks two authenticity
 * signals:
 *   - `repository.url` contains the configured Cortex release repository
 *   - the install dir contains a `src/cli.ts` file
 *
 * If neither matches, returns 'suspect' and the caller surfaces a loud
 * recovery message. These signals are best-effort warning checks, not a
 * cryptographic assertion.
 */
function classifyBunInstall(): 'canonical' | 'suspect' {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return 'suspect';

    // Walk up from argv1 looking for the package.json that owns this install.
    let dir = dirname(realpathSync(argv1));
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          const repoUrl = (typeof pkg.repository === 'string'
            ? pkg.repository
            : pkg.repository?.url) ?? '';
          if (repoUrl.toLowerCase().includes(CORTEX_GITHUB_REPO.toLowerCase())) {
            return 'canonical';
          }
          // Source-marker fallback: the runtime package ships src/cli.ts next
          // to package.json.
          if (existsSync(join(dir, 'src', 'cli.ts'))) {
            return 'canonical';
          }
          return 'suspect';
        } catch {
          return 'suspect';
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'suspect';
  } catch {
    return 'suspect';
  }
}

function printInvalidPackageRecovery(): void {
  console.warn('');
  console.warn('  WARNING: Cortex install does not appear to be the official runtime package.');
  console.warn(`  Expected repository: ${CORTEX_GITHUB_REPO}`);
  console.warn('');
  console.warn('  Recovery options:');
  console.warn('    1. Install from source:');
  console.warn(`         bun remove -g ${CORTEX_PACKAGE_NAME}`);
  console.warn(`         git clone https://github.com/${CORTEX_GITHUB_REPO}.git`);
  console.warn('         cd Cortex && bun install && bun link');
  console.warn('');
  console.warn('    2. Download a release binary:');
  console.warn(`         ${CORTEX_RELEASES_URL}`);
  console.warn('');
  console.warn('  See docs/INSTALL_FOR_AGENTS.md for the canonical install paths.');
  console.warn('');
}
