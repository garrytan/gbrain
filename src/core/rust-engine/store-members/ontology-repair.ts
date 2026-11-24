/**
 * Group 5 facts members, the ontology re-key and repair statements (src/core/engine-sql/ontology-repair.ts), served from
 * the facts store (rust/crates/gbrain-store/src/facts/ontology_repair.rs). A member not exported here refuses with
 * `engine_capability_missing`.
 *
 * A re-key move is one of the closed shapes the SQL module lists. The store reads each by name, so the member maps the
 * text it was sent to its place in those lists and refuses any other text, as the SQL does. A parameter is text or null;
 * a number binds as its text (the `$2::bigint` shape). Every write goes through the store's fact writer, so the trust
 * stamp and the unique indexes apply; `restoreOntologyFact` also applies the withdrawal guard.
 *
 * An id list binds as `bigint[]`, so an id that is not an integer refuses rather than guess at its cast error.
 * `listOntologyFactCandidates` is served by doctor-derived.ts.
 */
import type { BrainEngine } from '../../engine.ts';
import { REKEY_ENTITY_SHAPES, REKEY_SMS_SHAPES, REKEY_WHERE_SHAPES, type RekeyMove } from '../../engine-sql/ontology-repair.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const WHERE_NAMES = ['entity_unfenced', 'unbacked_id', 'entity_off_page', 'entity', 'page', 'page_live'] as const;
const ENTITY_NAMES = ['param3', 'own', 'param2'] as const;
const SMS_NAMES = ['own', 'param3', 'param2'] as const;

function wholeIds(member: string, ...lists: readonly (readonly number[])[]): void {
  for (const ids of lists) for (const id of ids) if (!Number.isSafeInteger(id)) refuseMember(member, 'a fact id that is not an integer');
}

/** The name of `text` among the closed shapes; any other text throws what the SQL module throws. */
function shapeName<N extends string>(text: string, shapes: readonly string[], names: readonly N[]): N {
  const at = shapes.indexOf(text);
  if (at < 0) throw new Error(`rekey move is not one of the supported shapes: ${text}`);
  return names[at]!;
}

function paramText(member: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return refuseMember(member, 'a re-key parameter that is not text, a number or null');
}

/** `listRekeyLosers`: every row of the source that loses its ontology key to another once `move` applies, by id. */
export const listRekeyLosers: Member<'listRekeyLosers'> = (brain, sourceId, move: RekeyMove) => {
  const args = {
    sourceId,
    where: shapeName(move.where, REKEY_WHERE_SHAPES, WHERE_NAMES),
    entity: shapeName(move.entity, REKEY_ENTITY_SHAPES, ENTITY_NAMES),
    sms: shapeName(move.sms, REKEY_SMS_SHAPES, SMS_NAMES),
    params: [paramText('listRekeyLosers', move.params[0]), paramText('listRekeyLosers', move.params[1])],
  };
  return storeCall({ member: 'listRekeyLosers' }, () => brain.listRekeyLosers(args));
};

/** `repointSupersededToKept`: supersession links to `ids[i]` follow `keeps[i]`; lists of different lengths refuse. */
export const repointSupersededToKept: Member<'repointSupersededToKept'> = async (brain, ids, keeps) => {
  wholeIds('repointSupersededToKept', ids, keeps);
  await storeCall({ member: 'repointSupersededToKept' }, () => brain.repointSupersededToKept({ ids, keeps }));
};

/** `clearOntologySlots`: each named conversation fact keeps its row and gives up its ontology slot. */
export const clearOntologySlots: Member<'clearOntologySlots'> = async (brain, ids) => {
  wholeIds('clearOntologySlots', ids);
  await storeCall({ member: 'clearOntologySlots' }, () => brain.clearOntologySlots({ ids }));
};

/** `deleteRekeyLosers`: deletes the named facts that hold an ontology slot. */
export const deleteRekeyLosers: Member<'deleteRekeyLosers'> = async (brain, ids) => {
  wholeIds('deleteRekeyLosers', ids);
  await storeCall({ member: 'deleteRekeyLosers' }, () => brain.deleteRekeyLosers({ ids }));
};

/** `restoreOntologyFact`: restores one row only while it is as the preview saw it; `expired` is true when a withdrawal expired it again. */
export const restoreOntologyFact: Member<'restoreOntologyFact'> = (brain, f) => {
  if (!Number.isSafeInteger(f.id)) refuseMember('restoreOntologyFact', 'a fact id that is not an integer');
  if (f.row_num !== null && !Number.isSafeInteger(f.row_num)) refuseMember('restoreOntologyFact', 'a row number that is not an integer');
  return storeCall({ member: 'restoreOntologyFact' }, () =>
    brain.restoreOntologyFact({ id: f.id, sourceId: f.source_id, rowNum: f.row_num, page: f.page, expiredAt: f.expired_at }));
};
