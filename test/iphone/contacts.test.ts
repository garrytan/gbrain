import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  CONTACTS_DOMAIN,
  CONTACTS_RELATIVE_PATH,
  IPhoneBackupManifest,
} from '../../src/core/iphone/manifest.ts';
import { displayNameForContact, normalizePhone, openContactsDb, readContacts } from '../../src/core/iphone/contacts.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'iphone-backup', 'backup');

function contactsPath(): string {
  const manifest = new IPhoneBackupManifest(FIXTURE);
  const ref = manifest.resolveFile(CONTACTS_DOMAIN, CONTACTS_RELATIVE_PATH);
  manifest.close();
  if (!ref) throw new Error('fixture contacts DB missing');
  return ref.path;
}

describe('iPhone contacts reader', () => {
  test('reads contacts and multivalue phones/emails from AddressBook.sqlitedb', () => {
    const db = openContactsDb(contactsPath());
    const contacts = readContacts(db);
    db.close?.();

    expect(contacts).toHaveLength(2);
    const alice = contacts.find((c) => displayNameForContact(c) === 'Alice Example')!;
    expect(alice.organization).toBe('acme-example');
    expect(alice.phones).toEqual(['+15550000001']);
    expect(alice.emails).toEqual(['alice@acme-example.com']);
  });

  test('normalizes US-like phone handles for contact matching', () => {
    expect(normalizePhone('(555) 000-0001')).toBe('+15550000001');
    expect(normalizePhone('+1 555 000 0001')).toBe('+15550000001');
  });
});
