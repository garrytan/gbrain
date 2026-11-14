import type { BrainEngine } from '../engine.ts';

/** A source may be retained for search without being admitted to paid atom extraction. */
export const ATOM_EXCLUDED_SOURCES_KEY = 'cycle.extract_atoms.exclude_sources';

export async function atomExcludedSources(engine: Pick<BrainEngine, 'getConfig'>): Promise<string[]> {
  const value = await engine.getConfig(ATOM_EXCLUDED_SOURCES_KEY);
  if (value == null) return [];
  let list: unknown;
  try { list = JSON.parse(value); }
  catch { throw new Error(`${ATOM_EXCLUDED_SOURCES_KEY} must be a JSON array of source IDs`); }
  if (!Array.isArray(list) || !list.every(id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(id))) {
    throw new Error(`${ATOM_EXCLUDED_SOURCES_KEY} must be a JSON array of source IDs`);
  }
  return [...new Set(list as string[])];
}

/** Archived atom runs stay visible while active extraction is evaluated separately. */
export async function atomHealthScope(engine: BrainEngine) {
  const excludedAtomSources = await atomExcludedSources(engine);
  const excludedHistory = excludedAtomSources.length ? await engine.executeRaw<{
    source_id: string; halts: number; cost_usd: number;
  }>(`SELECT source_id, SUM(halt_count)::int AS halts, SUM(cost_usd)::float8 AS cost_usd
       FROM extract_rollup_7d WHERE kind='atoms' AND day >= CURRENT_DATE - 7
         AND source_id=ANY($1::text[])
       GROUP BY source_id ORDER BY source_id`, [excludedAtomSources]) : [];
  const policyDetails = excludedAtomSources.length ? {
    excluded_atom_sources: excludedAtomSources, excluded_atom_history_7d: excludedHistory,
  } : {};
  const policyNote = excludedHistory.length
    ? `; retained atom audit history for ${excludedHistory.length} source(s) outside the active extraction policy`
    : '';
  return { excludedAtomSources, policyDetails, policyNote };
}
