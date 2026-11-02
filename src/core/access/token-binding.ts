/**
 * GBRA-218 verify join: the live member a credential is bound to (null when
 * unbound) and its stored may_act_for list. A binding to a disabled, removed
 * or missing member, or one that cannot be read, refuses the credential
 * (InvalidTokenError carrying access_member_disabled).
 */
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { SqlQuery } from '../sql-query.ts';
import { MemberBindingRefused, storedMayActFor, verifiedMember } from './members.ts';

export async function tokenMemberBinding(sql: SqlQuery, memberId: unknown, mayActFor: unknown): Promise<{ member: { id: string; groups: string[] } | null; mayActFor: string[] | null }> {
  try {
    return { member: await verifiedMember(sql, memberId), mayActFor: storedMayActFor(mayActFor) };
  } catch (e) {
    throw new InvalidTokenError(e instanceof MemberBindingRefused ? e.message : 'access_member_disabled: the member binding of this credential could not be verified.');
  }
}
