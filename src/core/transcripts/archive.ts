/**
 * archive.ts — the built-in conversation archive (GST-2768, PR 2: core and legacy adoption; off unless turned on).
 *
 * gbrain transcripts archive run | backfill --from --to | status | adopt-legacy | on | off.
 *
 * Each run reads every readable harness (the file adapters through harnessRoots(), OpenClaw archived session files,
 * and the OpenClaw Gateway), redacts each session as a whole, cuts it into local days in the source's pinned
 * timezone, and writes one page per (harness, conversation, day) plus a day index page (archive-day.ts). It never
 * touches a per-session page: day pages have their own slug and id namespace.
 *
 * Ledger: one config row per (source, harness, conversation_key_hash, day) under transcripts.archive.ledger.*, holding
 * the content hash, the complete flag, the slug and part count, and a held error code. The config table never
 * expires rows (op_checkpoint does, after 7 days). A day is rewritten only when its rendered content changed, so a
 * rerun, an overlapping backfill and a crash retry all converge on the same pages; a closed day whose redaction
 * changed is rewritten because its hash changed. A day whose source now has fewer messages than the ledger recorded
 * (an OpenClaw reset in place drops the earlier messages from chat.history) is kept as written.
 *
 * Timezone: pinned per source at the first run (transcripts.archive.pinned_timezone.<source>) from
 * transcripts.archive.timezone or the machine's zone, and stamped into every page. A later change to the setting
 * never re-slices.
 *
 * Privacy: a personal brain writes no readable_by (every caller is the owner). A shared brain (brain.audience
 * shared, unknown, or two or more enabled members) gives every page readable_by [owner]; a verified group or room
 * adds group:chat-<hash8> only when that group principal already exists. With no owner member set, every day is
 * held with archive_owner_unset: no archive page is ever written without readable_by on a shared brain. A shared
 * brain whose archive source sits in a repository archives into <source>-owner, a database-only source, so nothing
 * is committed where repository readers could read it.
 *
 * Write paths: managed persistence goes through the coordinator; an unmanaged repository source gets the redacted
 * files written, committed with gbrain git commit-push -- <paths>, then imported by sync (git stays the parent); any
 * other brain writes the database directly. Nothing refuses for lack of a repository.
 *
 * Embedding: pages are written keyword-only. Backfilled pages are held in page_embedding_budget (reason
 * archive_backfill) until the owner approves the previewed cost with gbrain embed --held. The open day is held
 * (archive_open_day) until it closes or has been quiet for transcripts.archive.quiet_minutes. No fact extraction.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { OperationContext } from '../ops/contract.ts';
import { importFromContent } from '../import-file.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { classifyItemFailure } from '../item-failure.ts';
import { classifyBrainAudience } from '../facts/writeback-audience.ts';
import { listGroups, listMembers } from '../access/members.ts';
import { ownerView } from '../access/owner.ts';
import { holdPageEmbedding } from '../page-embedding-budget.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import type { ParsedSession, TranscriptFormat } from './types.ts';
import { transcriptFullId } from './types.ts';
import { loadImportRedactionPatterns, PAGE_CEILING_FILL, redactSession, type RedactedSession, type RenderedPart } from './render.ts';
import { deleteStaleTranscriptPart, submitTranscriptPart, transcriptPageCeiling } from './ingest.ts';
import {
  addDays, assertTimeZone, localDay, renderArchiveDay, renderDayIndex, sliceSessionByDay, conversationHash8,
  type ArchiveChannel, type DayIndexEntry,
} from './archive-day.ts';

export type { ArchiveChannel } from './archive-day.ts';

export const ARCHIVE_ENABLED_KEY = 'transcripts.archive.enabled';
export const ARCHIVE_TIMEZONE_KEY = 'transcripts.archive.timezone';
export const ARCHIVE_SOURCE_KEY = 'transcripts.archive.source';
export const ARCHIVE_BACKFILL_CAP_KEY = 'transcripts.archive.backfill_days_per_run';
export const ARCHIVE_RUN_WINDOW_KEY = 'transcripts.archive.run_window_days';
export const ARCHIVE_QUIET_MINUTES_KEY = 'transcripts.archive.quiet_minutes';
export const ARCHIVE_BACKFILL_HOLD_REASON = 'archive_backfill';
export const ARCHIVE_OPEN_DAY_HOLD_REASON = 'archive_open_day';
export const DEFAULT_ARCHIVE_SOURCE = 'conversations';
export const DEFAULT_BACKFILL_DAYS_PER_RUN = 30;
export const DEFAULT_RUN_WINDOW_DAYS = 2;
export const DEFAULT_QUIET_MINUTES = 180;
const LEDGER_PREFIX = 'transcripts.archive.ledger.';
const PIN_PREFIX = 'transcripts.archive.pinned_timezone.';
const LEGACY_PREFIX = 'transcripts.archive.legacy.';
const INGESTED_VIA = 'cli:transcripts-archive';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ArchiveConversation {
  harness: TranscriptFormat;
  /** The conversation's identity in its harness: the OpenClaw session key, else the session id. */
  conversationKey: string;
  session: ParsedSession;
  channel?: ArchiveChannel;
  /** Where it was read; a Gateway conversation wins over an archived file of the same OpenClaw session. */
  via?: 'gateway' | 'file';
}

/** One conversation found by a scan: its days and how to read it again; no message is held between the two. */
export interface ArchiveScanEntry {
  harness: TranscriptFormat;
  conversationKey: string;
  sessionId: string;
  via?: 'gateway' | 'file';
  /** Local days (dayOf) that hold at least one message. */
  days: string[];
  /** Per day, the identities (archiveMessageId) of its messages, so backfill can tell a finished day from a changed one. */
  dayIds?: Record<string, string[]>;
  newest?: string;
  load(): Promise<ArchiveConversation | null>;
}

export interface ArchiveScanOpts { sinceMs?: number; minMtimeMs?: number; dayOf: (ts: string) => string }

export interface ArchiveReader {
  harness: TranscriptFormat;
  name: string;
  /** Every readable conversation (sinceMs narrows by activity). Throws a coded error; yields nothing partial. */
  list?(opts: { sinceMs?: number }): Promise<ArchiveConversation[]>;
  /** Streaming form for large stores: one entry per conversation, parsed one file at a time and loaded again only for the days a run writes. */
  scan?(opts: ArchiveScanOpts): AsyncIterable<ArchiveScanEntry>;
  /** Set when the harness has nothing to read on this machine: an informational line, never an error. */
  unavailable?: string;
}

export interface ArchiveHeld { code: string; message: string }

export interface ArchiveLedgerEntry {
  source_id: string;
  harness: string;
  conversation_key_hash: string;
  day: string;
  hash?: string;
  complete?: boolean;
  slug?: string;
  parts?: number;
  messages?: number;
  /** Identities (archiveMessageId) of the messages the page holds; a rewrite that would drop one is kept instead. */
  ids?: string[];
  /** Signature of the source's message identities for the day when it was written; backfill skips a finished day whose source still matches. */
  source?: string;
  held?: ArchiveHeld;
  updated_at?: string;
}

export type ArchiveDayStatus = 'written' | 'unchanged' | 'held' | 'planned' | 'skipped_legacy' | 'kept' | 'error';

export interface ArchiveDayOutcome {
  harness: string;
  conversation_key_hash: string;
  day: string;
  status: ArchiveDayStatus;
  slug?: string;
  parts?: number;
  messages?: number;
  readable_by?: string[];
  redactions?: number;
  code?: string;
  message?: string;
}

export interface ArchiveReaderError { harness: string; reader: string; code: string; message: string; fix?: Action }

export interface ArchiveRunResult {
  mode: 'run' | 'backfill';
  enabled: boolean;
  dry_run: boolean;
  source_id: string;
  timezone: string;
  write_mode: 'database' | 'repo' | 'coordinator';
  privacy: 'personal' | 'shared';
  from: string;
  to: string;
  days: ArchiveDayOutcome[];
  written: number;
  unchanged: number;
  held: number;
  planned: number;
  skipped_legacy: number;
  index_pages: string[];
  deferred_days: string[];
  info: string[];
  errors: ArchiveReaderError[];
  message?: string;
  fix?: Action;
}

export interface ArchiveRunOpts {
  mode: 'run' | 'backfill';
  from?: string;
  to?: string;
  dryRun?: boolean;
  sourceId?: string;
  readers?: ArchiveReader[];
  now?: Date;
  /** The CLI's trusted-local context: managed brains write through the coordinator with it. */
  context?: OperationContext;
  /** Builds that context for the archive source once it exists (the CLI passes its makeContext); called only on a managed brain. */
  makeContext?: (sourceId: string) => Promise<OperationContext>;
  /** Test seam: the redaction pass (default redactSession over the whole session). */
  redact?: (session: ParsedSession) => RedactedSession;
  /** Repository path: commit the written files (default gbrain git commit-push -- <paths>). */
  commitPaths?: (root: string, paths: string[], message: string) => Promise<void>;
  /** Repository path: import the committed files (default an in-process sync of the source). */
  syncSource?: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const truthy = (v: string | null | undefined) => ['1', 'true', 'on', 'yes'].includes(String(v ?? '').trim().toLowerCase());

/** The group principal a group or room conversation may be shared with, once the operator creates it: group:chat-<hash8>. */
export function archiveGroupPrincipal(harness: TranscriptFormat, conversationKey: string): string {
  return 'chat-' + conversationHash8(harness, conversationKey);
}

export async function archiveEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return truthy(await engine.getConfig(ARCHIVE_ENABLED_KEY));
}

export async function setArchiveEnabled(engine: BrainEngine, on: boolean): Promise<void> {
  await engine.setConfig(ARCHIVE_ENABLED_KEY, on ? 'true' : 'false');
}

async function configuredSource(engine: BrainEngine, sourceId?: string): Promise<string> {
  return sourceId ?? ((await engine.getConfig(ARCHIVE_SOURCE_KEY))?.trim() || DEFAULT_ARCHIVE_SOURCE);
}

/** The source run, status and adopt-legacy all use: on a shared brain whose archive source is a checkout, its owner-only twin. */
async function effectiveSource(engine: BrainEngine, sourceId?: string): Promise<{ sourceId: string; privacy: Privacy }> {
  const configured = await configuredSource(engine, sourceId);
  const privacy = await resolvePrivacy(engine);
  const [existing] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [configured]);
  return { sourceId: privacy.shared && existing?.local_path ? configured + '-owner' : configured, privacy };
}

/** One message's identity across readers and runs: role, timestamp and text, before redaction. */
export function archiveMessageId(m: { role: string; timestamp: string; text: string }): string {
  return createHash('sha256').update(m.role + '\u0000' + m.timestamp + '\u0000' + m.text).digest('hex').slice(0, 16);
}

const daySignature = (ids: Iterable<string>) => sha256([...new Set(ids)].sort().join(','));

async function configInt(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const n = Number((await engine.getConfig(key))?.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function ledgerKey(sourceId: string, harness: string, hash: string, day: string): string {
  return LEDGER_PREFIX + sourceId + '.' + harness + '.' + hash + '.' + day;
}

export async function readArchiveLedger(engine: BrainEngine, sourceId: string): Promise<ArchiveLedgerEntry[]> {
  const prefix = LEDGER_PREFIX + sourceId + '.';
  const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key LIKE $1 ORDER BY key', [prefix + '%']);
  const out: ArchiveLedgerEntry[] = [];
  for (const row of rows) {
    const [harness, hash, day] = row.key.slice(prefix.length).split('.');
    if (!harness || !hash || !day) continue;
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(row.value) as Record<string, unknown>; } catch { /* an unreadable row reads as empty and is rewritten */ }
    out.push({ ...value, source_id: sourceId, harness, conversation_key_hash: hash, day } as ArchiveLedgerEntry);
  }
  return out;
}

async function writeLedger(engine: BrainEngine, entry: ArchiveLedgerEntry): Promise<void> {
  const { source_id, harness, conversation_key_hash, day, ...value } = entry;
  await engine.setConfig(ledgerKey(source_id, harness, conversation_key_hash, day), JSON.stringify({ ...value, updated_at: new Date().toISOString() }));
}

async function legacyCovered(engine: BrainEngine, sourceId: string): Promise<Set<string>> {
  const prefix = LEGACY_PREFIX + sourceId + '.';
  const rows = await engine.executeRaw<{ key: string }>('SELECT key FROM config WHERE key LIKE $1', [prefix + '%']);
  return new Set(rows.map(r => r.key.slice(prefix.length)));
}

function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The pinned timezone, or the one the first run will pin. */
async function archiveTimeZone(engine: BrainEngine, sourceId: string): Promise<{ timezone: string; pinned: boolean; configured: string }> {
  const configured = (await engine.getConfig(ARCHIVE_TIMEZONE_KEY))?.trim() || machineTimeZone();
  const pinned = (await engine.getConfig(PIN_PREFIX + sourceId))?.trim();
  return pinned ? { timezone: pinned, pinned: true, configured } : { timezone: assertTimeZone(configured), pinned: false, configured };
}

interface Privacy { shared: boolean; owner: string | null }

async function resolvePrivacy(engine: BrainEngine): Promise<Privacy> {
  const audience = await classifyBrainAudience(engine);
  const enabled = (await listMembers(engine)).filter(m => m.status === 'enabled').length;
  const shared = audience.audience !== 'personal' || enabled >= 2;
  return { shared, owner: shared ? (await ownerView(engine)).owner : null };
}

async function readersFor(engine: BrainEngine, privacy: Privacy, conv: ArchiveConversation, groups: Map<string, boolean>): Promise<string[] | undefined> {
  if (!privacy.shared) return undefined;
  const readers = [privacy.owner!];
  const ch = conv.channel;
  if (ch?.verified && (ch.chatType === 'group' || ch.chatType === 'room')) {
    const principal = archiveGroupPrincipal(conv.harness, conv.conversationKey);
    if (!groups.has(principal)) groups.set(principal, (await listGroups(engine, principal).catch(() => [])).length > 0);
    if (groups.get(principal)) readers.push('group:' + principal);
  }
  return readers;
}

function isGitRepo(path: string | null): boolean {
  return !!path && existsSync(join(path, '.git'));
}

async function ensureSource(engine: BrainEngine, sourceId: string): Promise<{ local_path: string | null }> {
  const [row] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  if (row) return row;
  const { addSource } = await import('../sources-ops.ts');
  await addSource(engine, { id: sourceId, name: 'Conversation archive' });
  return { local_path: null };
}

const offFix: Action = { argv: ['gbrain', 'transcripts', 'archive', 'on'], consent: [], actor: 'user', why: 'Turns the conversation archive on for this brain; it is off unless the owner turns it on.', requires_exclusive: false };
const ownerFix: Action = {
  argv: ['gbrain', 'access', 'owner', 'set', '<MEMBER>'], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
  inputs: [{ name: 'MEMBER', how: 'Ask the user which enabled member is the brain owner (gbrain access member list).' }],
  why: 'On a shared brain every archive page is kept to the owner member; with none named the archive holds every day and writes nothing.',
} as Action;

function emptyResult(mode: 'run' | 'backfill', base: Partial<ArchiveRunResult>): ArchiveRunResult {
  return {
    mode, enabled: false, dry_run: false, source_id: DEFAULT_ARCHIVE_SOURCE, timezone: 'UTC', write_mode: 'database', privacy: 'personal',
    from: '', to: '', days: [], written: 0, unchanged: 0, held: 0, planned: 0, skipped_legacy: 0, index_pages: [], deferred_days: [], info: [], errors: [],
    ...base,
  };
}

/** Readers this machine has: file adapters for every harness root, OpenClaw archived files, and the OpenClaw Gateway. */
export async function defaultArchiveReaders(): Promise<ArchiveReader[]> {
  const { fileArchiveReaders } = await import('./archive-readers.ts');
  return fileArchiveReaders();
}

/** A list reader's conversations as scan entries (in memory already); a scan reader as it is. A list reader that throws yields nothing. */
export async function* scanReader(reader: ArchiveReader, opts: ArchiveScanOpts): AsyncGenerator<ArchiveScanEntry> {
  if (reader.scan) { yield* reader.scan(opts); return; }
  const convs = reader.list ? await reader.list({ sinceMs: opts.sinceMs }) : [];
  for (const conv of convs) {
    if (conv.session.messages.length === 0) continue;
    const stamps = conv.session.messages.map(m => m.timestamp).filter(Boolean);
    const dayIds: Record<string, string[]> = {};
    for (const m of conv.session.messages) if (m.timestamp) (dayIds[opts.dayOf(m.timestamp)] ??= []).push(archiveMessageId(m));
    yield {
      harness: conv.harness, conversationKey: conv.conversationKey, sessionId: conv.session.meta.sessionId, ...(conv.via ? { via: conv.via } : {}),
      days: Object.keys(dayIds), dayIds, newest: stamps.sort().pop(), load: async () => conv,
    };
  }
}

/** A Gateway conversation with the session files of the same session id: its key and channel, every message once, oldest first. */
function mergeScanEntries(gateway: ArchiveScanEntry, files: ArchiveScanEntry[]): ArchiveScanEntry {
  const dayIds: Record<string, string[]> = {};
  for (const e of [gateway, ...files]) for (const [day, ids] of Object.entries(e.dayIds ?? {})) dayIds[day] = [...new Set([...(dayIds[day] ?? []), ...ids])];
  const days = [...new Set([gateway, ...files].flatMap(e => e.days))];
  const newest = [gateway, ...files].map(e => e.newest).filter((s): s is string => !!s).sort().pop();
  return {
    ...gateway, days, dayIds, ...(newest ? { newest } : {}),
    async load() {
      const base = await gateway.load();
      if (!base) return null;
      const seen = new Set(base.session.messages.map(archiveMessageId));
      const messages = [...base.session.messages];
      for (const f of files) {
        const conv = await f.load();
        for (const m of conv?.session.messages ?? []) {
          const id = archiveMessageId(m);
          if (seen.has(id)) continue;
          seen.add(id);
          messages.push(m);
        }
      }
      messages.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      return { ...base, session: { ...base.session, messages } };
    },
  };
}

/** A run writes its pages in batches of this many conversation-days or bytes, so memory stays bounded on a large store. */
const FLUSH_DAYS = 200;
const FLUSH_BYTES = 8 * 1024 * 1024;

interface DayWrite {
  outcome: ArchiveDayOutcome;
  parts: RenderedPart[];
  harness: string;
  raw?: Record<string, unknown>;
  ledger?: ArchiveLedgerEntry;
  hold: 'backfill' | 'open' | 'release' | null;
  staleSlugs: string[];
}

export async function runTranscriptArchive(engine: BrainEngine, opts: ArchiveRunOpts): Promise<ArchiveRunResult> {
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date();
  const enabled = await archiveEnabled(engine);
  if (!enabled && !dryRun) {
    return emptyResult(opts.mode, {
      source_id: await configuredSource(engine, opts.sourceId),
      message: 'The conversation archive is off on this brain, so nothing was read or written. It stays off until the owner turns it on.',
      fix: offFix,
    });
  }
  const { sourceId, privacy } = await effectiveSource(engine, opts.sourceId);
  const source = dryRun
    ? (await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]))[0] ?? { local_path: null }
    : await ensureSource(engine, sourceId);
  const context = dryRun ? undefined
    : opts.context ?? (opts.makeContext && await managedPersistenceEnabled(engine) ? await opts.makeContext(sourceId) : undefined);
  const managed = !!context && await managedPersistenceEnabled(engine);
  const writeMode: ArchiveRunResult['write_mode'] = managed ? 'coordinator' : (!privacy.shared && isGitRepo(source.local_path) ? 'repo' : 'database');
  const tz = await archiveTimeZone(engine, sourceId);
  if (!tz.pinned && !dryRun) await engine.setConfig(PIN_PREFIX + sourceId, tz.timezone);
  const today = localDay(now.toISOString(), tz.timezone);

  let from: string;
  let to: string;
  if (opts.mode === 'run') {
    to = today;
    from = addDays(today, -(await configInt(engine, ARCHIVE_RUN_WINDOW_KEY, DEFAULT_RUN_WINDOW_DAYS)));
  } else {
    if (!opts.from || !DAY_RE.test(opts.from) || (opts.to && !DAY_RE.test(opts.to))) {
      const { opError } = await import('../ops/contract.ts');
      throw opError('invalid_params', 'backfill needs --from YYYY-MM-DD (and an optional --to YYYY-MM-DD); nothing was read.',
        'Run gbrain transcripts archive backfill --from 2026-01-01 --to 2026-01-31.');
    }
    from = opts.from;
    to = opts.to ?? today;
  }

  const result = emptyResult(opts.mode, {
    enabled, dry_run: dryRun, source_id: sourceId, timezone: tz.timezone, write_mode: writeMode,
    privacy: privacy.shared ? 'shared' : 'personal', from, to,
  });
  if (privacy.shared && !privacy.owner) {
    result.message = 'This brain is shared and names no owner member, so every archive day is held (archive_owner_unset) and nothing was written.';
    result.fix = ownerFix;
  }

  const readers = opts.readers ?? await defaultArchiveReaders();
  const sinceMs = opts.mode === 'run' ? Date.parse(from + 'T00:00:00.000Z') - 2 * 86_400_000 : undefined;
  const minMtimeMs = opts.mode === 'backfill' ? Date.parse(from + 'T00:00:00.000Z') - 2 * 86_400_000 : sinceMs;
  const dayOf = (ts: string) => localDay(ts, tz.timezone);
  const entries: ArchiveScanEntry[] = [];
  for (const reader of readers) {
    if (reader.unavailable) { result.info.push(reader.unavailable); continue; }
    try {
      let found = 0;
      for await (const entry of scanReader(reader, { sinceMs, minMtimeMs, dayOf })) { entries.push(entry); found++; }
      if (found === 0) result.info.push('no readable sessions for ' + reader.harness + '; use gbrain connectors or an export with gbrain transcripts ingest');
    } catch (err) {
      if (classifyItemFailure(err).scope === 'run') throw err;
      const e = err as { code?: string; message?: string; fix?: Action };
      result.errors.push({ harness: reader.harness, reader: reader.name, code: e.code ?? 'archive_reader_failed', message: e.message ?? String(err), ...(e.fix ? { fix: e.fix } : {}) });
    }
  }
  // A Gateway conversation and the session files of the same session id are one conversation: a reset in place leaves
  // the earlier messages only in the .jsonl.reset.* file, so the file messages merge in, each message once.
  const filesBySession = new Map<string, ArchiveScanEntry[]>();
  for (const e of entries) if (e.harness === 'openclaw' && e.via === 'file') filesBySession.set(e.sessionId, [...(filesBySession.get(e.sessionId) ?? []), e]);
  const merged = new Set<ArchiveScanEntry>();
  const scanned: ArchiveScanEntry[] = [];
  for (const e of entries) {
    if (e.harness !== 'openclaw' || e.via !== 'gateway' || !filesBySession.has(e.sessionId)) continue;
    const files = filesBySession.get(e.sessionId)!;
    files.forEach(f => merged.add(f));
    merged.add(e);
    scanned.push(mergeScanEntries(e, files));
  }
  scanned.push(...entries.filter(e => !merged.has(e)));

  const ledger = new Map((await readArchiveLedger(engine, sourceId)).map(e => [e.harness + '.' + e.conversation_key_hash + '.' + e.day, e]));
  const legacy = await legacyCovered(engine, sourceId);
  const covered = (harness: string, day: string) => legacy.has(harness + '.' + day) || legacy.has('*.' + day);

  interface Item { entry: ArchiveScanEntry; hash: string; days: string[] }
  const items: Item[] = [];
  const allDays = new Set<string>();
  for (const entry of scanned) {
    const hash = transcriptFullId(entry.conversationKey);
    const live: string[] = [];
    for (const day of entry.days.filter(d => d >= from && d <= to)) {
      if (covered(entry.harness, day)) {
        result.days.push({ harness: entry.harness, conversation_key_hash: hash, day, status: 'skipped_legacy' });
        result.skipped_legacy++;
        continue;
      }
      const done = ledger.get(entry.harness + '.' + hash + '.' + day);
      const sig = entry.dayIds?.[day] ? daySignature(entry.dayIds[day]!) : undefined;
      if (opts.mode === 'backfill' && done?.hash && !done.held && done.complete && day < today && sig && done.source === sig) { result.unchanged++; continue; }
      live.push(day);
      allDays.add(day);
    }
    if (live.length) items.push({ entry, hash, days: live });
  }
  let allowed: Set<string> | null = null;
  if (opts.mode === 'backfill') {
    const cap = await configInt(engine, ARCHIVE_BACKFILL_CAP_KEY, DEFAULT_BACKFILL_DAYS_PER_RUN);
    const ordered = [...allDays].sort().reverse();
    allowed = new Set(ordered.slice(0, cap));
    result.deferred_days = ordered.slice(cap).sort();
  }

  const patterns = loadImportRedactionPatterns();
  const redact = opts.redact ?? ((s: ParsedSession) => redactSession(s, { patterns }));
  const pageCeiling = dryRun ? Math.floor(PAGE_MAX_BYTES * PAGE_CEILING_FILL) : await transcriptPageCeiling(engine);
  const quietMs = (await configInt(engine, ARCHIVE_QUIET_MINUTES_KEY, DEFAULT_QUIET_MINUTES)) * 60_000;
  const groups = new Map<string, boolean>();
  const pending: ArchiveDayOutcome[] = [];
  const touched = new Set<string>();
  let batch: DayWrite[] = [];
  let batchBytes = 0;
  const flushBatch = async () => {
    if (!batch.length) return;
    await flushWrites(engine, opts, { sourceId, writeMode, root: source.local_path, context }, batch);
    for (const w of batch) {
      if (w.outcome.status !== 'written' || !w.ledger) continue;
      ledger.set(w.ledger.harness + '.' + w.ledger.conversation_key_hash + '.' + w.ledger.day, w.ledger);
      touched.add(w.outcome.day);
    }
    batch = [];
    batchBytes = 0;
  };

  const hold = async (outcome: ArchiveDayOutcome, held: ArchiveHeld, prior: ArchiveLedgerEntry | undefined) => {
    Object.assign(outcome, { status: 'held', code: held.code, message: held.message });
    if (!dryRun) await writeLedger(engine, { ...(prior ?? {}), source_id: sourceId, harness: outcome.harness, conversation_key_hash: outcome.conversation_key_hash, day: outcome.day, held });
  };

  for (const { entry, hash, days } of items) {
    const todo = [...(allowed ? days.filter(d => allowed!.has(d)) : days)].sort().reverse();
    if (todo.length === 0) continue;
    const outcomes = todo.map(day => ({ harness: entry.harness, conversation_key_hash: hash, day, status: 'planned' as ArchiveDayStatus } as ArchiveDayOutcome));
    pending.push(...outcomes);
    const prior = (day: string) => ledger.get(entry.harness + '.' + hash + '.' + day);
    if (privacy.shared && !privacy.owner) {
      for (const o of outcomes) await hold(o, { code: 'archive_owner_unset', message: 'The brain is shared and names no owner member.' }, prior(o.day));
      continue;
    }
    let conv: ArchiveConversation | null;
    try {
      conv = await entry.load();
    } catch (err) {
      conv = null;
      for (const o of outcomes) Object.assign(o, { status: 'error', code: 'archive_reader_failed', message: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      continue;
    }
    if (!conv) {
      for (const o of outcomes) Object.assign(o, { status: 'error', code: 'archive_day_missing', message: 'the conversation could not be read again for this run' });
      continue;
    }
    let redacted: RedactedSession;
    try {
      redacted = redact(conv.session);
    } catch (err) {
      const message = 'Redaction failed for this session, so its days were held, not written: ' + (err instanceof Error ? err.message : String(err)).slice(0, 200);
      for (const o of outcomes) await hold(o, { code: 'archive_redaction_failed', message }, prior(o.day));
      continue;
    }
    const readableBy = await readersFor(engine, privacy, conv, groups);
    const slices = new Map(sliceSessionByDay(redacted.session.messages, tz.timezone).map(s => [s.day, s]));
    const raw = conv.session.messages.length === redacted.session.messages.length ? conv.session.messages : redacted.session.messages;
    for (const outcome of outcomes) {
      const slice = slices.get(outcome.day);
      if (!slice) { Object.assign(outcome, { status: 'error', code: 'archive_day_missing', message: 'the redacted session has no messages on this day' }); continue; }
      const complete = outcome.day < today;
      const ids = [...new Set(slice.indexes.map(i => archiveMessageId(raw[i]!)))];
      const lastTs = slice.messages[slice.messages.length - 1]?.timestamp;
      const quiet = !!lastTs && now.getTime() - Date.parse(lastTs) >= quietMs;
      const hold: DayWrite['hold'] = opts.mode === 'backfill' ? 'backfill' : (!complete && !quiet ? 'open' : 'release');
      const dayInput = {
        harness: conv.harness, conversationKey: conv.conversationKey, channel: conv.channel, day: outcome.day, timezone: tz.timezone,
        redacted, slice, complete, partTargetBytes: pageCeiling, readableBy,
      };
      let rendered = renderArchiveDay(dayInput);
      const contentHash = sha256(rendered.parts.map(p => p.content).join('\u0000'));
      Object.assign(outcome, {
        slug: rendered.baseSlug, parts: rendered.parts.length, messages: rendered.messages,
        redactions: Object.values((rendered.parts[0]!.frontmatter.transcript_archive as { redactions: Record<string, number> }).redactions).reduce((a, b) => a + b, 0),
        ...(readableBy ? { readable_by: readableBy } : {}),
      });
      const before = prior(outcome.day);
      const lost = before?.ids ? before.ids.some(id => !ids.includes(id)) : (before?.messages ?? 0) > rendered.messages;
      if (before?.hash && !before.held && lost) {
        outcome.status = 'kept';
        outcome.message = 'the source no longer holds every message the archive wrote for this day (a reset or compaction); the archived page is kept';
        continue;
      }
      if (dryRun) { outcome.status = 'planned'; continue; }
      if (before?.hash === contentHash && !before.held && await pageExists(engine, sourceId, rendered.baseSlug)) {
        outcome.status = 'unchanged';
        if (hold === 'release') await releaseOpenDayHold(engine, sourceId, rendered.parts.map(p => p.slug));
        continue;
      }
      const embeddingHold = hold === 'backfill' ? ARCHIVE_BACKFILL_HOLD_REASON : hold === 'open' ? ARCHIVE_OPEN_DAY_HOLD_REASON : undefined;
      if (embeddingHold) rendered = renderArchiveDay({ ...dayInput, embeddingHold });
      const renamed = before?.slug && before.slug !== rendered.baseSlug
        ? [before.slug, ...Array.from({ length: Math.max(0, (before.parts ?? 1) - 1) }, (_, i) => before.slug + '-p' + (i + 2))]
        : [];
      batch.push({
        outcome,
        parts: rendered.parts,
        harness: conv.harness,
        ...(redacted.session.meta.raw ? { raw: redacted.session.meta.raw } : {}),
        ledger: { source_id: sourceId, harness: conv.harness, conversation_key_hash: hash, day: outcome.day, hash: contentHash, complete, slug: rendered.baseSlug, parts: rendered.parts.length, messages: rendered.messages, ids, source: daySignature(ids) },
        hold,
        staleSlugs: renamed.length ? renamed : Array.from({ length: Math.max(0, (before?.parts ?? 0) - rendered.parts.length) }, (_, i) => rendered.baseSlug + '-p' + (rendered.parts.length + i + 1)),
      });
      batchBytes += rendered.parts.reduce((n, p) => n + p.content.length, 0);
    }
    if (batch.length >= FLUSH_DAYS || batchBytes >= FLUSH_BYTES) await flushBatch();
  }
  const indexFor = (days: Set<string>, view: Map<string, ArchiveLedgerEntry>): DayWrite[] => [...days].sort().map(day => {
    const dayEntries: DayIndexEntry[] = [];
    for (const e of view.values()) {
      if (e.day !== day || !e.slug || e.held) continue;
      dayEntries.push({ slug: e.slug, harness: e.harness, messages: e.messages ?? 0 });
    }
    const page = renderDayIndex(day, tz.timezone, dayEntries, privacy.shared ? [privacy.owner!] : undefined);
    return { outcome: { harness: 'index', conversation_key_hash: '', day, status: 'planned', slug: page.slug }, parts: [page], harness: 'index', hold: null, staleSlugs: [] };
  });
  let indexWrites: DayWrite[] = [];
  if (writeMode === 'repo') {
    // A repo commit carries the last batch's days with their index pages, so a small run is one commit.
    const view = new Map(ledger);
    const days = new Set(touched);
    for (const w of batch) if (w.ledger) { view.set(w.ledger.harness + '.' + w.ledger.conversation_key_hash + '.' + w.ledger.day, w.ledger); days.add(w.outcome.day); }
    indexWrites = indexFor(days, view);
    batch.push(...indexWrites);
    await flushBatch();
  } else {
    await flushBatch();
    if (touched.size) {
      indexWrites = indexFor(touched, ledger);
      await flushWrites(engine, opts, { sourceId, writeMode, root: source.local_path, context }, indexWrites);
    }
  }
  for (const w of indexWrites) {
    if (w.outcome.status === 'written' || w.outcome.status === 'unchanged') result.index_pages.push(w.outcome.slug!);
    else if (w.outcome.status === 'error') result.errors.push({ harness: 'index', reader: 'day-index', code: w.outcome.code ?? 'archive_commit_failed', message: 'the day index ' + w.outcome.slug + ' was not written: ' + (w.outcome.message ?? 'no detail') });
  }

  pending.sort((a, b) => b.day.localeCompare(a.day));
  result.days.push(...pending);
  for (const d of result.days) {
    if (d.status === 'written') result.written++;
    else if (d.status === 'unchanged') result.unchanged++;
    else if (d.status === 'held') result.held++;
    else if (d.status === 'planned') result.planned++;
  }
  if (result.deferred_days.length) result.info.push(result.deferred_days.length + ' older day(s) wait for the next backfill run (' + ARCHIVE_BACKFILL_CAP_KEY + ' caps one run)');
  return result;
}

async function pageExists(engine: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  return (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug])).length > 0;
}

async function defaultCommit(root: string, paths: string[], message: string): Promise<void> {
  const { commitPushChild } = await import('../git/reconcile.ts');
  await commitPushChild(root, ['-m', message], undefined, paths);
}

async function defaultSync(engine: BrainEngine, sourceId: string, root: string): Promise<void> {
  const { performSync } = await import('../../commands/sync/perform.ts');
  await performSync(engine, { sourceId, repoPath: root, noPull: true, noEmbed: true, noExtract: true });
}

/** Writes every rendered page through the brain's one write path, then records raw data, embedding holds and the ledger. */
/** A closed or quiet day's open-day hold is opened, not deleted, so the page's frontmatter marker never holds it again. */
async function releaseOpenDayHold(engine: BrainEngine, sourceId: string | null, slugs: string[], pageId?: number): Promise<void> {
  const ids = pageId !== undefined ? [pageId]
    : (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL', [sourceId, slugs])).map(r => r.id);
  if (!ids.length) return;
  await engine.executeRaw("UPDATE page_embedding_budget SET state = 'open', reason = NULL, updated_at = now() WHERE page_id = ANY($1::int[]) AND state = 'held' AND reason = $2", [ids, ARCHIVE_OPEN_DAY_HOLD_REASON]);
}

async function flushWrites(engine: BrainEngine, opts: ArchiveRunOpts, target: { sourceId: string; writeMode: ArchiveRunResult['write_mode']; root: string | null; context?: OperationContext }, writes: DayWrite[]): Promise<void> {
  const { sourceId, writeMode } = target;
  const provenance = (harness: string) => ({ source_kind: 'transcript:' + harness, source_uri: 'archive:' + harness, ingested_via: INGESTED_VIA });
  if (writeMode === 'repo') {
    const root = target.root!;
    const paths: string[] = [];
    for (const w of writes) {
      for (const part of w.parts) {
        const file = join(root, part.slug + '.md');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, part.content);
        paths.push(relative(root, file).split(sep).join('/'));
      }
      for (const stale of w.staleSlugs) {
        const file = join(root, stale + '.md');
        if (existsSync(file)) { rmSync(file); paths.push(relative(root, file).split(sep).join('/')); }
      }
    }
    try {
      await (opts.commitPaths ?? defaultCommit)(root, paths, 'gbrain: archive ' + writes.filter(w => w.ledger).length + ' conversation day(s)');
      await (opts.syncSource ?? defaultSync)(engine, sourceId, root);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      for (const w of writes) Object.assign(w.outcome, { status: 'error', code: e.code ?? 'archive_commit_failed', message: (e.message ?? String(err)).slice(0, 300) });
      return;
    }
    for (const w of writes) w.outcome.status = 'written';
  } else {
    for (const w of writes) {
      try {
        for (const part of w.parts) {
          const r = writeMode === 'coordinator'
            ? await submitTranscriptPart(target.context!, engine, sourceId, part, provenance(w.harness))
            : await importFromContent(engine, part.slug, part.content, { sourceId, noEmbed: true, ...provenance(w.harness) });
          if (r.status === 'error') throw new Error('the page write for ' + part.slug + ' returned an error');
        }
        for (const stale of w.staleSlugs) {
          if (writeMode === 'coordinator') await deleteStaleTranscriptPart(target.context!, engine, sourceId, stale);
          else await engine.deletePages([stale], { sourceId });
        }
        w.outcome.status = 'written';
      } catch (err) {
        if (classifyItemFailure(err).scope === 'run') throw err;
        const e = err as { code?: string; message?: string };
        Object.assign(w.outcome, { status: 'error', code: e.code ?? classifyItemFailure(err).code, message: (e.message ?? String(err)).slice(0, 300) });
      }
    }
  }
  for (const w of writes) {
    if (w.outcome.status !== 'written') continue;
    if (w.raw) await engine.putRawData(w.parts[0]!.slug, 'transcript:' + w.harness, w.raw, { sourceId });
    if (w.hold) {
      const ids = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL', [sourceId, w.parts.map(p => p.slug)]);
      for (const { id } of ids) {
        if (w.hold === 'backfill') await holdPageEmbedding(engine, id, ARCHIVE_BACKFILL_HOLD_REASON);
        else if (w.hold === 'open') await holdPageEmbedding(engine, id, ARCHIVE_OPEN_DAY_HOLD_REASON);
        else await releaseOpenDayHold(engine, null, [], id);
      }
    }
    if (w.ledger) await writeLedger(engine, w.ledger);
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export interface ArchiveStatus {
  enabled: boolean;
  source_id: string;
  timezone: string | null;
  configured_timezone: string;
  harnesses: Array<{ harness: string; reader: string; conversations: number; newest_session_day: string | null; newest_archived_day: string | null; info?: string }>;
  archived_days: number;
  held: Array<{ harness: string; day: string; code: string }>;
  legacy_days: number;
  errors: ArchiveReaderError[];
}

export async function archiveStatus(engine: BrainEngine, opts: { sourceId?: string; readers?: ArchiveReader[] } = {}): Promise<ArchiveStatus> {
  const { sourceId } = await effectiveSource(engine, opts.sourceId);
  const pinned = (await engine.getConfig(PIN_PREFIX + sourceId))?.trim() || null;
  const configured = (await engine.getConfig(ARCHIVE_TIMEZONE_KEY))?.trim() || machineTimeZone();
  const entries = await readArchiveLedger(engine, sourceId);
  const out: ArchiveStatus = {
    enabled: await archiveEnabled(engine), source_id: sourceId, timezone: pinned, configured_timezone: configured, harnesses: [],
    archived_days: entries.filter(e => e.hash && !e.held).length,
    held: entries.filter(e => e.held).map(e => ({ harness: e.harness, day: e.day, code: e.held!.code })),
    legacy_days: (await legacyCovered(engine, sourceId)).size, errors: [],
  };
  for (const reader of opts.readers ?? await defaultArchiveReaders()) {
    const archived = entries.filter(e => e.harness === reader.harness && e.hash).map(e => e.day).sort();
    const row = { harness: reader.harness, reader: reader.name, conversations: 0, newest_session_day: null as string | null, newest_archived_day: archived[archived.length - 1] ?? null };
    if (reader.unavailable) { out.harnesses.push({ ...row, info: reader.unavailable }); continue; }
    try {
      const zone = pinned ?? configured;
      let conversations = 0;
      let newest: string | undefined;
      for await (const entry of scanReader(reader, { dayOf: ts => localDay(ts, zone) })) {
        conversations++;
        if (entry.newest && (!newest || entry.newest > newest)) newest = entry.newest;
      }
      out.harnesses.push({ ...row, conversations, newest_session_day: newest ? localDay(newest, zone) : null,
        ...(conversations ? {} : { info: 'no readable sessions for ' + reader.harness + '; use gbrain connectors or an export with gbrain transcripts ingest' }) });
    } catch (err) {
      const e = err as { code?: string; message?: string; fix?: Action };
      out.errors.push({ harness: reader.harness, reader: reader.name, code: e.code ?? 'archive_reader_failed', message: e.message ?? String(err), ...(e.fix ? { fix: e.fix } : {}) });
      out.harnesses.push(row);
    }
  }
  return out;
}

// ── adopt-legacy ────────────────────────────────────────────────────────────

const HARNESSES: readonly string[] = ['claude-code', 'codex', 'openclaw', 'hermes', 'grok', 'chatgpt', 'claude-export'];

export interface LegacyDay { harness: string; day: string; file: string }
export interface AdoptLegacyResult { dir: string; source_id: string; applied: boolean; covered: LegacyDay[]; by_harness: Record<string, number> }

function legacyFiles(dir: string, base = dir, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) legacyFiles(path, base, depth + 1, out);
    else if (st.isFile()) out.push(path);
  }
  return out;
}

function frontmatterField(head: string, field: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return null;
  const line = new RegExp('^' + field + ':\\s*["\']?([^"\'\\r\\n]+)', 'm').exec(m[1]!);
  return line ? line[1]!.trim() : null;
}

/**
 * Reads an old archive folder's day files (a YYYY-MM-DD in the file name, else a date: in the frontmatter) and lists
 * the days they cover per harness (from a harness: field, a folder or file name naming one, else every harness). With
 * apply it records each day as covered-by-legacy, so run and backfill skip it. Never edits, moves or deletes a file.
 */
export async function adoptLegacyArchive(engine: BrainEngine, opts: { dir: string; apply: boolean; sourceId?: string }): Promise<AdoptLegacyResult> {
  const { sourceId } = await effectiveSource(engine, opts.sourceId);
  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
    const { opError } = await import('../ops/contract.ts');
    throw opError('invalid_params', opts.dir + ' is not a folder, so nothing was adopted.', 'Pass the old archive folder with --dir <folder>.');
  }
  const covered = new Map<string, LegacyDay>();
  for (const path of legacyFiles(opts.dir)) {
    const rel = relative(opts.dir, path).split(sep).join('/');
    let day = /(\d{4}-\d{2}-\d{2})/.exec(rel.split('/').pop()!)?.[1] ?? null;
    let head = '';
    if (/\.(md|markdown|txt)$/i.test(path)) {
      try { head = readFileSync(path, 'utf8').slice(0, 4096); } catch { head = ''; }
    }
    if (!day) day = frontmatterField(head, 'date')?.slice(0, 10) ?? null;
    if (!day || !DAY_RE.test(day) || Number.isNaN(Date.parse(day))) continue;
    const named = frontmatterField(head, 'harness');
    const harness = (named && HARNESSES.includes(named) ? named : null)
      ?? HARNESSES.find(h => rel.split('/').slice(0, -1).includes(h))
      ?? HARNESSES.find(h => rel.split('/').pop()!.includes(h))
      ?? '*';
    const key = harness + '.' + day;
    if (!covered.has(key)) covered.set(key, { harness, day, file: rel });
  }
  const list = [...covered.values()].sort((a, b) => a.day.localeCompare(b.day) || a.harness.localeCompare(b.harness));
  if (opts.apply) {
    for (const d of list) await engine.setConfig(LEGACY_PREFIX + sourceId + '.' + d.harness + '.' + d.day, JSON.stringify({ file: d.file, adopted_at: new Date().toISOString() }));
  }
  const by_harness: Record<string, number> = {};
  for (const d of list) by_harness[d.harness] = (by_harness[d.harness] ?? 0) + 1;
  return { dir: opts.dir, source_id: sourceId, applied: opts.apply, covered: list, by_harness };
}
