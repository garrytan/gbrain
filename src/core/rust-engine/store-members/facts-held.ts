/**
 * The held-fact move and facts home reads (src/core/engine-sql/facts-purge.ts held-fact-move.ts section and
 * src/core/engine-sql/facts-cycle.ts), served from the facts store (rust/crates/gbrain-store/src/facts/held_moves.rs).
 * Each member sends the arguments of its BrainEngine member and turns the ISO times the store returns into `Date`s, as
 * PGLite returns them.
 *
 * The store keeps no access rules or pending coverage, so `readHeldAccessState` answers the readable, uncovered state
 * and `heldMoveDue` answers false (held_moves.rs). `readHeldRowVisibility` serves the no-caller page policy of
 * `privatePagesFilterFragment('p')` and refuses a caller that widens it. `listHeldFactRows` serves a `days` text that is
 * a plain number and refuses any other interval text.
 */
import type { BrainEngine } from '../../engine.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

const FENCE_DATES = ['valid_from', 'valid_until'] as const;
const dated = (rows: Row[]) => rows.map(row => withDates(row, FENCE_DATES));

export const heldEntityPageDeleted: Member<'heldEntityPageDeleted'> = (brain, sourceId, slug) =>
  storeCall({ member: 'heldEntityPageDeleted', sourceId }, () => brain.heldEntityPageDeleted({ sourceId, slug }));

export const heldTargetPageLive: Member<'heldTargetPageLive'> = (brain, sourceId, slug) =>
  storeCall({ member: 'heldTargetPageLive', sourceId }, () => brain.heldTargetPageLive({ sourceId, slug }));

/** The entity travels as the page args' `slug`. */
export const readHeldAccessState: Member<'readHeldAccessState'> = (brain, sourceId, entity) =>
  storeCall({ member: 'readHeldAccessState', sourceId }, () => brain.readHeldAccessState({ sourceId, slug: entity }));

export const listHeldMoveRows: Member<'listHeldMoveRows'> = async (brain, sourceId) => {
  const rows: Row[] = await storeCall({ member: 'listHeldMoveRows', sourceId }, () => brain.listHeldMoveRows({ sourceId }));
  return dated(rows) as never;
};

export const listStruckHeldRows: Member<'listStruckHeldRows'> = (brain, sourceId) =>
  storeCall({ member: 'listStruckHeldRows', sourceId }, () => brain.listStruckHeldRows({ sourceId }));

export const readHeldRowVisibility: Member<'readHeldRowVisibility'> = (brain, sourceId, slug) => {
  const policy = storePageTextPolicy('readHeldRowVisibility', () => privatePagesFilterFragment('p'));
  return storeCall({ member: 'readHeldRowVisibility', sourceId }, () => brain.readHeldRowVisibility({ sourceId, slug, policy }));
};

export const heldMoveDue: Member<'heldMoveDue'> = (brain, sourceId) =>
  storeCall({ member: 'heldMoveDue', sourceId }, () => brain.heldMoveDue({ sourceId }));

export const readHeldConfigValue: Member<'readHeldConfigValue'> = (brain, name) =>
  storeCall({ member: 'readHeldConfigValue' }, () => brain.readHeldConfigValue(name));

/** `opts.timeoutMs` ends a read on the server; the store reads a snapshot that cannot stall, so it changes nothing. */
export const readHeldPageLocation: Member<'readHeldPageLocation'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readHeldPageLocation', sourceId }, () => brain.readHeldPageLocation({ sourceId, slug }));

export const readHeldVersionsEdited: Member<'readHeldVersionsEdited'> = (brain, requestId) =>
  storeCall({ member: 'readHeldVersionsEdited' }, () => brain.readHeldVersionsEdited(requestId));

export const scanUnfencedFactRows: Member<'scanUnfencedFactRows'> = async (brain, sourceId) => {
  const rows: Row[] = await storeCall({ member: 'scanUnfencedFactRows', sourceId }, () => brain.scanUnfencedFactRows({ sourceId }));
  return dated(rows) as never;
};

/** A `days` text the SQL appends ` days` to: the store reads a signed decimal number and refuses any other interval text. */
const PLAIN_DAYS = /^[+-]?\d{1,6}(\.\d{1,6})?$/;

export const listHeldFactRows: Member<'listHeldFactRows'> = async (brain, sourceId, days) => {
  if (!PLAIN_DAYS.test(days)) refuseMember('listHeldFactRows', 'a days text that is not a plain number');
  const rows: Row[] = await storeCall({ member: 'listHeldFactRows', sourceId }, () => brain.listHeldFactRows({ sourceId, days }));
  return dated(rows) as never;
};

export const listFencedFactsOfMissingPages: Member<'listFencedFactsOfMissingPages'> = (brain, sourceId) =>
  storeCall({ member: 'listFencedFactsOfMissingPages', sourceId }, () => brain.listFencedFactsOfMissingPages({ sourceId }));
