/**
 * GBRA-582 item 9d: the state of the member each credential row is bound to, for `gbrain auth list`. A credential bound
 * to a member that is not enabled is refused at verification (access_member_disabled), whatever its own status says.
 */
import type { BrainEngine } from '../engine.ts';

export type TokenMemberStatus = 'enabled' | 'disabled' | 'removed' | 'missing' | null;

/** A lookup from a credential row to its bound member's status: null when unbound, `missing` when no member row exists. */
export async function tokenMemberStatuses(engine: Pick<BrainEngine, 'readAccessMembers'>, rows: ReadonlyArray<Record<string, unknown>>): Promise<(row: Record<string, unknown>) => TokenMemberStatus> {
  const members = rows.some(r => r.member_id) ? await engine.readAccessMembers({ includeRemoved: true }) : [];
  return row => {
    if (!row.member_id) return null;
    const m = members.find(x => x.id === row.member_id);
    return !m ? 'missing' : m.tombstoned_at ? 'removed' : m.disabled_at ? 'disabled' : 'enabled';
  };
}
