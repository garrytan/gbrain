/**
 * `gbrain sources set-pull-strategy <id> <rebase|merge>` (#5429): persist
 * `sources.config.pull_strategy`, how every divergence-safe pull of the source
 * (`sources pull <id>`, `sources push <id>`, `sources harden <id>`) reconciles
 * local commits with origin. Unset means `rebase`, the behaviour every brain
 * had. `merge` is for a brain whose intermediate snapshot commits conflict
 * under rebase replay while the two tips merge cleanly: a fast-forward when
 * possible, else a merge commit, and a real conflict is aborted with
 * `merge --abort`. The brain's own config plane is the single switch: a
 * repository or global `pull.rebase` setting never changes the contract.
 * `--path` callers have no source row and keep `rebase`. Follows
 * `set-strategy`: one writer, `updateSourceConfig`'s single-key merge.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isPullStrategy, PULL_STRATEGIES, pullStrategyOf } from '../core/git-remote.ts';
import { parseSourceConfig } from '../core/sources-load.ts';

export async function runSetPullStrategy(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, strategy] = args;
  if (!id || id.startsWith('-') || !strategy) {
    console.error(`Usage: gbrain sources set-pull-strategy <id> <${PULL_STRATEGIES.join('|')}>`);
    process.exit(2);
  }
  if (!isPullStrategy(strategy)) {
    console.error(`Error: invalid pull strategy "${strategy}". Valid: ${PULL_STRATEGIES.join(', ')}.`);
    process.exit(2);
  }
  const [src] = await engine.executeRaw<{ config: unknown; local_path: string | null }>('SELECT config, local_path FROM sources WHERE id=$1', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src.config);
  if (typeof config.kind === 'string') {
    console.error(`Source "${id}" is a ${config.kind} connector source; a pull strategy applies to Git-backed sources only.`);
    process.exit(2);
  }
  const previous = pullStrategyOf(config);
  await engine.updateSourceConfig(id, { pull_strategy: strategy });
  console.log(`Source "${id}" now pulls with strategy ${strategy}${previous === strategy ? ' (unchanged)' : ` (was ${previous})`}.`);
  if (strategy === 'merge') console.log(`  Divergence now ends in a merge commit when the two tips merge cleanly; a conflict is aborted (merge --abort) and reported as conflict_aborted.`);
}
