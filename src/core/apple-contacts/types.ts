/**
 * apple-contacts source kind (`sources.config.kind = 'apple-contacts'`): one owner-only contact page per Apple contact,
 * read from GBrain Helper on the owner's Mac over the network (`GET /v1/contacts/changes`, apple/contacts-client.ts).
 * Pages live only under the source's own contacts directory (default `contacts/apple`), each owned by its contact id
 * (`apple_contact_id`). A contact is tied to an existing person page only by an identity link, matched by exact email or
 * phone (apple-contacts/identity-match.ts); no person page is ever written.
 */

export const APPLE_CONTACTS_KIND = 'apple-contacts';
export const APPLE_CONTACTS_DEFAULT_DIR = 'contacts/apple';
export const APPLE_CONTACTS_DEFAULT_PORT = 8792;
/** B1: a pull every 15 minutes. */
export const APPLE_CONTACTS_DEFAULT_SYNC_INTERVAL_MIN = 15;
/** The frontmatter key that marks a page as owned by one Apple contact. */
export const APPLE_CONTACT_ID_KEY = 'apple_contact_id';
/** A snapshot that would delete more than this share of the contacts the source owns writes nothing. */
export const APPLE_CONTACTS_DELETE_FLOOR = 0.2;

export type AppleContactsRecord = 'git' | 'database';

export interface AppleContactsSourceConfig {
  /** The helper's address as the box reaches it (a host name or an IP literal, no scheme or port). */
  helperHost: string;
  helperPort: number;
  /** `socks5h://host:port`: the helper is reached through this proxy, which resolves the host name. */
  proxy?: string;
  /** Absolute path of the 0600 JSON file `{"accessToken": "..."}` holding the read:contacts token. */
  tokenFile: string;
  /** Pages live under this relative directory (`--contacts-dir`, as the Google source has). */
  contactsDir: string;
  record: AppleContactsRecord;
  /** The Git checkout directory pages are committed to when `record` is git. */
  dir: string | null;
  syncIntervalMin: number;
}

export interface AppleLabeledValue { label: string | null; value: string }

/** One contact as the helper's route returns it, values as stored in Contacts. */
export interface AppleContact {
  id: string;
  givenName: string | null;
  familyName: string | null;
  nickname: string | null;
  organization: string | null;
  jobTitle: string | null;
  emails: AppleLabeledValue[];
  phones: AppleLabeledValue[];
  groups: string[];
}

export type AppleContactChange = { op: 'upsert'; id: string; contact: AppleContact } | { op: 'delete'; id: string };

export interface AppleContactsPage {
  items: AppleContactChange[];
  meta: { nextCursor: string | null; more: boolean; full: boolean };
}

export const appleContactHoldKey = (id: string): string => `contact:${id}`;
