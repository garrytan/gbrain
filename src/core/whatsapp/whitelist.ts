/**
 * Whitelist persistence for the WhatsApp collector.
 * Stored file-plane under `<configDir>/collectors/whatsapp-whitelist.json` (0600).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../config.ts';
import type { WhatsAppWhitelistEntry, WhatsAppWhitelistFile } from './types.ts';

export function slugifyContactName(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'contact';
}

export function defaultWhatsAppWhitelistPath(): string {
  return path.join(configDir(), 'collectors', 'whatsapp-whitelist.json');
}

export function loadWhatsAppWhitelist(filePath?: string): WhatsAppWhitelistFile {
  const target = filePath ?? defaultWhatsAppWhitelistPath();
  if (!existsSync(target)) {
    return { schema_version: '1.0', policy: 'explicit_whitelist_only', contacts: [] };
  }
  const raw = JSON.parse(readFileSync(target, 'utf8')) as Partial<WhatsAppWhitelistFile>;
  return {
    schema_version: raw.schema_version ?? '1.0',
    policy: 'explicit_whitelist_only',
    contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
  };
}

export function saveWhatsAppWhitelist(data: WhatsAppWhitelistFile, filePath?: string): void {
  const target = filePath ?? defaultWhatsAppWhitelistPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    chmodSync(target, 0o600);
  } catch {
    // Non-POSIX filesystems may ignore chmod.
  }
}

export function addWhatsAppWhitelistEntry(opts: {
  jid: string;
  name: string;
  slug?: string;
  category?: string;
  whitelistPath?: string;
}): WhatsAppWhitelistEntry {
  const jid = opts.jid.trim();
  const name = opts.name.trim();
  if (!jid || !name) {
    throw new Error('WhatsApp whitelist requires both jid and name.');
  }
  const slug = slugifyContactName(opts.slug?.trim() || name);
  const category = (opts.category?.trim() || 'network').toLowerCase();

  const wl = loadWhatsAppWhitelist(opts.whitelistPath);
  const remaining = wl.contacts.filter((c) => c.jid !== jid);
  const entry: WhatsAppWhitelistEntry = {
    jid,
    name,
    slug,
    category,
    added_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  remaining.push(entry);
  remaining.sort((a, b) => a.name.localeCompare(b.name));
  wl.contacts = remaining;
  saveWhatsAppWhitelist(wl, opts.whitelistPath);
  return entry;
}

export function removeWhatsAppWhitelistEntry(opts: {
  jid: string;
  whitelistPath?: string;
}): { removed: number; jid: string } {
  const jid = opts.jid.trim();
  const wl = loadWhatsAppWhitelist(opts.whitelistPath);
  const before = wl.contacts.length;
  wl.contacts = wl.contacts.filter((c) => c.jid !== jid);
  saveWhatsAppWhitelist(wl, opts.whitelistPath);
  return { removed: before - wl.contacts.length, jid };
}

export function importWhatsAppWhitelistFile(opts: {
  fromPath: string;
  whitelistPath?: string;
}): { imported: number; total: number } {
  const incoming = loadWhatsAppWhitelist(opts.fromPath);
  const current = loadWhatsAppWhitelist(opts.whitelistPath);
  const byJid = new Map<string, WhatsAppWhitelistEntry>();
  for (const c of current.contacts) byJid.set(c.jid, c);
  let imported = 0;
  for (const c of incoming.contacts) {
    if (!c.jid || !c.name) continue;
    if (!byJid.has(c.jid)) imported += 1;
    byJid.set(c.jid, {
      jid: c.jid.trim(),
      name: c.name.trim(),
      slug: slugifyContactName(c.slug || c.name),
      category: (c.category || 'network').toLowerCase(),
      added_at: c.added_at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  }
  current.contacts = [...byJid.values()].sort((a, b) => a.name.localeCompare(b.name));
  saveWhatsAppWhitelist(current, opts.whitelistPath);
  return { imported, total: current.contacts.length };
}
