/**
 * Read-only macOS WhatsApp Desktop SQLite reader (bun:sqlite).
 *
 * Reads `ChatStorage.sqlite` in strictly read-only mode, converts Apple CoreData
 * timestamps (seconds since 2001-01-01T00:00:00Z), and counts real text messages
 * from `ZWAMESSAGE` (rather than relying on `ZMESSAGECOUNTER`).
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WhatsAppCandidate, WhatsAppMessage } from './types.ts';
import { loadWhatsAppWhitelist, slugifyContactName } from './whitelist.ts';

/** Seconds between Unix epoch (1970-01-01) and Apple CoreData epoch (2001-01-01). */
export const COREDATA_EPOCH_OFFSET = 978307200;

export function defaultWhatsAppDbPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Group Containers',
    'group.net.whatsapp.WhatsApp.shared',
    'ChatStorage.sqlite',
  );
}

export function coreDataToIso(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return '';
  const ms = Math.round((ts + COREDATA_EPOCH_OFFSET) * 1000);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function openReadOnly(dbPath?: string): Database {
  const resolved = dbPath ?? defaultWhatsAppDbPath();
  if (!existsSync(resolved)) {
    throw new Error(
      `WhatsApp Desktop database not found at ${resolved}. Ensure WhatsApp Desktop is installed or pass --db <path>.`,
    );
  }
  return new Database(resolved, { readonly: true });
}

interface SessionRow {
  jid: string;
  partner_name: string | null;
  msg_count: number;
  last_ts: number | null;
}

export function listWhatsAppCandidates(opts: {
  dbPath?: string;
  whitelistPath?: string;
  search?: string;
  includeGroups?: boolean;
  limit?: number;
} = {}): {
  db_path: string;
  total_matched: number;
  whitelisted_count: number;
  candidates: WhatsAppCandidate[];
} {
  const dbPath = opts.dbPath ?? defaultWhatsAppDbPath();
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .query<SessionRow, []>(
        `
        SELECT
          cs.ZCONTACTJID AS jid,
          cs.ZPARTNERNAME AS partner_name,
          COUNT(m.Z_PK) AS msg_count,
          MAX(m.ZMESSAGEDATE) AS last_ts
        FROM ZWACHATSESSION cs
        LEFT JOIN ZWAMESSAGE m
          ON m.ZCHATSESSION = cs.Z_PK
         AND m.ZTEXT IS NOT NULL
         AND TRIM(m.ZTEXT) != ''
        WHERE cs.ZCONTACTJID IS NOT NULL
        GROUP BY cs.Z_PK
        HAVING COUNT(m.Z_PK) > 0
        ORDER BY last_ts DESC
        `,
      )
      .all();

    const wl = loadWhatsAppWhitelist(opts.whitelistPath);
    const wlByJid = new Map(wl.contacts.map((c) => [c.jid, c]));
    const q = (opts.search ?? '').trim().toLowerCase();
    const includeGroups = opts.includeGroups ?? false;
    const limit = opts.limit ?? 100;

    const candidates: WhatsAppCandidate[] = [];
    for (const row of rows) {
      const jid = String(row.jid ?? '').trim();
      if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      const isGroup = jid.endsWith('@g.us');
      if (isGroup && !includeGroups) continue;

      const wlEntry = wlByJid.get(jid);
      const displayName = (wlEntry?.name || row.partner_name || jid.split('@')[0] || 'Unknown').trim();
      if (q && !`${displayName} ${jid}`.toLowerCase().includes(q)) continue;

      candidates.push({
        jid,
        name: displayName,
        is_group: isGroup,
        message_count: Number(row.msg_count ?? 0),
        last_message: coreDataToIso(row.last_ts),
        slug: wlEntry?.slug ?? slugifyContactName(displayName),
        whitelisted: wlEntry !== undefined,
        category: wlEntry?.category ?? 'network',
      });
    }

    candidates.sort((a, b) => {
      if (a.whitelisted !== b.whitelisted) return a.whitelisted ? -1 : 1;
      if (a.last_message !== b.last_message) return b.last_message.localeCompare(a.last_message);
      return b.message_count - a.message_count;
    });

    return {
      db_path: dbPath,
      total_matched: candidates.length,
      whitelisted_count: wlByJid.size,
      candidates: candidates.slice(0, limit),
    };
  } finally {
    db.close();
  }
}

interface RawMessageRow {
  pk: number;
  ts: number | null;
  from_me: number | null;
  text: string | null;
}

export function readWhatsAppMessages(opts: {
  jid: string;
  dbPath?: string;
  maxMessages?: number;
}): WhatsAppMessage[] {
  const db = openReadOnly(opts.dbPath);
  const limit = Math.max(1, opts.maxMessages ?? 500);
  try {
    const rows = db
      .query<RawMessageRow, [string, number]>(
        `
        SELECT
          m.Z_PK AS pk,
          m.ZMESSAGEDATE AS ts,
          m.ZISFROMME AS from_me,
          m.ZTEXT AS text
        FROM ZWAMESSAGE m
        JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
        WHERE cs.ZCONTACTJID = ?1
          AND m.ZTEXT IS NOT NULL
          AND TRIM(m.ZTEXT) != ''
        ORDER BY m.ZMESSAGEDATE DESC
        LIMIT ?2
        `,
      )
      .all(opts.jid, limit);

    rows.reverse();
    return rows.map((r) => ({
      id: Number(r.pk),
      timestampIso: coreDataToIso(r.ts),
      fromMe: Number(r.from_me ?? 0) === 1,
      text: String(r.text ?? '').trim(),
    }));
  } finally {
    db.close();
  }
}
