/**
 * How gbrain sync status shows an apple-contacts identity review (apple-contacts/identity-match.ts): one contact page
 * whose email or phone matches two or more person pages. It is never linked by guess; the owner decides with
 * gbrain dedupe confirm (the candidates are one person: the next sync links the contact) or gbrain dedupe reject (they
 * are different people: the review stays, decided, and the contact stays unlinked). Dependency-light: sync status
 * reads it on every call.
 */
import type { Action } from '../agent-output.ts';

export const APPLE_CONTACTS_REVIEW_OP = 'apple-contacts-identity-review';

export interface IdentityReviewStatus {
  contact_slug: string;
  candidates: Array<{ source_id: string; slug: string }>;
  decided: 'different' | null;
  needs_human: boolean;
  human_reason: string;
  fix: Action;
}

export function identityReviewStatus(sourceId: string, raw: unknown): IdentityReviewStatus[] {
  let value = raw;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const r = entry as { slug?: unknown; candidates?: unknown; decided?: unknown } | null;
    if (!r || typeof r.slug !== 'string' || !Array.isArray(r.candidates)) return [];
    const candidates = (r.candidates as Array<{ source_id?: unknown; slug?: unknown }>)
      .filter(c => typeof c?.source_id === 'string' && typeof c?.slug === 'string') as Array<{ source_id: string; slug: string }>;
    const decided = r.decided === 'different' ? 'different' as const : null;
    const names = candidates.map(c => `${c.slug} (${c.source_id})`).join(', ');
    return [{ contact_slug: r.slug, candidates, decided, needs_human: decided === null,
      human_reason: decided ? `Contact ${r.slug} matches ${names}, which the owner recorded as different people; it stays unlinked.`
        : `Contact ${r.slug} has an email or phone that matches ${candidates.length} person pages (${names}); it is not linked to any of them until the owner says whether they are one person.`,
      fix: { argv: ['gbrain', 'dedupe', '--preview', '--source', candidates[0]?.source_id ?? sourceId], consent: [], actor: 'user', requires_exclusive: false,
        why: `Lists the duplicate groups with their evidence: gbrain dedupe confirm <group-id> if ${names} are one person (the next sync of ${sourceId} links the contact), gbrain dedupe reject <group-id> if they are not.` } }];
  });
}
