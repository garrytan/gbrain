import { Database } from 'bun:sqlite';
import type { ContactRecord, SqliteDatabaseLike } from './types.ts';

export class IPhoneContactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IPhoneContactsError';
  }
}

interface TableInfoRow {
  name: string;
}

interface PersonRow {
  record_id: number;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
}

interface MultiValueRow {
  record_id: number;
  property: number | string | null;
  label: string | null;
  value: string | null;
}

export function openContactsDb(path: string): SqliteDatabaseLike {
  return new Database(path, { readonly: true }) as unknown as SqliteDatabaseLike;
}

export function readContacts(db: SqliteDatabaseLike): ContactRecord[] {
  if (!tableExists(db, 'ABPerson')) {
    throw new IPhoneContactsError('AddressBook.sqlitedb is missing ABPerson table');
  }

  const personColumns = columnsFor(db, 'ABPerson');
  const firstExpr = columnExpr(personColumns, ['First', 'first'], 'first_name');
  const lastExpr = columnExpr(personColumns, ['Last', 'last'], 'last_name');
  const orgExpr = columnExpr(personColumns, ['Organization', 'organization', 'Company'], 'organization');

  const people = db.query<PersonRow>(
    `SELECT ROWID AS record_id, ${firstExpr}, ${lastExpr}, ${orgExpr}
       FROM ABPerson
      ORDER BY ROWID`,
  ).all();

  const byId = new Map<number, ContactRecord>();
  for (const row of people) {
    byId.set(Number(row.record_id), {
      recordId: Number(row.record_id),
      firstName: clean(row.first_name),
      lastName: clean(row.last_name),
      organization: clean(row.organization),
      phones: [],
      emails: [],
    });
  }

  if (tableExists(db, 'ABMultiValue')) {
    const multiColumns = columnsFor(db, 'ABMultiValue');
    const recordExpr = firstExisting(multiColumns, ['record_id', 'recordID', 'person_id']);
    const valueExpr = firstExisting(multiColumns, ['value', 'Value']);
    if (recordExpr && valueExpr) {
      const propertyExpr = columnExpr(multiColumns, ['property', 'Property'], 'property');
      const labelExpr = columnExpr(multiColumns, ['label', 'Label'], 'label');
      const rows = db.query<MultiValueRow>(
        `SELECT ${recordExpr} AS record_id, ${propertyExpr}, ${labelExpr}, ${valueExpr} AS value
           FROM ABMultiValue
          ORDER BY ${recordExpr}`,
      ).all();
      for (const row of rows) {
        const contact = byId.get(Number(row.record_id));
        const value = clean(row.value);
        if (!contact || !value) continue;
        const kind = classifyMultiValue(row.property, row.label, value);
        if (kind === 'phone') {
          const normalized = normalizePhone(value);
          if (normalized && !contact.phones.includes(normalized)) contact.phones.push(normalized);
        } else if (kind === 'email') {
          const email = value.trim().toLowerCase();
          if (email && !contact.emails.includes(email)) contact.emails.push(email);
        }
      }
    }
  }

  return Array.from(byId.values()).filter((contact) =>
    displayNameForContact(contact) || contact.phones.length > 0 || contact.emails.length > 0
  );
}

export function displayNameForContact(contact: ContactRecord): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  return name || contact.organization?.trim() || contact.emails[0] || contact.phones[0] || '';
}

export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (hasPlus) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits;
}

function classifyMultiValue(
  property: number | string | null,
  label: string | null,
  value: string,
): 'phone' | 'email' | 'other' {
  const prop = typeof property === 'number' ? property : Number(property);
  const labelNorm = (label ?? '').toLowerCase();
  if (value.includes('@') || prop === 4 || labelNorm.includes('email')) return 'email';
  if (prop === 3 || labelNorm.includes('phone') || /^[+()\-\d\s.]+$/.test(value)) return 'phone';
  return 'other';
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function tableExists(db: SqliteDatabaseLike, table: string): boolean {
  const row = db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
  ).get(table);
  return !!row;
}

function columnsFor(db: SqliteDatabaseLike, table: string): Set<string> {
  const rows = db.query<TableInfoRow>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

function firstExisting(columns: Set<string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (columns.has(candidate)) return `"${candidate.replace(/"/g, '""')}"`;
  }
  return null;
}

function columnExpr(columns: Set<string>, candidates: string[], alias: string): string {
  const found = firstExisting(columns, candidates);
  return found ? `${found} AS ${alias}` : `NULL AS ${alias}`;
}
