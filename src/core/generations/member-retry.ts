import { getWriteRequest } from '../persistence/journal.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { memberRequestId } from './managed.ts';

/** Follow retained failed attempts, stopping at the one whose outcome the caller must observe.
 * The journal's internal id, not its public request_id, binds each existing retry link.
 * Never walk past a live or committed attempt: two resumptions must share that attempt.
 */
export async function latestMemberRequest(engine: Parameters<typeof getWriteRequest>[0], principal: Parameters<typeof getWriteRequest>[1],
  member: { activation_id: string; slug: string; action: string }): Promise<WriteRequest | null> {
  const id = (action: string) => memberRequestId(member.activation_id, member.slug, action);
  let row = await getWriteRequest(engine, principal, id(member.action));
  for (;;) {
    if (row && !['conflict', 'failed', 'cancelled'].includes(row.state)) return row;
    const next = await getWriteRequest(engine, principal, id(`${member.action}:after:${row?.id ?? 'missing'}`));
    if (!next) return row;
    row = next;
  }
}
