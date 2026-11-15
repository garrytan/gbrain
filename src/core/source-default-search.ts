/**
 * GST-2732 B (Garry, 2026-11-15: "Do it"): a source added with no federated choice joins default search only on a
 * single-user brain: access.serves reads one, brain.audience classifies personal, the caller is local and this is not
 * a thin client. Any other answer, a failed read included, leaves the stored default unset (out of default search),
 * and the add says so (`source_not_in_default_search`). Existing sources are never changed here.
 */
import type { BrainEngine } from './engine.ts';
import type { AddSourceOpts } from './sources-ops.ts';

export async function newSourceJoinsDefaultSearch(engine: BrainEngine): Promise<boolean> {
  try {
    const { loadConfig, isThinClient } = await import('./config.ts');
    const cfg = loadConfig();
    if (isThinClient(cfg)) return false;
    const { brainServes } = await import('./access/serves.ts');
    if ((await brainServes(engine)).serves !== 'one') return false;
    const { classifyBrainAudience } = await import('./facts/writeback-audience.ts');
    return (await classifyBrainAudience(engine, cfg)).audience === 'personal';
  } catch {
    return false;
  }
}

/** The add options with federated set to true when the caller made no choice and the brain serves one person. */
export async function withDefaultSearchChoice(engine: BrainEngine, opts: AddSourceOpts): Promise<AddSourceOpts> {
  if (opts.federated != null || opts.github || opts.google || opts.addedByRemoteCaller) return opts;
  return await newSourceJoinsDefaultSearch(engine) ? { ...opts, federated: true } : opts;
}
