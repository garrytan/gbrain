/**
 * The connect gate's persistence reads (engine-sql/connect-gate.ts), answered in TypeScript from what the store keeps.
 * The store keeps one brain row with its stored mode (readManagedModeRows), so every persistence table reads as present.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { PersistenceTable } from '../../engine-sql/connect-gate.ts';
import type { StoreMember } from './common.ts';
import type { GraduationGateRow } from '../../engine-sql/connect-gate.ts';
import type { RetiredDeactivationRow } from '../../engine-sql/connect-gate.ts';
import { storeCall } from './common.ts';

/** The store has every persistence table a gate probes; each answers its empty state. */
export const hasPersistenceTable: StoreMember<[table: PersistenceTable], boolean> = async () => true;

/** The outcome of every committed `writer_deactivate` topology change (gbrain-store `persistence::topology`). */
export const listRetiredDeactivations: StoreMember<[], RetiredDeactivationRow[]> = (brain) =>
  storeCall({ member: 'listRetiredDeactivations' }, () => brain.writerReleaseRows({ kind: 'retired_deactivations' }));

/** No graduation targets or leaves this engine, so there is no custody row. */
export const readGraduationGateRow: StoreMember<[opts?: { withRunSetting?: boolean }], GraduationGateRow | null> = async () => null;
