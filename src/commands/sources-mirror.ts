/**
 * `gbrain sources mirror-readonly <id>` / `gbrain sources mirror-writable <id>`
 * (#5409): set `sources.config.mirror_read_only`, the per-source read-only
 * mirror flag (default false). While it is true, managed publication never
 * writes a file into the source's checkout: sync imports canonical metadata
 * database-only and page writes are stored database-only, so a mirror kept
 * current by `git pull --ff-only` never gains local modifications.
 * Follows `federate` / `unfederate`.
 */
import type { BrainEngine } from '../core/engine.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../core/sources-load.ts';

export async function runMirrorMode(engine: BrainEngine, args: string[], readOnly: boolean): Promise<void> {
  const id = args[0];
  if (!id || id.startsWith('-')) {
    console.error(`Usage: gbrain sources ${readOnly ? 'mirror-readonly' : 'mirror-writable'} <id>`);
    process.exit(2);
  }
  const [src] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src.config);
  if (readOnly) config.mirror_read_only = true;
  else delete config.mirror_read_only;
  await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify(normalizeSourceConfig(config)), id]);
  console.log(readOnly
    ? `Source "${id}" is now a read-only mirror: managed sync and page writes never write files into its checkout; canonical metadata stays in the database.`
    : `Source "${id}" is writable again: managed sync and page writes publish canonical files into its checkout.`);
}
