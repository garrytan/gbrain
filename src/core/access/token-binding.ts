/**
 * GBRA-218 verify join: the live member a credential is bound to (null when
 * unbound) and its stored may_act_for list. A binding to a disabled, removed
 * or missing member, or one that cannot be read, refuses the credential
 * (InvalidTokenError carrying access_member_disabled).
 * GST-363: the verifiers also carry whether the credential reads unscoped on
 * purpose and when it was created (credentialScopeFields), so the
 * requester-scope gate adds no query.
 */
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { SqlQuery } from '../sql-query.ts';
import { MemberBindingRefused, storedMayActFor, verifiedMember } from './members.ts';

export async function tokenMemberBinding(sql: SqlQuery, row: { member_id?: unknown; may_act_for?: unknown; reads_unscoped?: unknown }, created: unknown):
  Promise<{ member: { id: string; groups: string[] } | null; mayActFor: string[] | null; readsUnscoped: boolean; createdAt: number | null }> {
  try {
    return { member: await verifiedMember(sql, row.member_id), mayActFor: storedMayActFor(row.may_act_for), ...credentialScopeFields(row.reads_unscoped, created) };
  } catch (e) {
    throw new InvalidTokenError(e instanceof MemberBindingRefused ? e.message : 'access_member_disabled: the member binding of this credential could not be verified.');
  }
}

/** A stored creation time as epoch seconds: a Date or timestamp string (created_at), or seconds (client_id_issued_at); null when absent or unreadable. */
export function epochSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'bigint') return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? Math.floor(value.getTime() / 1000) : null;
  if (typeof value !== 'string') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** GST-363: the AuthInfo fields the requester-scope gate reads, from a credential row's reads_unscoped and creation time. */
export function credentialScopeFields(readsUnscoped: unknown, created: unknown): { readsUnscoped: boolean; createdAt: number | null } {
  return { readsUnscoped: readsUnscoped != null, createdAt: epochSeconds(created) };
}
