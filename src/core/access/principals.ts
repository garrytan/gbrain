/**
 * GBRA-218: member and group principals for per-member read access.
 *
 * A page names its readers in frontmatter `readable_by` (a string or a list).
 * normalizeReaders() is the row twin of the SQL function gbrain_access_readers()
 * (schema migration v281); test/access-principals.test.ts holds the two equal
 * on a generated corpus, so the predicate and every TypeScript check agree.
 *
 *   absent key            → null (no page-level restriction)
 *   valid string or list  → sorted, distinct ['member:<id>' | 'group:<g>']
 *   anything else         → ['!nobody'] (present but malformed: readable by no remote caller)
 */

export const ACCESS_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const NOBODY = '!nobody';
/** GST-359 C2: where a member's own facts live, `memory/members/<member>` (access/member-facts.ts). */
export const MEMBER_PAGE_PREFIX = 'memory/members/';
const MAX_READERS = 256;

export type Principal = `member:${string}` | `group:${string}`;

/** One readers entry normalized, or null when it is not a valid principal. */
export function normalizePrincipal(raw: string): Principal | null {
  const v = raw.replace(/^ +| +$/g, '').replace(/[A-Z]/g, c => c.toLowerCase());
  if (v.startsWith('group:')) return ACCESS_ID_RE.test(v.slice(6)) ? v as Principal : null;
  const id = v.startsWith('member:') ? v.slice(7) : v;
  return ACCESS_ID_RE.test(id) ? `member:${id}` : null;
}

/** The normalized readers of a frontmatter object (see the module comment). */
export function normalizeReaders(frontmatter: unknown): string[] | null {
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) return null;
  if (!Object.prototype.hasOwnProperty.call(frontmatter, 'readable_by')) return null;
  const value = (frontmatter as Record<string, unknown>).readable_by;
  const list = typeof value === 'string' ? [value]
    : Array.isArray(value) && value.length >= 1 && value.length <= MAX_READERS && value.every(v => typeof v === 'string') ? value as string[]
    : null;
  if (!list) return [NOBODY];
  const out = new Set<string>();
  for (const entry of list) {
    const p = normalizePrincipal(entry);
    if (!p) return [NOBODY];
    out.add(p);
  }
  return [...out].sort();
}

/** True when the frontmatter names readers at all (valid or not). */
export function hasReaders(frontmatter: unknown): boolean {
  return typeof frontmatter === 'object' && frontmatter !== null
    && Object.prototype.hasOwnProperty.call(frontmatter, 'readable_by');
}

/** Whether a caller with `identity` may read a page carrying `frontmatter` at the page layer. */
export function readersAllow(frontmatter: unknown, identity: readonly string[]): boolean {
  const readers = normalizeReaders(frontmatter);
  if (readers === null) return true;
  return readers.some(r => identity.includes(r));
}

/** An identity set is safe to embed as SQL literals: every entry is a normalized principal. */
export function validIdentity(identity: readonly string[]): boolean {
  return identity.every(p => normalizePrincipal(p) === p);
}

/** The identity set of a member: itself plus each of its groups. */
export function identityFor(memberId: string, groups: readonly string[]): string[] {
  return [`member:${memberId}`, ...groups.map(g => `group:${g}`)].sort();
}
