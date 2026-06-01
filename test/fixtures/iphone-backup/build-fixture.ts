import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';

const ROOT = dirname(new URL(import.meta.url).pathname);
const BACKUP = join(ROOT, 'backup');

function fileId(domain: string, relativePath: string): string {
  return createHash('sha1').update(`${domain}-${relativePath}`).digest('hex');
}

function storePath(id: string): string {
  return join(BACKUP, id.slice(0, 2), id);
}

function appleNs(iso: string): number {
  const appleEpoch = Date.UTC(2001, 0, 1);
  return (Date.parse(iso) - appleEpoch) * 1_000_000;
}

function reset(): void {
  if (existsSync(BACKUP)) rmSync(BACKUP, { recursive: true, force: true });
  mkdirSync(BACKUP, { recursive: true });
}

function createManifest(entries: Array<{ domain: string; relativePath: string; id: string }>): void {
  const db = new Database(join(BACKUP, 'Manifest.db'), { create: true });
  db.exec(`CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)`);
  const insert = db.query(`INSERT INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, 1, NULL)`);
  for (const entry of entries) insert.run(entry.id, entry.domain, entry.relativePath);
  db.close();
}

function createContacts(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE ABPerson (
      First TEXT,
      Last TEXT,
      Organization TEXT
    );
    CREATE TABLE ABMultiValue (
      record_id INTEGER,
      property INTEGER,
      label TEXT,
      value TEXT
    );
  `);
  db.query(`INSERT INTO ABPerson (First, Last, Organization) VALUES (?, ?, ?)`).run('Alice', 'Example', 'acme-example');
  db.query(`INSERT INTO ABPerson (First, Last, Organization) VALUES (?, ?, ?)`).run('Bob', 'Example', 'widget-co');
  const mv = db.query(`INSERT INTO ABMultiValue (record_id, property, label, value) VALUES (?, ?, ?, ?)`);
  mv.run(1, 3, '_$!<Mobile>!$_', '+15550000001');
  mv.run(1, 4, '_$!<Work>!$_', 'alice@acme-example.com');
  mv.run(2, 3, '_$!<Mobile>!$_', '+15550000002');
  mv.run(2, 4, '_$!<Work>!$_', 'bob@widget-co.example');
  db.close();
}

function createSms(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT
    );
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      chat_identifier TEXT,
      display_name TEXT,
      service_name TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      handle_id INTEGER,
      date INTEGER,
      is_from_me INTEGER,
      service TEXT
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER,
      message_id INTEGER
    );
  `);
  db.query(`INSERT INTO handle (ROWID, id) VALUES (?, ?)`).run(1, '+15550000001');
  db.query(`INSERT INTO handle (ROWID, id) VALUES (?, ?)`).run(2, '+15550000002');
  db.query(`INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name) VALUES (?, ?, ?, ?, ?)`)
    .run(7, 'iMessage;+15550000001', '+15550000001', null, 'iMessage');
  db.query(`INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name) VALUES (?, ?, ?, ?, ?)`)
    .run(8, 'iMessage;+15550000002', '+15550000002', null, 'iMessage');

  const msg = db.query(`INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, service) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const join = db.query(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)`);
  msg.run(100, 'm-100', 'did acme-example wire the invoice?', 1, appleNs('2024-03-15T09:00:00Z'), 1, 'iMessage');
  join.run(7, 100);
  msg.run(101, 'm-101', 'yes, this AM', 1, appleNs('2024-03-15T09:02:00Z'), 0, 'iMessage');
  join.run(7, 101);
  msg.run(102, 'm-102', 'great, thanks alice-example', 1, appleNs('2024-03-15T09:03:00Z'), 1, 'iMessage');
  join.run(7, 102);
  msg.run(200, 'm-200', 'widget-co board deck ready?', 2, appleNs('2024-04-02T18:30:00Z'), 1, 'iMessage');
  join.run(8, 200);
  msg.run(201, 'm-201', 'ready for tomorrow', 2, appleNs('2024-04-02T18:32:00Z'), 0, 'iMessage');
  join.run(8, 201);
  msg.run(202, 'm-202', 'will send after dinner', 2, appleNs('2024-04-02T18:33:00Z'), 0, 'iMessage');
  join.run(8, 202);
  db.close();
}

reset();
const smsRel = 'Library/SMS/sms.db';
const contactsRel = 'Library/AddressBook/AddressBook.sqlitedb';
const smsId = fileId('HomeDomain', smsRel);
const contactsId = fileId('HomeDomain', contactsRel);
createSms(storePath(smsId));
createContacts(storePath(contactsId));
createManifest([
  { domain: 'HomeDomain', relativePath: smsRel, id: smsId },
  { domain: 'HomeDomain', relativePath: contactsRel, id: contactsId },
]);
console.log(`wrote ${BACKUP}`);
