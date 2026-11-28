/**
 * #9888 / #10236: a per-source opt-out from provider-based atom extraction. `sources.config.extract_atoms = false`
 * (`gbrain sources set-extract-atoms <id> off`) keeps every page and transcript of that source away from the chat model:
 * page discovery and the backlog count skip the source (so autopilot's auto-drain, `dream --drain` and doctor never
 * queue it), and the phase itself skips before it reads any input. The pages stay synced, indexed and searchable.
 * Unset or true is today's behavior. A per-page `extract_atoms: false` in frontmatter (connector-atoms.ts) still works
 * inside an included source.
 */
import type { BrainEngine } from '../engine.ts';
import type { Check } from '../../commands/doctor.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';

/** The discovery/backlog predicate over `pages p`: drop pages of a source whose config turns extraction off. */
export const SOURCE_ATOM_OPT_OUT_SQL = `AND NOT EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')`;
/** The inverse, for doctor's count of pages the policy keeps out. */
export const SOURCE_ATOM_OPTED_OUT_SQL = `AND EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')`;

export const extractAtomsOffConfig = (config: unknown): boolean => {
  const parsed = typeof config === 'string' ? JSON.parse(config) as Record<string, unknown> : (config ?? {}) as Record<string, unknown>;
  return String(parsed.extract_atoms) === 'false';
};

/** Why the phase skips `sourceId`, or null when it runs. A lookup that fails skips (fails closed): nothing is sent. */
export async function sourceAtomPolicySkip(engine: Pick<BrainEngine, 'getSource'>, sourceId: string):
  Promise<{ summary: string; details: Record<string, unknown> } | null> {
  try {
    const row = await engine.getSource(sourceId);
    if (!row || !extractAtomsOffConfig(row.config)) return null;
    return { summary: `source ${sourceId} has extract_atoms off (gbrain sources set-extract-atoms ${sourceId} on includes it)`,
      details: { reason: 'source_extract_atoms_off', source_id: sourceId } };
  } catch (err) {
    rethrowCapabilityRefusal(err);
    return { summary: `could not read the extract_atoms setting of source ${sourceId}, so nothing was sent`,
      details: { reason: 'source_policy_lookup_failed', source_id: sourceId, error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Doctor's `extract_atoms_backlog` with the pages a source opt-out keeps out named apart (`policy_excluded`, by source,
 * inside the caller's source grant), so they never warn or get a drain hint. A failed count says so instead of a zero.
 */
export async function withSourcePolicyNote(engine: BrainEngine, check: Check, sourceIds?: string[]): Promise<Check> {
  const { countExtractAtomsBacklog } = await import('./extract-atoms.ts');
  const excluded: Array<{ source_id: string; backlog: number }> = [];
  try {
    const off = (await engine.listAllSources()).filter(source => extractAtomsOffConfig(source.config) && (!sourceIds || sourceIds.includes(source.id)));
    for (const { id } of off.sort((a, b) => a.id.localeCompare(b.id))) {
      const backlog = await countExtractAtomsBacklog(engine, id, { sourcePolicy: 'excluded' });
      if (backlog === null) throw new Error(`could not count source ${id}`);
      if (backlog) excluded.push({ source_id: id, backlog });
    }
  } catch (err) {
    rethrowCapabilityRefusal(err);
    const error = err instanceof Error ? err.message : String(err);
    return { ...check, message: `${check.message}; pages in sources with extract_atoms off could not be counted (${error})`, details: { ...check.details, policy_excluded_error: error } };
  }
  if (!excluded.length) return check;
  const total = excluded.reduce((sum, row) => sum + row.backlog, 0);
  const note = `${total} page(s) in a source with extract_atoms off are not counted (${excluded.map(row => row.source_id).join(', ')}; gbrain sources set-extract-atoms <id> on includes one)`;
  return { ...check, message: `${check.message}; ${note}`, details: { ...check.details, policy_excluded: total, policy_excluded_by_source: excluded } };
}
