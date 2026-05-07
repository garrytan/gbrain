import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, realpathSync, lstatSync } from 'fs';
import { join, dirname } from 'path';
import { VERSION } from '../version.ts';

const GBRAIN_GITHUB_REPO = 'garrytan/gbrain';

export async function runUpgrade(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain upgrade\n\nSelf-update the CLI.\n\nDetects install method (bun, binary, clawhub) and runs the appropriate update.\nAfter upgrading, shows what\'s new and offers to set up new features.');
    return;
  }

  // Capture old version BEFORE upgrading (Codex finding: old binary runs this code)
  const oldVersion = VERSION;
  const method = detectInstallMethod();

  console.log(`Detected install method: ${method}`);

  let upgraded = false;
  switch (method) {
    case 'bun-link':
      // v0.28.5: bun-link installs are source clones. Pull + bun install
      // is the upgrade path; npm/bun's update mechanism doesn't apply.
      console.log('Upgrading via bun-link source clone...');
      console.log('  cd into your gbrain checkout, then run:');
      console.log('    git pull');
      console.log('    bun install');
      console.log('    bun link');
      console.log('');
      console.log('  (auto-detect can\'t do this for you because it doesn\'t know which checkout to update.)');
      break;

    case 'bun':
      console.log('Upgrading via bun...');
      try {
        execSync('bun update gbrain', { stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        console.error('Upgrade failed. Try running manually: bun update gbrain');
      }
      break;

    case 'binary':
      console.log('Binary self-update not yet implemented.');
      console.log('Download the latest binary from GitHub Releases:');
      console.log('  https://github.com/garrytan/gbrain/releases');
      break;

    case 'clawhub':
      console.log('Upgrading via ClawHub...');
      try {
        execSync('clawhub update gbrain', { stdio: 'inherit', timeout: 120_000 });
        upgraded = true;
      } catch {
        console.error('ClawHub upgrade failed. Try: clawhub update gbrain');
      }
      break;

    default:
      console.error('Could not detect installation method.');
      console.log('Try one of:');
      console.log('  bun update gbrain');
      console.log('  clawhub update gbrain');
      console.log('  Download from https://github.com/garrytan/gbrain/releases');
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
    // GBRAIN_POST_UPGRADE_TIMEOUT_MS env var.
    const postUpgradeTimeoutMs = Number(
      process.env.GBRAIN_POST_UPGRADE_TIMEOUT_MS || 1_800_000,
    );
    try {
      execSync('gbrain post-upgrade', { stdio: 'inherit', timeout: postUpgradeTimeoutMs });
    } catch (e) {
      // post-upgrade is best-effort, don't fail the upgrade. BUT leave a
      // trail so `gbrain doctor` can surface it and give the user a clear
      // paste-ready recovery command. Silent failure here is how users end
      // up with half-upgraded brains and no signal.
      recordUpgradeError({
        phase: 'post-upgrade',
        fromVersion: oldVersion,
        toVersion: newVersion,
        error: e instanceof Error ? e.message : String(e),
        hint: 'Run: gbrain apply-migrations --yes',
      });
    }
    // Run features scan to show what's new and what to fix
    try {
      execSync('gbrain features', { stdio: 'inherit', timeout: 30_000 });
    } catch {
      // features scan is best-effort
    }
  }
}

function verifyUpgrade(): string {
  try {
    const output = execSync('gbrain --version', { encoding: 'utf-8', timeout: 10_000 }).trim();
    console.log(`Upgrade complete. Now running: ${output}`);
    return output.replace(/^gbrain\s*/i, '').trim();
  } catch {
    console.log('Upgrade complete. Could not verify new version.');
    return '';
  }
}

/**
 * Append a structured record to ~/.gbrain/upgrade-errors.jsonl when a
 * best-effort phase of the upgrade fails (e.g., `gbrain post-upgrade`
 * silently bombing). Without this trail, users end up with half-upgraded
 * brains and no signal. `gbrain doctor` reads this file and surfaces the
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
    const dir = join(process.env.HOME || '', '.gbrain');
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
    const dir = join(process.env.HOME || '', '.gbrain');
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
 *   2. Invoke `gbrain apply-migrations --yes` so the mechanical side of
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
    console.log('Usage: gbrain post-upgrade');
    console.log('Prints feature pitches for new migrations and runs apply-migrations.');
    console.log('Idempotent — safe to re-run any time.');
    return;
  }
  // Cosmetic: print feature pitches for migrations newer than the prior binary.
  try {
    const statePath = join(process.env.HOME || '', '.gbrain', 'upgrade-state.json');
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
              console.log(`Run \`gbrain integrations show ${m.featurePitch.recipe}\` to set it up.`);
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
    // Users can re-run `gbrain apply-migrations` manually if they want
    // to retry.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\napply-migrations failed: ${msg}`);
    console.error('Run `gbrain apply-migrations --yes` manually to retry.');
  }

  // v0.28.5 (X1): explicitly apply pending schema migrations.
  // apply-migrations runs orchestrator migrations and only WARNs about
  // schema-version drift (apply-migrations.ts:296-302). Without this hook,
  // `gbrain upgrade` leaves wedged brains wedged — the user has to read
  // the WARN and run `gbrain init --migrate-only` themselves. We've shipped
  // 11 wedge incidents asking users to read warnings; close the loop here.
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
      } finally {
        try { await engine.disconnect(); } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    // Non-fatal: connection or DDL failure here falls back to the existing
    // user-facing WARN. apply-migrations.ts:296-302 already surfaces the
    // hint to run `gbrain init --migrate-only`.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`\nSchema auto-apply skipped: ${msg}`);
    console.warn('Run `gbrain init --migrate-only` manually if your brain is wedged.');
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
  // bun link puts a symlink at ~/.bun/bin/gbrain → either the source's bin
  // entry (compiled CLI) OR src/cli.ts directly. Either way, realpath
  // resolves into a directory we can walk up from to find a .git/config
  // pointing at our repo.
  const bunLinkResult = detectBunLink();
  if (bunLinkResult === 'bun-link') return 'bun-link';

  // Check if running from node_modules (bun/npm install). Could be canonical
  // (we publish under garrytan/gbrain) OR the squatter (npm `gbrain@1.3.x`).
  // Sub-classify and warn loudly on suspect installs (#658).
  if (execPath.includes('node_modules') || process.argv[1]?.includes('node_modules')) {
    const verdict = classifyBunInstall();
    if (verdict === 'suspect') {
      printSquatterRecovery();
    }
    return 'bun';
  }

  // Check if running as compiled binary
  if (execPath.endsWith('/gbrain') || execPath.endsWith('\\gbrain.exe')) {
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
 * v0.28.5 cluster D, signal 1 — bun-link detection (closes #656).
 *
 * argv[1] is what `bun /path/to/cli.ts` was invoked with. When `bun link`
 * is in play, that path is typically a symlink (~/.bun/bin/gbrain) to
 * either the source repo's compiled binary or src/cli.ts directly.
 * Walk up from the realpath looking for a `.git/config` whose remote
 * url contains `garrytan/gbrain` (case-insensitive substring).
 *
 * Returns 'bun-link' when we're confident; null otherwise (caller falls
 * through to the existing detection chain). Best-effort: forks, tarball
 * installs, detached source trees, and `.git`-less installs all fall
 * through, which is acceptable per codex's plan-review feedback.
 */
function detectBunLink(): 'bun-link' | null {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return null;

    // Symlink check first: `bun link` always creates one.
    let isSymlink = false;
    try {
      isSymlink = lstatSync(argv1).isSymbolicLink();
    } catch {
      return null;
    }
    if (!isSymlink) return null;

    const resolved = realpathSync(argv1);
    let dir = dirname(resolved);
    // Walk up at most 6 levels looking for .git/config.
    for (let i = 0; i < 6; i++) {
      const gitConfigPath = join(dir, '.git', 'config');
      if (existsSync(gitConfigPath)) {
        try {
          const cfg = readFileSync(gitConfigPath, 'utf-8');
          // Loose substring match: covers https://, git@, ssh://, fork URLs
          // that mention upstream in [remote "upstream"], and case variants.
          if (cfg.toLowerCase().includes(GBRAIN_GITHUB_REPO.toLowerCase())) {
            return 'bun-link';
          }
        } catch { /* unreadable config — not our case */ }
        return null; // found .git/config but no match → not our repo
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
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
 * When `bun add -g gbrain` (or `npm install -g gbrain`) installs from
 * npm, the package is the squatter — an unrelated `gbrain@1.3.x` that
 * silently overwrites our binary. This function reads the install
 * directory's package.json and checks two non-spoofable signals:
 *   - `repository.url` contains `garrytan/gbrain` (case-insensitive)
 *   - the install dir contains a `src/cli.ts` file (squatter ships
 *     compiled binary, not source)
 *
 * If neither matches, returns 'suspect' and the caller surfaces a loud
 * recovery message. Codex's plan-review noted these signals are spoofable
 * by a determined squatter — accepted; this is best-effort warning, not
 * an assertion. The right structural fix is publishing under a scoped
 * name like `@garrytan/gbrain` (tracked v0.29 follow-up).
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
          if (repoUrl.toLowerCase().includes(GBRAIN_GITHUB_REPO.toLowerCase())) {
            return 'canonical';
          }
          // Source-marker fallback: our published-as-source install always
          // ships src/cli.ts next to package.json. The squatter ships dist/.
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

function printSquatterRecovery(): void {
  console.warn('');
  console.warn('  WARNING: gbrain install does not appear to be from garrytan/gbrain.');
  console.warn('  This is likely the npm-name collision tracked in issue #658:');
  console.warn('    https://www.npmjs.com/package/gbrain (an unrelated package).');
  console.warn('');
  console.warn('  Recovery options:');
  console.warn('    1. Install from source:');
  console.warn('         bun remove -g gbrain');
  console.warn('         git clone https://github.com/garrytan/gbrain.git');
  console.warn('         cd gbrain && bun install && bun link');
  console.warn('');
  console.warn('    2. Download a release binary:');
  console.warn('         https://github.com/garrytan/gbrain/releases');
  console.warn('');
  console.warn('  See docs/INSTALL_FOR_AGENTS.md for the canonical install paths.');
  console.warn('');
}
