/**
 * `gbrain pages purges list` and `gbrain pages unpurge <slug>` (#5575 CEO-8,
 * DX-11): the owner's view of page purge tombstones. Both run the owner-only
 * operations as the trusted local CLI.
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { PURGE_FAMILY_HELP } from './forget-purge.ts';

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].startsWith(`${name}=`) ? args[i].slice(name.length + 1) : args[i + 1];
}

export async function runPagePurges(engine: BrainEngine, sub: 'purges' | 'unpurge', args: string[]): Promise<void> {
  const json = args.includes('--json');
  const { operations } = await import('../core/operations.ts');
  const explicitSource = flagValue(args, '--source');
  const sourceId = await resolveSourceId(engine, explicitSource ?? null);
  const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false as const, dryRun: false, sourceId,
    logger: { info: console.log, warn: console.warn, error: console.error } };
  if (sub === 'purges') {
    if (args[0] !== 'list') { process.stdout.write(`Usage: gbrain pages purges list [--source <id>] [--json]\n\n${PURGE_FAMILY_HELP}`); return; }
    const result = await operations.find(o => o.name === 'list_page_purges')!.handler(ctx, explicitSource ? { source_id: sourceId } : {}) as
      { purges: Array<{ source_id: string; slug: string; content_hash8: string; request_id: string | null; purged_at: string }>; next: string };
    if (json) { console.log(JSON.stringify(result, null, 2)); return; }
    for (const p of result.purges) console.log(`${p.source_id}/${p.slug}  hash ${p.content_hash8}  purged ${p.purged_at}${p.request_id ? `  request ${p.request_id}` : ''}`);
    console.log(result.next);
    return;
  }
  const slug = args.find(a => !a.startsWith('--') && a !== explicitSource);
  if (!slug) { process.stdout.write(`Usage: gbrain pages unpurge <slug> [--source <id>] [--json]\n\n${PURGE_FAMILY_HELP}`); return; }
  const result = await operations.find(o => o.name === 'unpurge_page')!.handler(ctx, { slug, source_id: sourceId }) as Record<string, unknown>;
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Cleared ${result.cleared} page tombstone(s) for ${slug}. ${result.next}`);
}
