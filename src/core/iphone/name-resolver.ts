import type { ContactRecord } from './types.ts';
import { displayNameForContact, normalizePhone } from './contacts.ts';

export interface NameResolver {
  selfName: string;
  resolveHandle(handle: string | null | undefined): string;
  contactForHandle(handle: string | null | undefined): ContactRecord | null;
}

export function buildNameResolver(
  contacts: readonly ContactRecord[],
  opts: { selfName?: string } = {},
): NameResolver {
  const byHandle = new Map<string, ContactRecord>();
  for (const contact of contacts) {
    for (const phone of contact.phones) {
      const key = normalizeHandle(phone);
      if (key) byHandle.set(key, contact);
    }
    for (const email of contact.emails) {
      const key = normalizeHandle(email);
      if (key) byHandle.set(key, contact);
    }
  }

  const selfName = (opts.selfName ?? 'Me').trim() || 'Me';
  return {
    selfName,
    resolveHandle(handle) {
      const contact = handle ? byHandle.get(normalizeHandle(handle)) : undefined;
      return contact ? displayNameForContact(contact) : (handle ?? 'Unknown');
    },
    contactForHandle(handle) {
      if (!handle) return null;
      return byHandle.get(normalizeHandle(handle)) ?? null;
    },
  };
}

export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  return normalizePhone(trimmed);
}
