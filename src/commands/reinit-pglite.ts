/**
 * `gbrain reinit-pglite` — wipe-and-reinit PGLite brain in one command.
 *
 * v0.37 fix wave (deferred TODO, shipped end-of-wave): the canonical path
 * for switching embedding models / dimensions on PGLite is wipe-and-reinit
 * (PGLite cannot `ALTER COLUMN TYPE vector(N)` — pgvector ships as WASM).
 * The recipe is 3 commands by hand:
 *
 *   mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak
 *   gbrain init --pglite --embedding-model X --embedding-dimensions N
 *   gbrain sync
 *
 * This command wraps that into one call so users (and agents reading
 * `embeddingMismatchMessage` recipes) don't have to type the wipe + the
 * init + the sync separately.
 *
 * Destructive. TTY confirmation required unless `--yes` is passed. JSON
 * output via `--json` for scripted callers.
 */

import { existsSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { loadConfig, loadConfigFileOnly, gbrainPath, isThinClient, type GBrainConfig } from '../core/config.ts';
import { acquireLock, acquireMaintenanceLock, releaseLock, type LockHandle } from '../core/pglite-lock.ts';

interface ReinitOpts {
  embeddingModel: string;
  embeddingDimensions: number;
  yes: boolean;
  jsonOutput: boolean;
  customPath: string | null;
  noSync: boolean;
}

export interface PreservePgliteDirAndReinitOpts {
  dbPath: string;
  backupPath: string;
  initArgs: string[];
  jsonOutput: boolean;
  syncAfter: boolean;
}

export interface PreservePgliteDirAndReinitResult {
  brainPath: string;
  backupPath: string;
  synced: boolean;
}

export async function runReinitPglite(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  // Confirm we're on PGLite. Refusing on Postgres because the SQL recipe
  // works there and migrating data is non-destructive — wipe-and-reinit
  // on Postgres would drop the entire brain.
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    fail(
      opts.jsonOutput,
      'thin_client',
      `gbrain reinit-pglite requires a local PGLite brain. This install is a thin client of ${cfg!.remote_mcp!.mcp_url}. Run it on the remote host.`,
    );
  }
  if (cfg?.engine !== 'pglite') {
    fail(
      opts.jsonOutput,
      'not_pglite',
      `gbrain reinit-pglite is for PGLite brains only (current engine: ${cfg?.engine || 'none'}). ` +
        `For Postgres, see docs/embedding-migrations.md for the in-place ALTER recipe.`,
    );
  }

  // Resolve the active brain path. `--path` override > config > default.
  const dbPath = opts.customPath
    || cfg.database_path
    || gbrainPath('brain.pglite');

  if (!existsSync(dbPath)) {
    fail(
      opts.jsonOutput,
      'no_brain',
      `No PGLite brain found at ${dbPath}. Run \`gbrain init --pglite\` to create one.`,
    );
  }

  // Size for the user's awareness.
  let sizeMb = 0;
  try {
    const stats = statSync(dbPath);
    sizeMb = Math.round((stats.size / (1024 * 1024)) * 10) / 10;
  } catch { /* best-effort */ }

  // Show plan.
  if (!opts.jsonOutput) {
    console.log('');
    console.log('gbrain reinit-pglite — wipe and re-create the PGLite brain.');
    console.log('');
    console.log('  Active brain:        ' + dbPath + (sizeMb > 0 ? ` (${sizeMb} MB)` : ''));
    console.log('  Backup destination:  ' + dbPath + '.bak');
    console.log('  New embedding model: ' + opts.embeddingModel);
    console.log('  New dimensions:      ' + opts.embeddingDimensions);
    console.log('  Re-sync after init:  ' + (opts.noSync ? 'NO (--no-sync)' : 'YES'));
    console.log('');
    console.log('This is destructive: every page, chunk, and embedding in the');
    console.log('brain is wiped. The .bak file lets you roll back by `mv`.');
    console.log('');
  }

  // TTY confirmation.
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      fail(
        opts.jsonOutput,
        'no_tty_no_yes',
        'Non-TTY environment requires --yes to confirm destruction.',
      );
    }
    const confirmed = await promptYesNo('Wipe and reinit?');
    if (!confirmed) {
      if (opts.jsonOutput) {
        console.log(JSON.stringify({ status: 'aborted', reason: 'user_declined' }));
      } else {
        console.log('Aborted. Brain untouched.');
      }
      process.exit(0);
    }
  }

  // Step 1: back up existing brain.
  // If a previous .bak exists, refuse rather than silently overwriting it —
  // the user's last rollback target is more valuable than this attempt's.
  const bakPath = dbPath + '.bak';
  if (existsSync(bakPath)) {
    fail(
      opts.jsonOutput,
      'bak_exists',
      `Backup already exists at ${bakPath}. Move or delete it first to avoid clobbering your previous rollback target.`,
    );
  }

  // Preserve user config BEFORE init (Lane B.4 already does this, but
  // belt-and-suspenders for the reinit command's contract).
  const existingFile = loadConfigFileOnly();
  void existingFile; // referenced for the comment above; init.ts handles the merge

  // Step 2: re-init with the new model/dimensions. Delegate to runInit
  // so we go through the full Lane B precedence chain + dim-mismatch
  // detector + saveConfig merge.
  const initArgs = [
    '--pglite',
    '--embedding-model', opts.embeddingModel,
    '--embedding-dimensions', String(opts.embeddingDimensions),
  ];
  if (opts.customPath) {
    initArgs.push('--path', opts.customPath);
  }
  if (opts.jsonOutput) initArgs.push('--json');

  let result: PreservePgliteDirAndReinitResult;
  try {
    result = await preservePgliteDirAndReinit({
      dbPath,
      backupPath: bakPath,
      initArgs,
      jsonOutput: opts.jsonOutput,
      syncAfter: !opts.noSync,
    });
  } catch (e: unknown) {
    fail(
      opts.jsonOutput,
      'reinit_failed',
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!opts.jsonOutput) console.log(`Backed up brain to ${result.backupPath}`);

  if (opts.jsonOutput) {
    console.log(JSON.stringify({
      status: 'success',
      brain_path: result.brainPath,
      backup_path: result.backupPath,
      embedding_model: opts.embeddingModel,
      embedding_dimensions: opts.embeddingDimensions,
      synced: result.synced,
    }));
  } else {
    console.log('');
    console.log('Reinit complete. To roll back:');
    console.log(`  mv ${bakPath} ${dbPath}`);
  }
}

export async function preservePgliteDirAndReinit(
  opts: PreservePgliteDirAndReinitOpts,
): Promise<PreservePgliteDirAndReinitResult> {
  let maintenanceLock: LockHandle | null = null;
  let dataLock: LockHandle | null = null;
  try {
    maintenanceLock = await acquireMaintenanceLock(opts.dbPath);
    dataLock = await acquireLock(opts.dbPath);

    try {
      renameSync(opts.dbPath, opts.backupPath);
      if (dataLock.lockDir) {
        dataLock.lockDir = join(opts.backupPath, '.gbrain-lock');
        dataLock.lockPath = join(dataLock.lockDir, 'lock');
      }
    } catch (e: unknown) {
      throw new Error(`Failed to back up brain to ${opts.backupPath}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (dataLock?.acquired) {
        try { await releaseLock(dataLock); } catch { /* best-effort cleanup */ }
        dataLock = null;
      }
    }

    const { runInit } = await import('./init.ts');
    await withOptionalStdoutSilence(opts.jsonOutput, () => runInit(opts.initArgs));

    let synced = false;
    if (opts.syncAfter) {
      if (!opts.jsonOutput) console.log('');
      if (!opts.jsonOutput) console.log('Re-syncing brain repo...');
      try {
        const { createEngine } = await import('../core/engine-factory.ts');
        const newCfg = loadConfig();
        if (!newCfg) {
          if (!opts.jsonOutput) console.error('Warning: no config after reinit; skipping sync. Run `gbrain sync` manually.');
          return { brainPath: opts.dbPath, backupPath: opts.backupPath, synced: false };
        }
        const engine = await createEngine({ engine: 'pglite' });
        await engine.connect({ database_path: newCfg.database_path || opts.dbPath, engine: 'pglite' });
        try {
          const { runSync } = await import('./sync.ts');
          await withOptionalStdoutSilence(opts.jsonOutput, () => runSync(engine, []));
          synced = true;
        } finally {
          try { await engine.disconnect(); } catch { /* best-effort */ }
        }
      } catch (e: unknown) {
        if (!opts.jsonOutput) {
          console.error('');
          console.error(`Warning: sync after reinit failed (${e instanceof Error ? e.message : String(e)}).`);
          console.error('The brain is initialized but empty. Run `gbrain sync` to populate it.');
        }
      }
    }

    return { brainPath: opts.dbPath, backupPath: opts.backupPath, synced };
  } finally {
    if (dataLock?.acquired) {
      try { await releaseLock(dataLock); } catch { /* best-effort cleanup */ }
    }
    if (maintenanceLock?.acquired) {
      try { await releaseLock(maintenanceLock); } catch { /* best-effort cleanup */ }
    }
  }
}

async function withOptionalStdoutSilence<T>(
  silence: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!silence) return fn();
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

export function buildPgliteReinitArgsFromConfig(
  cfg: GBrainConfig,
  dbPath: string,
  opts?: { jsonOutput?: boolean },
): string[] {
  const initArgs = ['--pglite', '--path', dbPath];
  if (cfg.embedding_model) {
    initArgs.push('--embedding-model', cfg.embedding_model);
  }
  if (cfg.embedding_dimensions) {
    initArgs.push('--embedding-dimensions', String(cfg.embedding_dimensions));
  }
  if (opts?.jsonOutput) initArgs.push('--json');
  return initArgs;
}

function parseArgs(args: string[]): ReinitOpts {
  const helpRequested = args.includes('--help') || args.includes('-h');
  if (helpRequested) {
    printHelp();
    process.exit(0);
  }

  const yes = args.includes('--yes') || args.includes('-y');
  const jsonOutput = args.includes('--json');
  const noSync = args.includes('--no-sync');

  const modelIdx = args.indexOf('--embedding-model');
  const dimsIdx = args.indexOf('--embedding-dimensions');
  const pathIdx = args.indexOf('--path');

  if (modelIdx < 0 || modelIdx === args.length - 1) {
    fail(jsonOutput, 'missing_model', '--embedding-model <provider:model> is required.');
  }
  if (dimsIdx < 0 || dimsIdx === args.length - 1) {
    fail(jsonOutput, 'missing_dims', '--embedding-dimensions <N> is required.');
  }

  const dimsStr = args[dimsIdx + 1];
  const dims = parseInt(dimsStr, 10);
  if (!Number.isInteger(dims) || dims <= 0) {
    fail(jsonOutput, 'invalid_dims', `--embedding-dimensions must be a positive integer (got: ${dimsStr}).`);
  }

  return {
    embeddingModel: args[modelIdx + 1],
    embeddingDimensions: dims,
    yes,
    jsonOutput,
    customPath: pathIdx >= 0 && pathIdx < args.length - 1 ? args[pathIdx + 1] : null,
    noSync,
  };
}

function printHelp(): void {
  console.log(`Usage: gbrain reinit-pglite [options]

Wipe the PGLite brain and re-init with new embedding model/dimensions.
This is the canonical path for switching embedding providers on PGLite
because pgvector (WASM) cannot ALTER vector column types in place.

Required:
  --embedding-model <provider:model>   New embedding model (e.g. openai:text-embedding-3-large).
  --embedding-dimensions <N>           New dimension count (e.g. 1280, 1536, 2048).

Optional:
  --path <path>                        Active brain path (default: ~/.gbrain/brain.pglite).
  --yes / -y                           Skip the TTY confirmation prompt.
  --no-sync                            Skip the post-init \`gbrain sync\`.
  --json                               Emit structured JSON output on stdout.

Examples:
  # Switch from OpenAI/1536 to ZeroEntropy/1280:
  gbrain reinit-pglite --embedding-model zeroentropyai:zembed-1 --embedding-dimensions 1280

  # Skip the sync step (do it later):
  gbrain reinit-pglite --embedding-model openai:text-embedding-3-large \\
    --embedding-dimensions 1536 --no-sync

The old brain is preserved as \`<path>.bak\`. To roll back, mv it back.

See also:
  gbrain doctor                        Diagnose dim mismatches before/after.
  docs/embedding-migrations.md         Full background + Postgres recipe.
`);
}

function fail(jsonOutput: boolean, reason: string, message: string): never {
  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'error', reason, message }));
  } else {
    console.error(message);
  }
  process.exit(1);
}

async function promptYesNo(question: string): Promise<boolean> {
  // Minimal TTY prompt — no external deps. Bun's process.stdin reads
  // a single line synchronously via the async iterator.
  process.stdout.write(`${question} (y/N): `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stdin = process.stdin as any;
  stdin.setEncoding?.('utf8');
  return new Promise<boolean>((resolve) => {
    const onData = (chunk: string) => {
      const answer = chunk.trim().toLowerCase();
      stdin.off?.('data', onData);
      resolve(answer === 'y' || answer === 'yes');
    };
    stdin.on?.('data', onData);
  });
}
