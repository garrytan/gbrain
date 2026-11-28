/**
 * Pure-TypeScript RFC-4180 CSV parser and LinkedIn Data Export loader.
 *
 * Supports:
 * - Official LinkedIn ZIP archive or unpacked directory (`Connections.csv`, `messages.csv`, `Shares.csv`, `Profile.csv`).
 * - Automatic 3-line preamble skipping on `Connections.csv`.
 * - Multi-line quoted fields and escaped quotes (`""`).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { slugifyContactName } from '../whatsapp/whitelist.ts';
import type {
  LinkedInCandidate,
  LinkedInConnection,
  LinkedInMessage,
  LinkedInShare,
} from './types.ts';
import {
  defaultLinkedInExportDir,
  loadLinkedInWhitelist,
  normalizeLinkedInKey,
} from './whitelist.ts';

const ALLOWED_EXPORT_FILES = new Set([
  'connections.csv',
  'messages.csv',
  'shares.csv',
  'profile.csv',
]);

/** Full RFC-4180 CSV parser supporting quoted newlines and `""` escapes. */
export function parseCsvRows(rawText: string): string[][] {
  const text = rawText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function findExportFile(exportDir: string, targetLower: string): string | null {
  if (!existsSync(exportDir)) return null;
  const entries = readdirSync(exportDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === targetLower) {
      return path.join(exportDir, e.name);
    }
  }
  return null;
}

export function unpackLinkedInExport(opts: {
  inputPath: string;
  exportDir?: string;
}): { export_dir: string; saved_files: string[] } {
  const inputPath = path.resolve(opts.inputPath);
  if (!existsSync(inputPath)) {
    throw new Error(`LinkedIn export path not found: ${inputPath}`);
  }
  const exportDir = path.resolve(opts.exportDir ?? defaultLinkedInExportDir());
  mkdirSync(exportDir, { recursive: true });
  const saved: string[] = [];

  const st = statSync(inputPath);
  if (st.isDirectory()) {
    for (const entry of readdirSync(inputPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!ALLOWED_EXPORT_FILES.has(entry.name.toLowerCase())) continue;
      copyFileSync(path.join(inputPath, entry.name), path.join(exportDir, entry.name));
      saved.push(entry.name);
    }
  } else if (inputPath.toLowerCase().endsWith('.zip')) {
    const listProc = Bun.spawnSync(['unzip', '-Z1', inputPath], { stdout: 'pipe', stderr: 'pipe' });
    if (listProc.exitCode !== 0) {
      throw new Error(`Failed to inspect ZIP archive: ${listProc.stderr.toString().trim()}`);
    }
    const members = listProc.stdout
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((m) => m && ALLOWED_EXPORT_FILES.has(path.basename(m).toLowerCase()));
    if (members.length === 0) {
      throw new Error('No Connections.csv, messages.csv, Shares.csv, or Profile.csv found inside ZIP.');
    }
    const extractProc = Bun.spawnSync(['unzip', '-o', '-j', inputPath, ...members, '-d', exportDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (extractProc.exitCode !== 0) {
      throw new Error(`Failed to extract ZIP archive: ${extractProc.stderr.toString().trim()}`);
    }
    for (const m of members) saved.push(path.basename(m));
  } else if (inputPath.toLowerCase().endsWith('.csv')) {
    const base = path.basename(inputPath);
    copyFileSync(inputPath, path.join(exportDir, base));
    saved.push(base);
  } else {
    throw new Error('Provide a LinkedIn .zip archive, directory, or .csv file.');
  }

  return { export_dir: exportDir, saved_files: saved };
}

export function detectOwnerIdentity(exportDir: string): { name: string; url: string } {
  const profilePath = findExportFile(exportDir, 'profile.csv');
  if (profilePath) {
    const rows = parseCsvRows(readFileSync(profilePath, 'utf8'));
    if (rows.length >= 2) {
      const header = rows[0]!.map((h) => h.trim().toLowerCase());
      const r = rows[1]!;
      const first = r[header.indexOf('first name')] ?? '';
      const last = r[header.indexOf('last name')] ?? '';
      const full = `${first} ${last}`.trim();
      if (full) return { name: full, url: '' };
    }
  }
  return { name: '', url: '' };
}

export function parseLinkedInConnections(exportDir: string): LinkedInConnection[] {
  const filePath = findExportFile(exportDir, 'connections.csv');
  if (!filePath) return [];
  const rows = parseCsvRows(readFileSync(filePath, 'utf8'));

  // Skip LinkedIn's 3-line Notes preamble by finding the real header row.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const lower = rows[i]!.map((c) => c.trim().toLowerCase());
    if (lower.includes('first name') && lower.includes('last name')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = rows[headerIdx]!.map((c) => c.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iFirst = idx('first name');
  const iLast = idx('last name');
  const iUrl = idx('url');
  const iEmail = idx('email address');
  const iCompany = idx('company');
  const iPos = idx('position');
  const iConn = idx('connected on');

  const out: LinkedInConnection[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const first = (r[iFirst] ?? '').trim();
    const last = (r[iLast] ?? '').trim();
    const name = `${first} ${last}`.trim();
    const url = (iUrl >= 0 ? r[iUrl] : '')?.trim() ?? '';
    if (!name && !url) continue;
    out.push({
      key: normalizeLinkedInKey(url, name),
      name: name || url,
      url,
      email: (iEmail >= 0 ? r[iEmail] : '')?.trim() ?? '',
      company: (iCompany >= 0 ? r[iCompany] : '')?.trim() ?? '',
      position: (iPos >= 0 ? r[iPos] : '')?.trim() ?? '',
      connected_on: (iConn >= 0 ? r[iConn] : '')?.trim() ?? '',
    });
  }
  return out;
}

export function parseLinkedInMessages(exportDir: string): {
  ownerName: string;
  ownerUrl: string;
  byContact: Map<string, LinkedInMessage[]>;
} {
  const filePath = findExportFile(exportDir, 'messages.csv');
  const byContact = new Map<string, LinkedInMessage[]>();
  const owner = detectOwnerIdentity(exportDir);
  if (!filePath) return { ownerName: owner.name, ownerUrl: owner.url, byContact };

  const rows = parseCsvRows(readFileSync(filePath, 'utf8'));
  if (rows.length < 2) return { ownerName: owner.name, ownerUrl: owner.url, byContact };

  const header = rows[0]!.map((c) => c.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const iConv = col('CONVERSATION ID');
  const iFrom = col('FROM');
  const iFromUrl = col('SENDER PROFILE URL');
  const iTo = col('TO');
  const iToUrl = col('RECIPIENT PROFILE URLS');
  const iDate = col('DATE');
  const iSubj = col('SUBJECT');
  const iContent = col('CONTENT');

  // Infer owner URL/name from most frequent participant if Profile.csv absent.
  const freq = new Map<string, { name: string; url: string; count: number }>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const pairs: Array<[string, string]> = [
      [(r[iFrom] ?? '').trim(), (r[iFromUrl] ?? '').trim()],
      [(r[iTo] ?? '').trim(), (r[iToUrl] ?? '').trim().split(',')[0]?.trim() ?? ''],
    ];
    for (const [nm, ur] of pairs) {
      if (!nm && !ur) continue;
      const k = normalizeLinkedInKey(ur, nm);
      const cur = freq.get(k);
      if (cur) cur.count += 1;
      else freq.set(k, { name: nm, url: ur, count: 1 });
    }
  }
  let ownerName = owner.name;
  let ownerUrl = owner.url;
  let ownerKey = ownerName ? normalizeLinkedInKey(ownerUrl, ownerName) : '';
  if (freq.size > 0) {
    const top = [...freq.entries()].sort((a, b) => b[1].count - a[1].count)[0]!;
    if (!ownerName || top[1].name.toLowerCase() === ownerName.toLowerCase()) {
      ownerKey = top[0];
      ownerName = top[1].name || ownerName;
      ownerUrl = top[1].url || ownerUrl;
    } else if (!ownerUrl) {
      for (const [k, v] of freq.entries()) {
        if (v.name.toLowerCase() === ownerName.toLowerCase()) {
          ownerKey = k;
          ownerUrl = v.url;
          break;
        }
      }
    }
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const content = (iContent >= 0 ? r[iContent] : '')?.trim() ?? '';
    if (!content) continue;
    const from = (iFrom >= 0 ? r[iFrom] : '')?.trim() ?? '';
    const fromUrl = (iFromUrl >= 0 ? r[iFromUrl] : '')?.trim() ?? '';
    const to = (iTo >= 0 ? r[iTo] : '')?.trim() ?? '';
    const toUrl = ((iToUrl >= 0 ? r[iToUrl] : '')?.trim() ?? '').split(',')[0]?.trim() ?? '';
    const date = (iDate >= 0 ? r[iDate] : '')?.trim() ?? '';
    const fromKey = normalizeLinkedInKey(fromUrl, from);
    const toKey = normalizeLinkedInKey(toUrl, to);
    const fromOwner =
      (ownerKey !== '' && fromKey === ownerKey) ||
      (ownerName !== '' && from.toLowerCase() === ownerName.toLowerCase());

    const otherKey = fromOwner ? toKey : fromKey;
    const otherName = (fromOwner ? to : from) || otherKey;
    const otherUrl = fromOwner ? toUrl : fromUrl;
    if (!otherKey || otherName.toLowerCase() === 'linkedin member') continue;

    const msg: LinkedInMessage = {
      conversation_id: (iConv >= 0 ? r[iConv] : '')?.trim() ?? '',
      date,
      from,
      from_url: fromUrl,
      to,
      to_url: toUrl,
      subject: (iSubj >= 0 ? r[iSubj] : '')?.trim() ?? '',
      content,
      other_key: otherKey,
      other_name: otherName,
      other_url: otherUrl,
      from_owner: fromOwner,
    };

    const list = byContact.get(otherKey);
    if (list) list.push(msg);
    else byContact.set(otherKey, [msg]);
  }

  for (const list of byContact.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  return { ownerName, ownerUrl, byContact };
}

export function parseLinkedInShares(exportDir: string): LinkedInShare[] {
  const filePath = findExportFile(exportDir, 'shares.csv');
  if (!filePath) return [];
  const rows = parseCsvRows(readFileSync(filePath, 'utf8'));
  if (rows.length < 2) return [];

  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iDate = col('date');
  const iLink = col('sharelink');
  const iComm = col('sharecommentary');
  const iUrl = col('sharedurl');
  const iVis = col('visibility');

  const out: LinkedInShare[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const commentary = (iComm >= 0 ? r[iComm] : '')?.trim() ?? '';
    if (!commentary) continue;
    out.push({
      date: (iDate >= 0 ? r[iDate] : '')?.trim() ?? '',
      share_link: (iLink >= 0 ? r[iLink] : '')?.trim() ?? '',
      commentary,
      shared_url: (iUrl >= 0 ? r[iUrl] : '')?.trim() ?? '',
      visibility: (iVis >= 0 ? r[iVis] : '')?.trim() ?? '',
    });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

export function listLinkedInCandidates(opts: {
  exportDir?: string;
  whitelistPath?: string;
  search?: string;
  onlyWithDms?: boolean;
  limit?: number;
} = {}): {
  ready: boolean;
  export_dir: string;
  has_connections: boolean;
  has_messages: boolean;
  has_shares: boolean;
  total_connections: number;
  total_matched: number;
  whitelisted_count: number;
  candidates: LinkedInCandidate[];
} {
  const exportDir = path.resolve(opts.exportDir ?? defaultLinkedInExportDir());
  const hasConnections = findExportFile(exportDir, 'connections.csv') !== null;
  const hasMessages = findExportFile(exportDir, 'messages.csv') !== null;
  const hasShares = findExportFile(exportDir, 'shares.csv') !== null;
  const wl = loadLinkedInWhitelist(opts.whitelistPath);
  const wlByKey = new Map(wl.contacts.map((c) => [c.key, c]));

  if (!hasConnections && !hasMessages) {
    return {
      ready: false,
      export_dir: exportDir,
      has_connections: false,
      has_messages: false,
      has_shares: hasShares,
      total_connections: 0,
      total_matched: 0,
      whitelisted_count: wlByKey.size,
      candidates: [],
    };
  }

  const connections = parseLinkedInConnections(exportDir);
  const { byContact } = parseLinkedInMessages(exportDir);

  const merged = new Map<string, Omit<LinkedInCandidate, 'slug' | 'whitelisted' | 'category'>>();
  const byNameSlug = new Map<string, string>();
  for (const c of connections) {
    merged.set(c.key, { ...c, message_count: 0, last_message: '' });
    byNameSlug.set(slugifyContactName(c.name), c.key);
  }

  for (const [key, msgs] of byContact.entries()) {
    const lastDate = msgs[msgs.length - 1]?.date ?? '';
    const existing = merged.get(key);
    if (existing) {
      existing.message_count += msgs.length;
      if (lastDate > existing.last_message) existing.last_message = lastDate;
      continue;
    }
    const sample = msgs[0]!;
    const fallbackKey = byNameSlug.get(slugifyContactName(sample.other_name));
    if (fallbackKey && merged.has(fallbackKey)) {
      const m = merged.get(fallbackKey)!;
      m.message_count += msgs.length;
      if (lastDate > m.last_message) m.last_message = lastDate;
    } else {
      merged.set(key, {
        key,
        name: sample.other_name,
        url: sample.other_url,
        email: '',
        company: '',
        position: '',
        connected_on: '',
        message_count: msgs.length,
        last_message: lastDate,
      });
    }
  }

  const q = (opts.search ?? '').trim().toLowerCase();
  const onlyWithDms = opts.onlyWithDms ?? false;
  const limit = opts.limit ?? 100;

  const items: LinkedInCandidate[] = [];
  for (const rec of merged.values()) {
    if (onlyWithDms && rec.message_count === 0) continue;
    const blob = `${rec.name} ${rec.company} ${rec.position} ${rec.url}`.toLowerCase();
    if (q && !blob.includes(q)) continue;
    const wlEntry = wlByKey.get(rec.key);
    items.push({
      ...rec,
      name: wlEntry?.name || rec.name,
      slug: wlEntry?.slug ?? slugifyContactName(rec.name),
      whitelisted: wlEntry !== undefined,
      category: wlEntry?.category ?? 'network',
    });
  }

  items.sort((a, b) => {
    if (a.whitelisted !== b.whitelisted) return a.whitelisted ? -1 : 1;
    if (a.message_count !== b.message_count) return b.message_count - a.message_count;
    return a.name.localeCompare(b.name);
  });

  return {
    ready: true,
    export_dir: exportDir,
    has_connections: hasConnections,
    has_messages: hasMessages,
    has_shares: hasShares,
    total_connections: connections.length,
    total_matched: items.length,
    whitelisted_count: wlByKey.size,
    candidates: items.slice(0, limit),
  };
}
