/**
 * Doctor facts, fence and trust reads (src/core/engine-sql/doctor-facts-trust.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_facts_trust.rs, rust/docs/store/cli-reads-doctor-facts-trust.md).
 *
 * Served from the store: the conversation-pipeline page count (the page records) and the persistent writer contention
 * (the `facts:absorb` ingest rows against the completed `facts-absorb` jobs), the stored trust tiers and derived-taint
 * counts of facts, takes and timeline entries, the legacy unknown rows per source, and the non-connector sources a trust
 * claim reads. `listTrustColumns` answers the trust columns the store keeps.
 */
import type { BrainEngine } from '../../engine.ts';
import { isConnectorSourceKind } from '../../persistence/connector-kinds.ts';
import { sourceConfigText } from '../../source-rows.ts';
import { OWNER_TIER_FLOOR } from '../../trust/tier.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const countConversationPipelinePages: Member<'countConversationPipelinePages'> = (brain, types, slugPatterns) =>
  storeCall({ member: 'countConversationPipelinePages' }, async () =>
    Number(await brain.countConversationPipelinePages({ types: [...types], slug_patterns: [...slugPatterns] })));

export const listPersistentWriterContention: Member<'listPersistentWriterContention'> = (brain, reason) =>
  storeCall({ member: 'listPersistentWriterContention' }, () => brain.listPersistentWriterContention(reason));

/** Per stored tier, the rows of facts, takes or timeline entries (the store reads each row's `trust_tier`). */
export const countRowTrustTiers: Member<'countRowTrustTiers'> = (brain, table) =>
  storeCall({ member: 'countRowTrustTiers' }, async () =>
    (await brain.countRowTrustTiers({ table })).map((row: { tier: string | null; n: number | string }) => ({ tier: row.tier, n: Number(row.n) })));

/** Legacy rows still at `unknown` per source; the store reads every table's rows, so no ceiling means every row is legacy. */
export const countLegacyUnknownBySource: Member<'countLegacyUnknownBySource'> = (brain, ceilings, sourceIds) =>
  storeCall({ member: 'countLegacyUnknownBySource' }, async () => {
    const wire = ceilings && {
      pages: ceilings.pages ?? 0, facts: ceilings.facts ?? 0, takes: ceilings.takes ?? 0, timeline_entries: ceilings.timeline_entries ?? 0,
    };
    const rows = await brain.countLegacyUnknownBySource({ ceilings: wire, sourceIds: sourceIds ? [...sourceIds] : null });
    return rows.map((row: { source_id: string; n: number | string }) => ({ source_id: row.source_id, n: Number(row.n) }));
  });

/**
 * The trust columns the store keeps: `trust_tier` and `write_origin` on pages, facts, takes and timeline entries, and
 * `sources.config`. The other columns the backfill probes (`persistence_requests` and the rest) are not reported:
 * the answer only gates the classifier's raw SQL, which the store does not run.
 */
export const listTrustColumns: Member<'listTrustColumns'> = async () => [
  ...['pages', 'facts', 'takes', 'timeline_entries'].flatMap((table_name) => ['trust_tier', 'write_origin'].map((column_name) => ({ table_name, column_name }))),
  { table_name: 'sources', column_name: 'config' },
];

/** The non-connector sources of `mode` (see the statement), from the store's source records. */
export const listTrustClaimTargets: Member<'listTrustClaimTargets'> = async (brain, mode, sourceIds) => {
  const rows = await storeCall({ member: 'listTrustClaimTargets' }, () => brain.listDoctorSources()) as { id: string; config: Record<string, unknown> }[];
  const owned = rows.filter((s) => !isConnectorSourceKind(sourceConfigText(s.config, 'kind') ?? ''));
  const isClaimed = (s: { config: Record<string, unknown> }): boolean => 'trust_claimed_at' in s.config && sourceConfigText(s.config, 'trust_tier') === OWNER_TIER_FLOOR;
  const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (mode === 'owned') return owned.map((s) => ({ id: s.id, claimed: isClaimed(s) }));
  if (mode === 'named') return owned.filter((s) => (sourceIds ?? []).includes(s.id)).sort(byId).map((s) => ({ id: s.id, claimed: isClaimed(s) }));
  return owned.filter(isClaimed).sort(byId).map((s) => ({ id: s.id, claimed: true }));
};

/** Rows of a table whose write origin names a source claim. */
export const countClaimLiftedRows: Member<'countClaimLiftedRows'> = (brain, table) =>
  storeCall({ member: 'countClaimLiftedRows' }, async () => Number(await brain.countClaimLiftedRows({ table })));
