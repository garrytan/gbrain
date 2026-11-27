/**
 * Trust decisions: the pending `trust_proposals` read (BrainEngine pendingTrustProposalsFor), over
 * `rust/crates/gbrain-store/src/trust/proposals.rs`. The store returns rows with the `SELECT *` column names and ISO
 * times; `normalizeTrustProposal` turns them into the rows the SQL engines return (rust/docs/store/trust.md, "Trust
 * proposals").
 */
import type { BrainEngine } from '../../engine.ts';
import { normalizeTrustProposal } from '../../engine-sql/trust-proposals.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const rows = (value: unknown) => (value as Array<Record<string, unknown>>).map(normalizeTrustProposal);

export const pendingTrustProposalsFor: Member<'pendingTrustProposalsFor'> = async (brain, table, id) =>
  rows(await storeCall({ member: 'pendingTrustProposalsFor' }, () => brain.pendingTrustProposalsFor(table, id)));
