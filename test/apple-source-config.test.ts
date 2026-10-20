/**
 * apple-source-config — pure parsing of an apple source's stored config.
 * No engine, no readers, no network. Placeholders only.
 */
import { describe, expect, test } from 'bun:test';

import {
  appleTuningConfig,
  parseAppleServices,
  parseAppleSourceConfig,
  parseContactsDir,
} from '../src/core/apple/source-config.ts';
import { ALL_APPLE_SERVICES, DEFAULT_CONTACTS_DIR } from '../src/core/apple/types.ts';

const DIR = '/tmp/gbrain-test-apple-dir';

describe('parseAppleSourceConfig — defaults', () => {
  test('an empty config yields the documented defaults', () => {
    const cfg = parseAppleSourceConfig({ kind: 'apple' }, DIR);
    expect(cfg).toEqual({
      account: 'local',
      services: ['calendar', 'contacts', 'mail'],
      historyDays: 90,
      futureDays: 60,
      calendarIds: [],
      contactsDir: DEFAULT_CONTACTS_DIR,
      mailMailboxes: ['INBOX', 'Sent'],
      mailDays: 30,
      mailMax: 500,
      mailOwnerAddresses: [],
      loopsExtractConsent: false,
      dir: DIR,
    });
  });

  test('a_dir overrides the fallback dir; an empty a_dir does not', () => {
    expect(parseAppleSourceConfig({ a_dir: '/x/y' }, DIR).dir).toBe('/x/y');
    expect(parseAppleSourceConfig({ a_dir: '' }, DIR).dir).toBe(DIR);
    expect(parseAppleSourceConfig({ a_dir: 5 }, DIR).dir).toBe(DIR);
  });

  test('a_account is a trimmed free label, default "local"', () => {
    expect(parseAppleSourceConfig({ a_account: '  alice-example  ' }, DIR).account).toBe('alice-example');
    expect(parseAppleSourceConfig({ a_account: '   ' }, DIR).account).toBe('local');
    expect(parseAppleSourceConfig({ a_account: 7 }, DIR).account).toBe('local');
  });
});

describe('parseAppleSourceConfig — per-service opt-out', () => {
  test.each([
    ['calendar', ['calendar']],
    ['contacts', ['contacts']],
    ['mail', ['mail']],
    ['calendar,mail', ['calendar', 'mail']],
    ['mail,contacts', ['contacts', 'mail']], // canonical order, not input order
    ['contacts,calendar,mail', ['calendar', 'contacts', 'mail']],
    [' Calendar , MAIL ', ['calendar', 'mail']],
    ['mail,mail', ['mail']],
  ])('a_services=%j → %j', (raw, expected) => {
    expect(parseAppleSourceConfig({ a_services: raw }, DIR).services).toEqual(expected as never);
  });

  test('absent a_services = all three services', () => {
    expect(parseAppleSourceConfig({}, DIR).services).toEqual(ALL_APPLE_SERVICES);
  });

  test('an unknown-only list yields NO services (never silently widens to all)', () => {
    expect(parseAppleSourceConfig({ a_services: 'calender' }, DIR).services).toEqual([]);
    expect(parseAppleSourceConfig({ a_services: '' }, DIR).services).toEqual([]);
    expect(parseAppleServices('gmail,drive')).toEqual([]);
  });

  test('unknown tokens next to a known one are dropped, the known one kept', () => {
    expect(parseAppleSourceConfig({ a_services: 'gmail,mail' }, DIR).services).toEqual(['mail']);
  });

  test('an array value is accepted like a csv', () => {
    expect(parseAppleSourceConfig({ a_services: ['contacts', 'mail'] }, DIR).services).toEqual(['contacts', 'mail']);
  });
});

describe('parseAppleSourceConfig — windows and limits', () => {
  test('a_history_days: floor, cap at 3650, junk → 90', () => {
    expect(parseAppleSourceConfig({ a_history_days: 30.9 }, DIR).historyDays).toBe(30);
    expect(parseAppleSourceConfig({ a_history_days: 99999 }, DIR).historyDays).toBe(3650);
    expect(parseAppleSourceConfig({ a_history_days: '45' }, DIR).historyDays).toBe(45);
    for (const bad of [0, -1, NaN, Infinity, 'abc', null, {}]) {
      expect(parseAppleSourceConfig({ a_history_days: bad }, DIR).historyDays).toBe(90);
    }
  });

  test('a_future_days: 1..3650, out of range or junk → 60', () => {
    expect(parseAppleSourceConfig({ a_future_days: 1 }, DIR).futureDays).toBe(1);
    expect(parseAppleSourceConfig({ a_future_days: 3650 }, DIR).futureDays).toBe(3650);
    expect(parseAppleSourceConfig({ a_future_days: 3651 }, DIR).futureDays).toBe(60);
    for (const bad of [0, -5, 0.5, NaN, 'x', null]) {
      expect(parseAppleSourceConfig({ a_future_days: bad }, DIR).futureDays).toBe(60);
    }
  });

  test('a_mail_days: cap at 365, junk → 30', () => {
    expect(parseAppleSourceConfig({ a_mail_days: 7 }, DIR).mailDays).toBe(7);
    expect(parseAppleSourceConfig({ a_mail_days: 5000 }, DIR).mailDays).toBe(365);
    expect(parseAppleSourceConfig({ a_mail_days: 0 }, DIR).mailDays).toBe(30);
    expect(parseAppleSourceConfig({ a_mail_days: 'soon' }, DIR).mailDays).toBe(30);
  });
});

describe('parseAppleSourceConfig — lists', () => {
  test('a_calendar_ids: csv, trimmed, de-duplicated, empty = all', () => {
    expect(parseAppleSourceConfig({ a_calendar_ids: 'cal-a, cal-b ,cal-a,' }, DIR).calendarIds).toEqual(['cal-a', 'cal-b']);
    expect(parseAppleSourceConfig({ a_calendar_ids: '' }, DIR).calendarIds).toEqual([]);
    expect(parseAppleSourceConfig({}, DIR).calendarIds).toEqual([]);
  });

  test('a_mail_mailboxes: csv keeps case; empty or absent → INBOX,Sent', () => {
    expect(parseAppleSourceConfig({ a_mail_mailboxes: 'INBOX, Archive ,Projects/Acme Example' }, DIR).mailMailboxes)
      .toEqual(['INBOX', 'Archive', 'Projects/Acme Example']);
    expect(parseAppleSourceConfig({ a_mail_mailboxes: ' , ' }, DIR).mailMailboxes).toEqual(['INBOX', 'Sent']);
    expect(parseAppleSourceConfig({}, DIR).mailMailboxes).toEqual(['INBOX', 'Sent']);
  });
});

describe('parseContactsDir', () => {
  test('normalizes slashes and accepts nested lower-case segments', () => {
    expect(parseContactsDir('/people/')).toBe('people');
    expect(parseContactsDir('contacts/apple')).toBe('contacts/apple');
    expect(parseContactsDir(' people ')).toBe('people');
  });

  test.each(['', '../x', 'a/../b', '.hidden', 'Upper', 'a b', 'a//b', '/', null, 5, undefined])('rejects %j', (bad) => {
    expect(parseContactsDir(bad)).toBeNull();
  });

  test('config falls back to people on an unsafe dir', () => {
    expect(parseAppleSourceConfig({ a_contacts_dir: '../etc' }, DIR).contactsDir).toBe('people');
    expect(parseAppleSourceConfig({ a_contacts_dir: '/apple-people/' }, DIR).contactsDir).toBe('apple-people');
  });
});

describe('appleTuningConfig', () => {
  test('writes only non-default keys, and round-trips through the parser', () => {
    expect(appleTuningConfig(parseAppleSourceConfig({}, DIR))).toEqual({});
    const cfg = parseAppleSourceConfig({
      a_account: 'alice-example', a_services: 'calendar,mail', a_history_days: 14, a_future_days: 7,
      a_calendar_ids: 'cal-a,cal-b', a_contacts_dir: 'contacts', a_mail_mailboxes: 'INBOX', a_mail_days: 10,
    }, DIR);
    const tuning = appleTuningConfig(cfg);
    expect(tuning).toEqual({
      a_account: 'alice-example', a_services: 'calendar,mail', a_history_days: 14, a_future_days: 7,
      a_calendar_ids: 'cal-a,cal-b', a_contacts_dir: 'contacts', a_mail_mailboxes: 'INBOX', a_mail_days: 10,
    });
    expect(parseAppleSourceConfig(tuning, DIR)).toEqual(cfg);
  });
});
