import type { BrainEngine } from '../../core/engine.ts';
import { readManagedMode } from '../../core/persistence/ownership.ts';
import { managedForbiddenFlag, managedSyncFlagRefusal } from '../../core/persistence/managed-sync-flags.ts';

/**
 * #6543 C1: managed sync never runs `git pull` (its only use of `noPull` was the refusal), so a CLI sync on a managed
 * brain implies `--no-pull` and says once, on stderr, how to take fresh Git content. Set before the single-source,
 * `--all` and serve-delegated paths read the flags. An unreadable managed state implies nothing; the sync then refuses
 * with its own error. The library and MCP refusal of an explicit pull stays in `resolveManagedSyncContext`.
 */
export async function implyManagedNoPull(engine: BrainEngine, flags: { noPull: boolean; dryRun: boolean }, sourceId: string | null): Promise<void> {
  if (flags.noPull || flags.dryRun || !await readManagedMode(engine).catch(() => false)) return;
  flags.noPull = true;
  process.stderr.write(`[sync] managed brain: importing ${sourceId ? `source ${sourceId}'s` : "each source's"} checkout at its local HEAD without git pull (--no-pull is implied); `
    + `to fast-forward from the remote first, run gbrain sources refresh ${sourceId ?? '<id>'}\n`);
}

/**
 * #6696 C2: on a managed brain, `--skip-failed` and `--include-gitignored` are refused here, at parse, before the
 * legacy ledger is acknowledged, the cost gate runs or anything is delegated, naming the flag. An unreadable managed
 * state refuses nothing here; the managed-sync guard then refuses with the same code.
 */
export async function refuseManagedForbiddenFlags(engine: BrainEngine, flags: { skipFailed: boolean; includeGitignored: boolean }, args: string[]): Promise<void> {
  const flag = managedForbiddenFlag(flags);
  if (!flag || !await readManagedMode(engine).catch(() => false)) return;
  throw managedSyncFlagRefusal(flag, args.find((_, i) => args[i - 1] === '--source') ?? null, args);
}
