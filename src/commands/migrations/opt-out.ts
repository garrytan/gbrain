/**
 * #6466: a brain owner can decline a host migration. A `Migration` with
 * `optOut: { key }` is `declined` while the brain's DB config holds an
 * explicit off value under that key (`gbrain config set <key> false`); the
 * runner then never calls its orchestrator, not even the reconcile re-check
 * an applied ledger entry would rerun, and an explicit `--migration <v>`
 * refuses with `migration_declined` (exit 3). The keys live in
 * `core/migration-ledger.ts` (MIGRATION_OPT_OUT_KEYS, registry-free so doctor
 * and get_health read them without the registry). The key is brain-level config
 * shared by every machine on that database, so one machine's explicit run
 * does not override what the owner set for all of them.
 */
import { createEngine } from '../../core/engine-factory.ts';
import { isThinClient, toEngineConfig, type GBrainConfig } from '../../core/config.ts';
import { declinedMigrations } from '../../core/migration-ledger.ts';
import { opError, type OperationError } from '../../core/ops/contract.ts';
import type { Migration } from './types.ts';

export { declinedMigrations, isMigrationDeclinedValue } from '../../core/migration-ledger.ts';

/**
 * The runner's read: opens the brain to read the opt-out keys, and treats an
 * unreachable brain (or a thin client) as "nothing declined"; the
 * orchestrator then reports the same failure it would have anyway.
 */
export async function readDeclinedMigrations(config: GBrainConfig): Promise<Set<string>> {
  if (isThinClient(config)) return new Set();
  try {
    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    try { return await declinedMigrations(engine); } finally { await engine.disconnect(); }
  } catch {
    return new Set();
  }
}

export function migrationDeclinedError(m: Migration): OperationError {
  const key = m.optOut?.key ?? '';
  return opError('migration_declined',
    `Migration v${m.version} is declined on this brain: ${key} is false, so apply-migrations skips it (its headline: ${m.featurePitch.headline}). Nothing was run or written.`,
    `Leave it declined, or ask the user to turn it back on with \`gbrain config set ${key} true\` and run apply-migrations again.`,
    { why: `${key} is brain-level config shared by every machine on this database; an explicit run from one machine would rewrite config for all of them, so it refuses instead of overriding the owner's choice.`,
      fix: { ask_user: true, argv: ['gbrain', 'config', 'set', key, 'true'], consent: [], actor: 'user', requires_exclusive: false,
        why: 'Re-enables the declined migration for every machine on this brain; the next apply-migrations runs it.',
        user_message: `Migration v${m.version} is turned off on this brain (${key}=false). Turn it back on and run it?`,
        verify: { argv: ['gbrain', 'apply-migrations', '--list', '--json'] } } });
}
