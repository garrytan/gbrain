/**
 * `gbrain sources add <id> --kind meetings|slack` on an unmanaged brain (the default keyless install). These kinds use
 * the managed-lifecycle parser, so both paths accept exactly the same flags; a slack source is checked against Slack
 * before it is registered, and --dry-run registers nothing.
 */
import type { BrainEngine } from '../core/engine.ts';
import { addSource, type AddSourceOpts } from '../core/sources-ops.ts';
import { isSourceFederated } from '../core/sources-load.ts';
import { parseSourceLifecycleArgs } from './sources-lifecycle-args.ts';

export async function runApiSourceAdd(engine: BrainEngine, args: string[]): Promise<void> {
  const { params } = parseSourceLifecycleArgs(['add', ...args]);
  const opts = params.options as AddSourceOpts;
  if (params.dry_run === true) {
    console.log(`Dry run: would create ${opts.slack ? 'slack' : 'meetings'} source "${opts.id}"; nothing was registered.`);
    return;
  }
  if (opts.slack) await (await import('../core/slack/source-add.ts')).preflightSlackAdd(opts.id, opts.slack);
  const created = await addSource(engine, opts);
  const config = created.config as Record<string, unknown>;
  const record = opts.slack ? config.s_record : config.m_record;
  console.log(`Created ${opts.slack ? 'slack' : 'meetings'} source "${created.id}" (record: ${String(record)})${created.local_path ? ` → ${created.local_path}` : ''}`);
  console.log(`  federated: ${isSourceFederated(created.config)}`);
  console.log(`  sync: run \`gbrain sync --source ${created.id}\` once; after its first sync, autopilot keeps it synced on its own interval.`);
}
