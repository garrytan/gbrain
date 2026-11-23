/**
 * Group 5 facts members that read the stamped trust columns, served from the facts store
 * (rust/crates/gbrain-store/src/facts/trust_reads.rs): `listSingleFactMetadata` (src/core/engine-sql/facts-purge.ts),
 * `listUnpreviewedTrustFacts` (src/core/engine-sql/facts-doctor.ts) and `listRestatedPrivateCopies`
 * (src/core/engine-sql/facts-trust.ts).
 *
 * `listSingleFactMetadata` serves the remote provenance floor (`remoteProvenanceFloorSql`) through `storeFloorPolicy`, as
 * `findActiveSingleFact` does (a caller whose labelled-only grant or owner read changes the floor refuses), and refuses an
 * id that PGLite cannot bind as `int[]` (a fraction or a width past int4). Its SQL has no `ORDER BY`; the
 * store answers in id order. `listUnpreviewedTrustFacts` refuses a limit that is not a non-negative integer rather
 * than guess at PGLite's `LIMIT` error.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storeFloorPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export const listSingleFactMetadata: Member<'listSingleFactMetadata'> = (brain, opts) => {
  if (opts.ids.some((id) => !Number.isInteger(id) || id < INT4_MIN || id > INT4_MAX)) {
    refuseMember('listSingleFactMetadata', 'an id that is not an int4');
  }
  const remoteFloor = opts.remoteFloor ? storeFloorPolicy('listSingleFactMetadata') : undefined;
  return storeCall({ member: 'listSingleFactMetadata' },
    () => brain.listSingleFactMetadata({ sourceId: opts.sourceId, ids: opts.ids, remoteFloor }));
};

export const listUnpreviewedTrustFacts: Member<'listUnpreviewedTrustFacts'> = (brain, limit) => {
  if (!Number.isInteger(limit) || limit < 0) refuseMember('listUnpreviewedTrustFacts', 'a limit that is not a non-negative integer');
  return storeCall({ member: 'listUnpreviewedTrustFacts' }, () => brain.listUnpreviewedTrustFacts({ limit }));
};

export const listRestatedPrivateCopies: Member<'listRestatedPrivateCopies'> = (brain, opts) =>
  storeCall({ member: 'listRestatedPrivateCopies', sourceId: opts.sourceId },
    () => brain.listRestatedPrivateCopies({ sourceId: opts.sourceId, claim: opts.claim, entity: opts.entity, writer: opts.writer }));
