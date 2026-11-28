/**
 * Whitelist and export-directory path management for the LinkedIn collector.
 * Stored file-plane under `<configDir>/collectors/` (honors GBRAIN_HOME).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../config.ts';
import { slugifyContactName } from '../whatsapp/whitelist.ts';
import type { LinkedInWhitelistEntry, LinkedInWhitelistFile } from './types.ts';

export function defaultLinkedInWhitelistPath(): string {
  return path.join(configDir(), 'collectors', 'linkedin-whitelist.json');
}

export function defaultLinkedInExportDir(): string {
  return path.join(configDir(), 'collectors', 'linkedin-export');
}

export function normalizeLinkedInKey(url: string, fallbackName: string): string {
  const cleanUrl = (url || '').trim().replace(/\/+$/, '').toLowerCase();
  const match = cleanUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (match?.[1]) return `in:${match[1]}`;
  if (cleanUrl) return cleanUrl;
  return `name:${slugifyContactName(fallbackName)}`;
}

export function loadLinkedInWhitelist(filePath?: string): LinkedInWhitelistFile {
  const target = filePath ?? defaultLinkedInWhitelistPath();
  if (!existsSync(target)) {
    return { schema_version: '1.0', policy: 'explicit_whitelist_only', contacts: [] };
  }
  const raw = JSON.parse(readFileSync(target, 'utf8')) as Partial<LinkedInWhitelistFile>;
  return {
    schema_version: raw.schema_version ?? '1.0',
    policy: 'explicit_whitelist_only',
    contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
  };
}

export function saveLinkedInWhitelist(data: LinkedInWhitelistFile, filePath?: string): void {
  const target = filePath ?? defaultLinkedInWhitelistPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    chmodSync(target, 0o600);
  } catch {
    // Non-POSIX filesystems may ignore chmod.
  }
}

export function addLinkedInWhitelistEntry(opts: {
  key: string;
  name: string;
  url?: string;
  slug?: string;
  category?: string;
  whitelistPath?: string;
}): LinkedInWhitelistEntry {
  const key = opts.key.trim();
  const name = opts.name.trim();
  if (!key || !name) {
    throw new Error('LinkedIn whitelist requires both key and name.');
  }
  const slug = slugifyContactName(opts.slug?.trim() || name);
  const category = (opts.category?.trim() || 'network').toLowerCase();

  const wl = loadLinkedInWhitelist(opts.whitelistPath);
  const remaining = wl.contacts.filter((c) => c.key !== key);
  const entry: LinkedInWhitelistEntry = {
    key,
    name,
    url: (opts.url ?? '').trim(),
    slug,
    category,
    added_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  remaining.push(entry);
  remaining.sort((a, b) => a.name.localeCompare(b.name));
  wl.contacts = remaining;
  saveLinkedInWhitelist(wl, opts.whitelistPath);
  return entry;
}

export function removeLinkedInWhitelistEntry(opts: {
  key: string;
  whitelistPath?: string;
}): { removed: number; key: string } {
  const key = opts.key.trim();
  const wl = loadLinkedInWhitelist(opts.whitelistPath);
  const before = wl.contacts.length;
  wl.contacts = wl.contacts.filter((c) => c.key !== key);
  saveLinkedInWhitelist(wl, opts.whitelistPath);
  return { removed: before - wl.contacts.length, key };
}
