import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
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
    // Run post-upgrade feature discovery (reads migration files from the NEW binary)
    try {
      execSync('gbrain post-upgrade', { stdio: 'inherit', timeout: 30_000 });
    } catch {
      // post-upgrade is best-effort, don't fail the upgrade
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
 * Post-upgrade feature discovery. Reads migration files between old and new version,
 * prints feature pitches from YAML frontmatter. Called by `gbrain post-upgrade` which
 * runs the NEW binary after upgrade completes.
 */
export function runPostUpgrade() {
  try {
    const statePath = join(process.env.HOME || '', '.gbrain', 'upgrade-state.json');
    if (!existsSync(statePath)) return;
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const lastUpgrade = state.last_upgrade;
    if (!lastUpgrade?.from || !lastUpgrade?.to) return;

    // Find migration files in version range
    const migrationsDir = findMigrationsDir();
    if (!migrationsDir) return;

    const files = readdirSync(migrationsDir)
      .filter(f => f.match(/^v\d+\.\d+\.\d+\.md$/))
      .sort();

    for (const file of files) {
      const version = file.replace(/^v/, '').replace(/\.md$/, '');
      if (isNewerThan(version, lastUpgrade.from)) {
        const content = readFileSync(join(migrationsDir, file), 'utf-8');
        const pitch = extractFeaturePitch(content);
        if (pitch) {
          console.log('');
          console.log(`NEW: ${pitch.headline}`);
          if (pitch.description) console.log(pitch.description);
          if (pitch.recipe) {
            console.log(`Run \`gbrain integrations show ${pitch.recipe}\` to set it up.`);
          }
          console.log('');
        }
      }
    }
  } catch {
    // post-upgrade is best-effort
  }
}

function findMigrationsDir(): string | null {
  // Try relative to this file (source install)
  const candidates = [
    resolve(__dirname, '../../skills/migrations'),
    resolve(process.cwd(), 'skills/migrations'),
    resolve(process.cwd(), 'node_modules/gbrain/skills/migrations'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

function extractFeaturePitch(content: string): { headline: string; description?: string; recipe?: string } | null {
  // Parse YAML frontmatter for feature_pitch
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  const headlineMatch = fm.match(/headline:\s*["']?(.+?)["']?\s*$/m);
  if (!headlineMatch) return null;

  const descMatch = fm.match(/description:\s*["']?(.+?)["']?\s*$/m);
  const recipeMatch = fm.match(/recipe:\s*["']?(.+?)["']?\s*$/m);

  return {
    headline: headlineMatch[1],
    description: descMatch?.[1],
    recipe: recipeMatch?.[1],
  };
}

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
