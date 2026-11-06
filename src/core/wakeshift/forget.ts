/**
 * Forget on remove (plan D6, review F12; Wakeshift ToS 7.1, 8.2). Removing a
 * member, revoking a token or deleting an OAuth client ends that principal's
 * open watches (state ended, last_error principal_revoked), drops its terms
 * acceptance and queues a Wakeshift Forget User call for each hashed user it
 * watched under. The queue (wake_forgets) is drained by the wake drainer
 * (drain.ts), so the CLI never waits on the network and works with reporting
 * back off. A credential bound to a member watched under the member's user,
 * which outlives that one credential: its watches end, and the member's user
 * is forgotten when the member is removed.
 *
 * Written over the scalar-only SqlQuery so auth.ts and token-mint.ts can call
 * it with the handle they already hold. Best effort: a failure prints one
 * stderr line and never fails the removal.
 */
import type { SqlQuery } from '../sql-query.ts';

export type ForgetTarget = { member: string } | { kind: 'oauth_client' | 'legacy_token'; id: string };

export async function forgetWakePrincipal(sql: SqlQuery, who: ForgetTarget): Promise<{ ended: number; queued: number }> {
  try {
    if ('member' in who) {
      const ended = await sql`UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
        WHERE member_id = ${who.member} AND state = 'open' RETURNING id`;
      const queued = await sql`INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions WHERE member_id = ${who.member}
        ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`;
      await sql`DELETE FROM wake_terms_acceptances WHERE principal_key = ${`member:${who.member}`}`;
      return { ended: ended.length, queued: queued.length };
    }
    const ended = await sql`UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
      WHERE principal_kind = ${who.kind} AND principal_id = ${who.id} AND state = 'open' RETURNING id`;
    const queued = await sql`INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions
      WHERE principal_kind = ${who.kind} AND principal_id = ${who.id} AND member_id IS NULL
      ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`;
    await sql`DELETE FROM wake_terms_acceptances WHERE principal_key = ${`${who.kind}:${who.id}`}`;
    return { ended: ended.length, queued: queued.length };
  } catch (e) {
    console.error(`[wakeshift] could not end the removed principal's watches or queue its forget: ${e instanceof Error ? e.message : String(e)}`);
    return { ended: 0, queued: 0 };
  }
}
