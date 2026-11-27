/**
 * An Apple contact as a contact page, through the Google contacts renderer (google/google-render.ts renderPersonPage)
 * so both sources write one page shape: `type: person`, the name as title, emails and phones (each value once, labels
 * beside them in the body), organization as `company`, job title as `role`, groups as `tags` (A1), and the
 * ownership key `apple_contact_id`. Every page is `visibility: private`, so it stays in the database even on a
 * Git-recorded source. Nothing else from the contact is read or written.
 */
import { createHash } from 'node:crypto';
import { dedupeContactRows } from '../contact-rows.ts';
import { contactIdSlug, personSlugFromContact, renderPersonPage, type PersonPageOptions } from '../google/google-render.ts';
import type { ContactData } from '../google/types.ts';
import { APPLE_CONTACT_ID_KEY, type AppleContact, type AppleLabeledValue } from './types.ts';

/** Contacts' stored labels (`_$!<Mobile>!$_`) as people say them ("mobile"); a custom label as written, lower-cased. */
export function appleLabel(raw: string | null): string | null {
  if (!raw) return null;
  const label = raw.replace(/^_\$!<(.*)>!\$_$/, '$1').trim().toLowerCase();
  return label || null;
}

export function appleDisplayName(c: Pick<AppleContact, 'givenName' | 'familyName' | 'nickname'>): string | null {
  return [c.givenName, c.familyName].filter(Boolean).join(' ').trim() || c.nickname || null;
}

/**
 * Each value once (contact-rows.ts collapses rows that repeat a value), keeping the first row's spelling and label; a
 * value Contacts stores twice under two labels keeps both labels.
 */
function uniqueValues(type: 'email' | 'phone', values: AppleLabeledValue[]): { values: string[]; labels: Map<string, string> } {
  const rows = values.map(v => ({ type, value: v.value, ...(appleLabel(v.label) ? { label: appleLabel(v.label) } : {}) }));
  const kept = (dedupeContactRows(rows)?.rows ?? rows) as Array<{ value: string; label?: string }>;
  const labels = new Map<string, string>();
  for (const row of kept) if (row.label) labels.set(row.value, labels.has(row.value) ? `${labels.get(row.value)}, ${row.label}` : row.label);
  return { values: [...new Set(kept.map(row => row.value))], labels };
}

export interface AppleContactRender {
  data: ContactData;
  options: PersonPageOptions;
}

export function appleContactRender(c: AppleContact): AppleContactRender {
  const emails = uniqueValues('email', c.emails);
  const phones = uniqueValues('phone', c.phones);
  return {
    data: {
      resourceName: c.id, displayName: appleDisplayName(c), emails: emails.values, phones: phones.values,
      organization: c.organization, title: c.jobTitle, groups: c.groups.map(name => ({ id: name, name })), deleted: false,
    },
    options: {
      idKey: APPLE_CONTACT_ID_KEY, sourceLabel: 'Apple Contacts', groupsKey: 'tags', private: true,
      names: { given: c.givenName, family: c.familyName, nickname: c.nickname },
      valueLabels: new Map([...emails.labels, ...phones.labels]),
    },
  };
}

export const appleBaseSlug = (r: AppleContactRender, dir: string) => personSlugFromContact(r.data, false, dir);
export const appleTombstoneSlugs = (id: string, dir: string) => [contactIdSlug(id, dir)];
export const renderAppleContactPage = (r: AppleContactRender, disambiguate: boolean, dir: string) => renderPersonPage(r.data, disambiguate, dir, r.options);

/** What a page renders from: two arrivals of the same contact with this fingerprint write the same page. */
export function appleContactFingerprint(c: AppleContact): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);
}
