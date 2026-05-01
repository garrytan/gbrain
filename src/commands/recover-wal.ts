import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, renameSync, cpSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig } from '../core/config.ts';

/**
 * Automate WAL recovery for PGLite brains that abort on open with
 *   PANIC: could not locate a valid checkpoint record
 *
 * Pipeline:
 *   1. Resolve target data dir (--data-dir override or current PGLite config)
 *   2. Verify docker is available
 *   3. Stage a copy under ~/.gbrain/recovery-work/ (NOT /tmp — that path may
 *      be hidden from the docker daemon when called from a sandboxed shell)
 *   4. Run pg_resetwal -f inside pgvector/pgvector:pg17 container
 *   5. Validate by opening recovered dir with PGLite + counting pages
 *   6. Rename original to brain.pglite.corrupt.<ts>; move recovered into place
 *
 * The standard pgvector image is built WITH USE_FLOAT8_BYVAL but PGLite WASM
 * is built WITHOUT it — so we run only pg_resetwal in the container, never
 * try to start the postgres server. PGLite (matching float8 settings) opens
 * the WAL-reset dir directly.
 */
export async function runRecoverWal(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) { printHelp(); return; }

  const dataDir = resolveDataDir(opts.dataDir);
  log(`Target data dir: ${dataDir}`);

  if (!existsSync(dataDir)) {
    fail(`Data dir does not exist: ${dataDir}`);
  }
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    fail(`Not a PGLite/Postgres data dir (missing PG_VERSION): ${dataDir}`);
  }

  ensureDockerAvailable();

  const workRoot = join(dirname(dataDir), 'recovery-work');
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });

  log(`Staging copy in ${workRoot}/source/ ...`);
  cpSync(dataDir, join(workRoot, 'source'), { recursive: true });
  rmSync(join(workRoot, 'source/postmaster.pid'), { force: true });

  const scriptPath = join(workRoot, 'recover.sh');
  writeFileSync(scriptPath, RECOVER_SCRIPT);
  chmodSync(scriptPath, 0o755);

  log('Pulling pgvector/pgvector:pg17 image (skipped if cached) ...');
  spawnSync('docker', ['pull', 'pgvector/pgvector:pg17'],
    { stdio: opts.quiet ? 'ignore' : 'inherit' });

  log('Running pg_resetwal -f inside container ...');
  const dockerResult = spawnSync('docker', [
    'run', '--rm',
    '-v', `${workRoot}:/data`,
    'pgvector/pgvector:pg17',
    'bash', '/data/recover.sh',
  ], { stdio: opts.quiet ? 'pipe' : 'inherit' });

  if (dockerResult.status !== 0) {
    if (opts.quiet && dockerResult.stderr) {
      process.stderr.write(dockerResult.stderr);
    }
    fail(`docker pg_resetwal failed (exit ${dockerResult.status}). Recovery aborted; original data dir untouched.`);
  }

  const recoveredDir = join(workRoot, 'recovered');
  if (!existsSync(recoveredDir)) {
    fail('Recovery script completed but recovered dir is missing. Aborted.');
  }

  log('Validating recovered dir with PGLite ...');
  const pageCount = await validateRecovered(recoveredDir);
  log(`  ✓ Recovered DB opens cleanly. Page count: ${pageCount}`);

  if (opts.dryRun) {
    log('--dry-run set: leaving recovered dir at ' + recoveredDir);
    log('Original data dir untouched.');
    return;
  }

  const ts = Math.floor(Date.now() / 1000);
  const corruptName = dataDir + '.corrupt.' + ts;
  log(`Renaming original to ${corruptName} ...`);
  renameSync(dataDir, corruptName);

  log(`Moving recovered into place at ${dataDir} ...`);
  renameSync(recoveredDir, dataDir);

  rmSync(join(workRoot, 'source'), { recursive: true, force: true });
  rmSync(scriptPath, { force: true });

  log('');
  log('✓ Recovery complete.');
  log(`  Recovered brain:    ${dataDir} (${pageCount} pages)`);
  log(`  Original kept at:   ${corruptName}`);
  log(`  Working dir:        ${workRoot} (safe to delete)`);
  log('');
  log('Run `gbrain doctor` to confirm health.');
}

function parseArgs(args: string[]) {
  const opts = { dataDir: '', dryRun: false, quiet: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--data-dir') opts.dataDir = args[++i] || '';
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--quiet') opts.quiet = true;
    else { fail(`Unknown argument: ${a}`); }
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    'Usage: gbrain recover-wal [options]',
    '',
    'Recover a PGLite brain that aborts on open with WAL corruption',
    '("could not locate a valid checkpoint record"). Runs pg_resetwal',
    'inside a docker container against a copy, validates with PGLite,',
    'then swaps in. Original data dir is renamed (not deleted).',
    '',
    'Requires: docker',
    '',
    'Options:',
    '  --data-dir <path>   Target data dir (default: configured PGLite path)',
    '  --dry-run           Recover and validate, but do not swap into place',
    '  --quiet             Suppress docker progress output',
    '  -h, --help          Show this help',
    '',
  ].join('\n'));
}

function resolveDataDir(override: string): string {
  if (override) return override;
  const config = loadConfig();
  if (!config) {
    fail('No brain configured and no --data-dir given. Run `gbrain init` or pass --data-dir <path>.');
  }
  if (config.engine !== 'pglite') {
    fail(`Configured engine is "${config.engine}", not "pglite". recover-wal only applies to PGLite brains.`);
  }
  const dataDir = config.database_path || join(homedir(), '.gbrain', 'brain.pglite');
  return dataDir;
}

function ensureDockerAvailable(): void {
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch {
    fail([
      'docker is required for `gbrain recover-wal` and was not found in PATH.',
      'Install Docker, or recover manually:',
      '  1. Install postgresql-client-17 (matching pg_resetwal binary)',
      '  2. cp -a brain.pglite recovered && rm recovered/postmaster.pid',
      '  3. pg_resetwal -f recovered',
      '  4. mv brain.pglite brain.pglite.corrupt.$(date +%s) && mv recovered brain.pglite',
    ].join('\n'));
  }
}

async function validateRecovered(dir: string): Promise<number> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const db = await PGlite.create({ dataDir: dir, extensions: { vector, pg_trgm } });
  try {
    const r = await db.query<{ count: number | string }>('SELECT count(*) AS count FROM pages');
    return Number(r.rows[0]?.count ?? 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`Recovered DB opened but pages count failed: ${msg}`);
  } finally {
    await db.close();
  }
  return 0;
}

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

function fail(msg: string): never {
  process.stderr.write(`gbrain recover-wal: ${msg}\n`);
  process.exit(1);
}

const RECOVER_SCRIPT = `#!/bin/bash
set -e

echo "== Copying source -> /data/recovered =="
rm -rf /data/recovered
cp -a /data/source /data/recovered
chown -R postgres:postgres /data/recovered
chmod 700 /data/recovered

echo "== PG_VERSION: $(cat /data/recovered/PG_VERSION) =="

echo "== Running pg_resetwal -f =="
su postgres -c "pg_resetwal -f /data/recovered"

echo "== Restoring host ownership (1000:1000) =="
chown -R 1000:1000 /data/recovered

echo "== Done =="
`;
