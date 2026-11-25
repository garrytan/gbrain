/**
 * Identity links for a Google Contacts source (GST-3609): each contact page joins the identity group of the one person
 * page with exactly the same email or phone, by the rule the Apple Contacts source uses (apple-contacts/identity-match.ts):
 * never by name; two or more matching people, or one whose page name clearly disagrees with the contact's name (another
 * person on a shared or reused address), leave the contact unlinked and wait for the owner as an identity review, which
 * gbrain sync status lists; a pair the owner recorded as different people (gbrain dedupe reject) stays unlinked;
 * a link another writer made is left as it is. Only entity_identities rows change; no page is edited.
 *
 * A contact page the sweep removes loses this source's link first.
 *
 * Off until the owner turns it on: `gbrain dedupe link-contacts --source <id>` counts what would happen and writes
 * nothing, `--apply` links every contact page of the source and sets google_contacts.identity_links on, so each sync
 * then settles the contacts it changed and the waiting reviews, and `--unlink` removes every link the source made and
 * sets it off.
 */
import type { BrainEngine } from '../engine.ts';
import type { IdentityMemberRef } from '../engine-sql/identity-decisions.ts';
import { decidedSets } from '../entities/identity-decisions.ts';
import { parsePhoneCountryCode, PHONE_COUNTRY_CODE_CONFIG_KEY } from '../phone-key.ts';
import { linkContactPage, readIdentityReviews, unlinkContact, writeIdentityReviews, type IdentityReview } from '../apple-contacts/identity-match.ts';
import { listEntityIdentities } from '../entity-identity.ts';

export const GOOGLE_CONTACTS_LINK_ORIGIN = 'google-contacts';
export const IDENTITY_LINKS_CONFIG_KEY = 'google_contacts.identity_links';

export interface ContactLinkCounts {
  contacts: number;
  /** Linked by this run (or, in a dry run, would be). */
  linked: number;
  already_linked: number;
  /** Two or more people match: unlinked, waiting for the owner. */
  waiting: number;
  /** One person matches but its page names someone else: unlinked, waiting for the owner. */
  name_disagrees: number;
  no_match: number;
  /** The one matching person was recorded as a different person. */
  rejected: number;
  /** In an identity group another writer made: left alone. */
  other_writer: number;
  /** Links this source made earlier that no longer hold (or, in a dry run, would be removed). */
  unlinked: number;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === 'string' && s.trim() !== '');
const refKey = (m: IdentityMemberRef) => `${m.source_id}\t${m.slug}`;
const PAGE = 500;

export async function identityLinksOn(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return String(await engine.getConfig(IDENTITY_LINKS_CONFIG_KEY) ?? '').trim().toLowerCase() === 'on';
}

/** The source's live contact pages (type person, carrying google_contact_id): every one, or those among `slugs`. */
async function contactPages(engine: BrainEngine, sourceId: string, slugs: string[] | null) {
  const out: Array<{ id: string; slug: string; title: string | null; emails: string[]; phones: string[] }> = [];
  const keys = ['google_contact_id', 'emails', 'phones'];
  const members = slugs?.map(slug => ({ source_id: sourceId, slug }));
  for (let after: { source_id: string; slug: string } | undefined; ;) {
    const rows = await engine.listEntityKeyRows({ types: ['person'], keys, limit: PAGE, ...(after ? { after } : {}), ...(members ? { members } : {}) });
    for (const row of rows) {
      if (row.source_id !== sourceId || typeof row.keys.google_contact_id !== 'string') continue;
      out.push({ id: row.keys.google_contact_id, slug: row.slug, title: row.title, emails: list(row.keys.emails), phones: list(row.keys.phones) });
    }
    if (rows.length < PAGE) return out;
    after = { source_id: rows.at(-1)!.source_id, slug: rows.at(-1)!.slug };
  }
}

/**
 * Settle the identity links of a Google Contacts source's contact pages: every one, or the pages named (a sync's changed
 * contacts) plus those with a waiting review.
 */
export async function linkGoogleContacts(engine: BrainEngine, sourceId: string, opts: { apply: boolean; slugs?: Iterable<string> }): Promise<ContactLinkCounts> {
  const countryCode = parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY));
  const apart = decidedSets(await engine.listIdentityDecisions()).apart;
  const reviews = new Map((await readIdentityReviews(engine, sourceId)).map(r => [r.contact_id, r]));
  const subset = opts.slugs ? [...new Set([...opts.slugs, ...[...reviews.values()].map(r => r.slug)])] : null;
  const counts: ContactLinkCounts = { contacts: 0, linked: 0, already_linked: 0, waiting: 0, name_disagrees: 0, no_match: 0, rejected: 0, other_writer: 0, unlinked: 0 };
  if (subset && !subset.length) return counts;
  const pages = await contactPages(engine, sourceId, subset);
  const live = new Set(pages.map(p => p.id));
  for (const row of pages) {
    counts.contacts++;
    const link = await linkContactPage(engine, sourceId, row.slug, row.emails, row.phones, countryCode,
      { origin: GOOGLE_CONTACTS_LINK_ORIGIN, apart, dryRun: !opts.apply, ...(row.title ? { contactName: row.title } : {}) });
    if (link.unlinked) counts.unlinked++;
    if (link.otherWriter) counts.other_writer++;
    else if (link.outcome === 'one') counts[link.linked ? 'linked' : 'already_linked']++;
    else if (link.outcome === 'different') counts.rejected++;
    else if (link.outcome === 'none') counts.no_match++;
    if (link.outcome === 'name_disagrees' && !link.otherWriter) {
      counts.name_disagrees++;
      reviews.set(row.id, { contact_id: row.id, slug: row.slug, candidates: link.candidates!, reason: 'name_disagrees' });
    } else if (link.outcome === 'many' && !link.otherWriter) {
      const review: IdentityReview = { contact_id: row.id, slug: row.slug, candidates: link.candidates! };
      const keys = review.candidates.map(refKey);
      if (apart.some(set => { const s = new Set(set.map(refKey)); return keys.every(k => s.has(k)); })) review.decided = 'different';
      else counts.waiting++;
      reviews.set(row.id, review);
    } else reviews.delete(row.id);
  }
  for (const [id, review] of [...reviews]) if ((!subset || subset.includes(review.slug)) && !live.has(id)) reviews.delete(id);
  if (opts.apply) await writeIdentityReviews(engine, sourceId, [...reviews.values()]);
  return counts;
}

/** Remove this source's link of one contact page (before the page is removed). */
export async function unlinkGoogleContactPage(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const ours = (await listEntityIdentities(engine, { slug, slugSourceId: sourceId }))
    .find(m => m.slug === slug && m.source_id === sourceId && m.established_by === GOOGLE_CONTACTS_LINK_ORIGIN);
  if (ours) await unlinkContact(engine, ours.entity_id, slug, sourceId, GOOGLE_CONTACTS_LINK_ORIGIN);
}

/** Remove every link this source made, and its waiting reviews. Returns how many contact pages were unlinked. */
export async function unlinkGoogleContacts(engine: BrainEngine, sourceId: string): Promise<number> {
  const ours = (await listEntityIdentities(engine, { sourceId })).filter(m => m.established_by === GOOGLE_CONTACTS_LINK_ORIGIN && !m.canonical);
  for (const m of ours) await unlinkContact(engine, m.entity_id, m.slug, sourceId, GOOGLE_CONTACTS_LINK_ORIGIN);
  await writeIdentityReviews(engine, sourceId, []);
  return ours.length;
}
