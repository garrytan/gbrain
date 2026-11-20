/**
 * The facts-home scan's reads (src/core/engine-sql/collate-facts-home-reads.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/home_reads.rs). Each member sends the arguments of its BrainEngine member and turns
 * the ISO times the store returns into `Date`s, as PGLite returns them.
 *
 * `listHeldFactRows` serves a `days` text that is a plain number and refuses any other interval text.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

const FENCE_DATES = ['valid_from', 'valid_until'] as const;
const dated = (rows: Row[]) => rows.map(row => withDates(row, FENCE_DATES));

export const scanUnfencedFactRows: Member<'scanUnfencedFactRows'> = async (brain, sourceId) => {
  const rows: Row[] = await storeCall({ member: 'scanUnfencedFactRows', sourceId }, () => brain.scanUnfencedFactRows(sourceId));
  return dated(rows) as never;
};

/** A `days` text the SQL appends ` days` to: the store reads a signed decimal number and refuses any other interval text. */
const PLAIN_DAYS = /^[+-]?\d{1,6}(\.\d{1,6})?$/;

export const listHeldFactRows: Member<'listHeldFactRows'> = async (brain, sourceId, days) => {
  if (!PLAIN_DAYS.test(days)) refuseMember('listHeldFactRows', 'a days text that is not a plain number');
  const rows: Row[] = await storeCall({ member: 'listHeldFactRows', sourceId }, () => brain.listHeldFactRows(sourceId, days));
  return dated(rows) as never;
};

export const listFencedFactsOfMissingPages: Member<'listFencedFactsOfMissingPages'> = (brain, sourceId) =>
  storeCall({ member: 'listFencedFactsOfMissingPages', sourceId }, () => brain.listFencedFactsOfMissingPages(sourceId));

export const readPageFileOrigin: Member<'readPageFileOrigin'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readPageFileOrigin', sourceId }, () => brain.readPageFileOrigin(sourceId, slug));
