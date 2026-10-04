import { backupUnmanagedPglite } from '../core/persistence/maintenance.ts';
import { assertManagedFilesystemWrite } from '../core/persistence/filesystem-guard.ts';
/**
 * `gbrain reinit-pglite` — wipe-and-reinit PGLite brain in one command.
 *
 * Last-resort width change on PGLite (PGLite cannot `ALTER COLUMN TYPE
 * vector(N)` — pgvector ships as WASM): moves the datastore aside to
 * `<path>.bak`, re-inits at the new width and re-syncs the brain repo.
 * DB-only pages and `remember` facts are NOT carried over (they live only in
 * the moved-aside datastore). Turning embeddings on for a keyless brain never
 * needs this: readiness's `embeddingEnablement` enables in place and keeps
 * everything; a width change with preserved data is
 * `gbrain migrate embeddings --to <model> --dim <N>`.
 *
 * Destructive. Consent via requireConsent (A4): a TTY prompt, or
 * `--yes --expect <plan_hash>` (bound to this brain and target); non-TTY
 * without it exits 3 with the consent payload. `--json` for scripts.
 */

import { existsSync, statSync, rmSync } from 'fs';
import { dirname } from 'path';
import { loadConfig, loadConfigFileOnly, gbrainPath } from '../core/config.ts';
import { computePlanHash, type PlanSelection } from '../core/consent.ts';
import { consentGateOrExit } from '../core/consent-cli.ts';

interface ReinitOpts {
  embeddingModel: string;
  embeddingDimensions: number;
  yes: boolean;
  jsonOutput: boolean;
  customPath: string | null;
  noSync: boolean;
}

export async function runReinitPglite(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  // Confirm we're on PGLite. Refusing on Postgres because the SQL recipe
  // works there and migrating data is non-destructive — wipe-and-reinit
  // on Postgres would drop the entire brain.
  const cfg = loadConfig();
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

  assertManagedFilesystemWrite(dbPath);

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

  // Consent (A4): destructive, bound to the plan (this brain path and the new
  // model/width): the approved command is `--yes --expect <plan_hash>`, so a
  // bare `--yes` retry re-asks instead of wiping.
  // Non-TTY without --yes refuses with exit 3 and the consent payload; --json
  // never implies consent; EOF/timeout at the TTY prompt is a decline.
  const bakPath = dbPath + '.bak';
  // Refuse before asking: the user's last rollback target is more valuable than this attempt's.
  if (existsSync(bakPath)) {
    fail(
      opts.jsonOutput,
      'bak_exists',
      `Backup already exists at ${bakPath}. Move or delete it first to avoid clobbering your previous rollback target.`,
    );
  }
  const reinitArgv = ['gbrain', 'reinit-pglite', '--embedding-model', opts.embeddingModel,
    '--embedding-dimensions', String(opts.embeddingDimensions),
    ...(opts.customPath ? ['--path', opts.customPath] : []), ...(opts.noSync ? ['--no-sync'] : [])];
  const selection: PlanSelection = { brain: dbPath, source: null, operation: 'reinit-pglite', records: [{ id: dbPath }],
    parameters: { embedding_model: opts.embeddingModel, embedding_dimensions: opts.embeddingDimensions, sync: !opts.noSync },
    effects: ['destructive'] };
  await consentGateOrExit({
    command: 'reinit-pglite', effects: ['destructive'], actor: 'agent',
    what: `Wipe and re-create the PGLite brain at ${dbPath}`,
    why: `PGLite cannot change the vector width in place, so the brain is moved aside and re-initialized at ${opts.embeddingDimensions} dimensions for ${opts.embeddingModel}.`,
    risk: `Every page, chunk and embedding is removed from the active brain; DB-only pages and remember facts are NOT carried over `
      + `(they stay only in the backup). The brain is first moved to ${bakPath}; restore with: mv ${bakPath} ${dbPath}. `
      + `To keep everything instead, use gbrain migrate embeddings --to <model> --dim <N>.`,
    user_message: `Wipe and re-create your brain (${sizeMb > 0 ? `${sizeMb} MB, ` : ''}${dbPath}) for ${opts.embeddingModel}? `
      + `DB-only pages and remembered facts are not carried over; a backup is kept at ${bakPath}.`,
    argv: reinitArgv,
    plan_hash: computePlanHash(selection),
    selection,
    args: opts.yes ? [...args, '--yes'] : args,
  }, { json: opts.jsonOutput });

  // Step 1: back up existing brain (the .bak collision was refused above).

  // Preserve user config BEFORE init (Lane B.4 already does this, but
  // belt-and-suspenders for the reinit command's contract).
  const existingFile = loadConfigFileOnly();
  void existingFile; // referenced for the comment above; init.ts handles the merge

  try {
    await backupUnmanagedPglite(dbPath, bakPath);
  // WAL-repair state travels with the OLD brain (red-team: a fresh brain at
  // the same path must not inherit the old brain's open repair episode,
  // cooldown, or reap quarantine — a stale episodeBackupPath would be reused
  // over the NEW brain's WAL).
  for (const sibling of [`${dbPath}.wal-repair-attempt.json`, `${dbPath}.lock-reap.json`, `${dbPath}.repair-failed.json`]) {
    try { rmSync(sibling, { force: true }); } catch { /* best-effort */ }
  }
  } catch (e: unknown) {
    fail(
      opts.jsonOutput,
      'backup_failed',
      `Failed to back up brain to ${bakPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!opts.jsonOutput) console.log(`Backed up brain to ${bakPath}`);

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

  const { runInit } = await import('./init.ts');
  await runInit(initArgs);

  // Step 3: re-sync (unless --no-sync). Best-effort because the user
  // already has a working brain; sync failure shouldn't roll back.
  if (!opts.noSync) {
    if (!opts.jsonOutput) console.log('');
    if (!opts.jsonOutput) console.log('Re-syncing brain repo...');
    try {
      // Need an engine handle to call runSync. Open one against the
      // freshly-init'd brain.
      const { createEngine } = await import('../core/engine-factory.ts');
      const newCfg = loadConfig();
      if (!newCfg) {
        if (!opts.jsonOutput) console.error('Warning: no config after reinit; skipping sync. Run `gbrain sync` manually.');
        return;
      }
      const engine = await createEngine({ engine: 'pglite' });
      await engine.connect({ database_path: newCfg.database_path || dbPath, engine: 'pglite' });
      try {
        const { runSync } = await import('./sync.ts');
        await runSync(engine, []);
      } finally {
        try { await engine.disconnect(); } catch { /* best-effort */ }
      }
    } catch (e: unknown) {
      if (!opts.jsonOutput) {
        console.error('');
        console.error(`Warning: sync after reinit failed (${e instanceof Error ? e.message : String(e)}).`);
        console.error('The brain is initialized but empty. Run \`gbrain sync\` to populate it.');
      }
    }
  }

  if (opts.jsonOutput) {
    console.log(JSON.stringify({
      status: 'success',
      brain_path: dbPath,
      backup_path: bakPath,
      embedding_model: opts.embeddingModel,
      embedding_dimensions: opts.embeddingDimensions,
      synced: !opts.noSync,
    }));
  } else {
    console.log('');
    console.log('Reinit complete. To roll back:');
    console.log(`  mv ${bakPath} ${dbPath}`);
  }
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

  // Default omitted flags from the config FILE. Deliberately
  // `loadConfigFileOnly()`, NOT `loadConfig()`: loadConfig merges the
  // GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS env overrides,
  // and a transient outage-shell export must not silently change the
  // rebuild target. Precedence: explicit flag > config-file value >
  // hard-fail (the original missing_model/missing_dims errors).
  const fileCfg = (modelIdx < 0 || dimsIdx < 0) ? loadConfigFileOnly() : null;

  let embeddingModel: string;
  if (modelIdx >= 0) {
    if (modelIdx === args.length - 1) {
      fail(jsonOutput, 'missing_model', '--embedding-model <provider:model> is required.');
    }
    embeddingModel = args[modelIdx + 1];
  } else if (fileCfg?.embedding_model) {
    embeddingModel = fileCfg.embedding_model;
    console.error(`--embedding-model defaulted from config: ${embeddingModel}`);
  } else {
    fail(
      jsonOutput,
      'missing_model',
      '--embedding-model <provider:model> is required (no embedding_model in the config file to default from).',
    );
  }

  let dimsStr: string;
  let dimsFromConfig = false;
  if (dimsIdx >= 0) {
    if (dimsIdx === args.length - 1) {
      fail(jsonOutput, 'missing_dims', '--embedding-dimensions <N> is required.');
    }
    dimsStr = args[dimsIdx + 1];
  } else if (fileCfg?.embedding_dimensions !== undefined && fileCfg?.embedding_dimensions !== null) {
    dimsStr = String(fileCfg.embedding_dimensions);
    dimsFromConfig = true;
  } else {
    fail(
      jsonOutput,
      'missing_dims',
      '--embedding-dimensions <N> is required (no embedding_dimensions in the config file to default from).',
    );
  }

  const dims = parseInt(dimsStr, 10);
  if (!Number.isInteger(dims) || dims <= 0) {
    fail(jsonOutput, 'invalid_dims', `--embedding-dimensions must be a positive integer (got: ${dimsStr}).`);
  }
  if (dimsFromConfig) {
    console.error(`--embedding-dimensions defaulted from config: ${dims}`);
  }

  return {
    embeddingModel,
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

Embedding target (each defaults from the config file when omitted):
  --embedding-model <provider:model>   New embedding model (e.g. openai:text-embedding-3-large).
                                       Defaults to embedding_model in ~/.gbrain/config.json.
  --embedding-dimensions <N>           New dimension count (e.g. 1280, 1536, 2048).
                                       Defaults to embedding_dimensions in ~/.gbrain/config.json.

Defaults read the config FILE only; GBRAIN_EMBEDDING_MODEL /
GBRAIN_EMBEDDING_DIMENSIONS env overrides are deliberately ignored so a
transient shell export cannot change the rebuild target. If neither the
flag nor the config file provides a value, the command fails.

Optional:
  --path <path>                        Active brain path (default: ~/.gbrain/brain.pglite).
  --yes --expect <plan_hash>           Authorize the wipe without a prompt, only after the user
                                       approved it (the refusal prints the exact command).
  --no-sync                            Skip the post-init \`gbrain sync\`.
  --json                               Emit structured JSON output on stdout.

Examples:
  # Switch from OpenAI/1536 to Voyage/1024:
  gbrain reinit-pglite --embedding-model voyage:voyage-4 --embedding-dimensions 1024

  # Skip the sync step (do it later):
  gbrain reinit-pglite --embedding-model openai:text-embedding-3-large \\
    --embedding-dimensions 1536 --no-sync

  # Rebuild with the model/dimensions already in the config file (prints
  # the plan and asks; non-interactive callers get the approved command):
  gbrain reinit-pglite

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
