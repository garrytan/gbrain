import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { VERSION } from '../version.ts';

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
      console.log('  https://github.com/momoiicom/open-gbrain/releases');
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
      console.log('  Download from https://github.com/momoiicom/open-gbrain/releases');
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

export function detectInstallMethod(): 'bun' | 'binary' | 'clawhub' | 'unknown' {
  const execPath = process.execPath || '';

  // Check if running from node_modules (bun/npm install)
  if (execPath.includes('node_modules') || process.argv[1]?.includes('node_modules')) {
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
