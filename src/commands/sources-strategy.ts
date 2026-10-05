/**
 * `gbrain sources set-strategy <id> <markdown|code|auto>`: persist
 * `sources.config.strategy`, the file strategy every sync of the source uses
 * when its caller passes no --strategy (`sync --all`, `sync --source`,
 * autopilot, the dream cycle and the MCP `sync` op all read it since #4899).
 * Unset, sync falls back to 'markdown', under which a changed code file is
 * deleted rather than re-imported. `sources add --strategy` writes the same
 * key at registration. The write is updateSourceConfig's single-key merge, so
 * every other config key survives. Follows `federate` / `mirror-readonly`.
 */
import type { BrainEngine } from '../core/engine.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import { isSyncStrategy, SYNC_STRATEGIES } from '../core/sync.ts';

export async function runSetStrategy(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, strategy] = args;
  if (!id || id.startsWith('-') || !strategy) {
    console.error(`Usage: gbrain sources set-strategy <id> <${SYNC_STRATEGIES.join('|')}>`);
    process.exit(2);
  }
  if (!isSyncStrategy(strategy)) {
    console.error(`Error: invalid strategy "${strategy}". Valid: ${SYNC_STRATEGIES.join(', ')}.`);
    process.exit(2);
  }
  const [src] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src.config);
  if (typeof config.kind === 'string') {
    console.error(`Source "${id}" is a ${config.kind} connector source; a sync strategy applies to Git-backed sources only.`);
    process.exit(2);
  }
  await engine.updateSourceConfig(id, { strategy });
  console.log(`Source "${id}" now syncs with strategy ${strategy}.`);
  if (config.strategy !== strategy) {
    console.log(`  Files unchanged since the last sync are re-classified only by a full sync: gbrain sync --source ${id} --full`);
  }
}
