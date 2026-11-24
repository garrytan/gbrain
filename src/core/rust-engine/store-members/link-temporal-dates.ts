/**
 * The temporal date check the link and graph members share. It lives outside links.ts and graph.ts because every export
 * of a family file becomes a member of STORE_MEMBERS (index.ts), and this helper is not a BrainEngine member.
 */
import { isCalendarDate, type EdgeTemporalOpts } from '../../link-validity.ts';

/** `dateLiteral` of link-validity.ts: the dates `relationshipFilterSql` would inline, checked in the order it renders them. */
export function checkTemporalDates(policy: EdgeTemporalOpts | undefined): void {
  if (!policy) return;
  const status = policy.status ?? 'live';
  if (policy.disabled || (status === 'all' && !policy.during)) return;
  for (const date of [policy.asOf, policy.during?.from, policy.during?.until]) {
    if (date !== undefined && !isCalendarDate(date)) throw new TypeError(`temporal edge filter: invalid date ${JSON.stringify(date)}`);
  }
}
