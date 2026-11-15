/**
 * GST-2732 B (Garry, 2026-11-15: "Do it"): a source added with no federated choice joins default search only on a
 * single-user brain: access.serves reads one, brain.audience classifies personal from a declaration or a successful usage read, and the caller is local (a thin
 * client's add runs on its host as a remote caller). Any other answer, a failed read included, leaves the stored default unset (out of default search),
 * and the add says so (`source_not_in_default_search`). Existing sources are never changed here.
 */
import type { BrainEngine } from './engine.ts';
import type { AddSourceOpts } from './sources-ops.ts';

export async function newSourceJoinsDefaultSearch(engine: BrainEngine): Promise<boolean> {
  try {
    const { brainServes } = await import('./access/serves.ts');
    if ((await brainServes(engine)).serves !== 'one') return false;
    const { classifyBrainAudience } = await import('./facts/writeback-audience.ts');
    const audience = await classifyBrainAudience(engine);
    return audience.audience === 'personal' && !audience.unproven;
  } catch {
    return false;
  }
}

/** The choice an earlier attempt with this request id was accepted with, so an identical retry replays it instead of re-reading the row it wrote. */
async function acceptedChoice(engine: BrainEngine, opts: AddSourceOpts): Promise<AddSourceOpts | null> {
  if (!opts.requestId) return null;
  const [prior] = await engine.executeRaw<{ digest: string }>('SELECT digest FROM persistence_topology_changes WHERE request_id = $1::uuid AND source_id = $2', [opts.requestId, opts.id]);
  if (!prior) return null;
  const { managedSourceAddInput } = await import('./persistence/managed-sources.ts');
  const { topologyIntent } = await import('./persistence/source-lifecycle.ts');
  const { digest } = await import('./persistence/digest.ts');
  return [{ ...opts, federated: true }, opts].find(candidate => digest(topologyIntent(managedSourceAddInput(candidate))) === prior.digest) ?? null;
}

/** Folder and Git sources only: connectors keep their own defaults (GitHub and Google federated, meetings and Slack chats out). */
export async function withDefaultSearchChoice(engine: BrainEngine, opts: AddSourceOpts): Promise<AddSourceOpts> {
  if (opts.federated != null || opts.github || opts.google || opts.meetings || opts.slack || opts.addedByRemoteCaller) return opts;
  const accepted = await acceptedChoice(engine, opts);
  if (accepted) return accepted;
  const joins = await newSourceJoinsDefaultSearch(engine);
  if (opts.localPath && (await engine.executeRaw('SELECT 1 FROM sources WHERE id = $1 AND local_path IS NULL', [opts.id])).length > 0) return opts;
  return joins ? { ...opts, federated: true } : opts;
}
