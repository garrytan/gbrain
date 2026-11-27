/**
 * `ownerOnlyMarkTriggers` (engine-sql/owner-only-marks.ts on the SQL engines): the state of the delete triggers behind
 * `owner_only_marks` (migration v322), and with `ensure` their repair.
 *
 * The store has no SQL triggers: every delete path marks in code (owner_only_marks.rs), so no trigger is ever missing
 * and `ensure` has nothing to create. It has no row-level security either, so its marking walk always reads every row.
 * It therefore never writes the closed marks (`*` `unguarded`, `*` `row_security`) SQL writes for a trigger gap or a
 * role whose reads row-level security limits. Its marks need no held flag (a comment on the SQL table that a data copy
 * drops), so `unflagged` is false, and it has no database logins, so `deniedLogins` is empty; the store reports its
 * closed logins (none). `role` is the role PGLite reports, which only a missing trigger's fix line prints. Why:
 * rust/docs/store/keyword.md.
 */
import type { OwnerOnlyTriggerState } from '../../access/owner-only-marks.ts';
import { storeCall, type StoreMember } from './common.ts';

export const ownerOnlyMarkTriggers: StoreMember<[opts?: { ensure?: boolean; installing?: boolean }], OwnerOnlyTriggerState> =
  async brain => {
    const state = await storeCall({ member: 'ownerOnlyMarkTriggers' }, () => brain.ownerOnlyMarkState()) as
      { closed: boolean; rowSecurity: boolean; held: boolean; closedLogins: OwnerOnlyTriggerState['closedLogins'] };
    return { missing: [], role: 'postgres', closed: state.closed, rowSecurity: state.rowSecurity, held: state.held,
      unflagged: false, deniedLogins: [], closedLogins: state.closedLogins };
  };
