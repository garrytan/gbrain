/**
 * setup-history.ts: the preview-first history import 'gbrain setup' offers on a new personal install (onboarding
 * roadmap PR 1). Setup is engine-free, so it reaches this module through 'gbrain transcripts archive setup-import'
 * children; this module owns the brain-side rules.
 *
 *   - Trigger: one versioned install receipt in config (onboarding.install_receipt), written once, right after the
 *     setup run that created the brain and before anything else writes a page. It is eligible only when that run
 *     created the brain, no receipt existed, the brain held no page, the brain is personal (proven) with the archive
 *     on, and setup was not pinned to a source, a team or a member. An upgrade, a restored or imported brain, a pinned
 *     project and a team, shared or member-bound brain never get an eligible receipt, so nothing here runs for them.
 *   - Preview first: an explicit reader set (Claude Code, Codex and OpenClaw session files under the roots named by
 *     historyRoots, or one folder), never the default multi-harness or Gateway readers. A preview names the files it
 *     admitted under one bound (files, bytes per file, bytes in all); a decision stores those exact files, so the
 *     import reads only what the person saw. Stage latest is the newest session; stage range is up to 30 days.
 *   - Import: through the archive's own entry point (runTranscriptArchive, backfill mode), so its run lock, its
 *     audience re-read under that lock and its write paths apply (coordinator, git commit-push then sync, or the
 *     database on a repo-less brain); the audience is read again before each day is published. One deadline bounds
 *     discovery, parsing, redaction, admission and waiting; work not reached is reported partial with a resume action.
 *   - Links: the existing stale-extraction derivation (extractStaleFromDB) over the archive source, once per page
 *     revision (its watermark), never for a pending or opted-out write.
 *   - Card: real counts, each marked measured, off or unavailable, and three questions built from the person's own
 *     imported pages (no model call).
 * Nothing here calls a model provider, changes the archive switch or writes outside the archive source.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { discoverTranscriptFiles } from '../transcripts/discover.ts';
import { loadSession, parseFile } from '../transcripts/archive-readers.ts';
import {
  ARCHIVE_TIMEZONE_KEY, archiveEnabled, archiveMessageId, configuredSource, readArchiveLedger, resolvePrivacy, runTranscriptArchive,
  type ArchiveReader, type ArchiveRunOpts, type ArchiveRunResult, type ArchiveScanEntry,
} from '../transcripts/archive.ts';
import { addDays, localDay } from '../transcripts/archive-day.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { transcriptFullId, type TranscriptFormat } from '../transcripts/types.ts';

export const SETUP_HISTORY_VERSION = 1;
export const INSTALL_RECEIPT_KEY = 'onboarding.install_receipt';
/** One wall-clock budget for the whole history step of a setup run: discovery, import, links and the card. */
export const SETUP_HISTORY_BUDGET_MS = 20_000;
export const HISTORY_MAX_DAYS = 30;
export const HISTORY_DECISION_TTL_MS = 24 * 3_600_000;
export const HISTORY_LOCK_RETRIES = 2;
/** Admission bounds a preview applies; a file over fileBytes is never parsed (reported oversized). */
export const HISTORY_BOUNDS = { files: 500, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, messages: 20_000 };
export const HISTORY_HARNESSES = ['claude-code', 'codex', 'openclaw'] as const;
export type HistoryHarness = typeof HISTORY_HARNESSES[number];
export type HistoryStage = 'latest' | 'range';
export type IneligibleReason = 'existing_brain' | 'pages_present' | 'shared_brain' | 'audience_unproven' | 'archive_off' | 'pinned_source' | 'team_brain' | 'member_bound';

export interface HistoryFileRef { harness: HistoryHarness; path: string }
export interface PendingDecision { id: string; stage: HistoryStage; days: number; from: string; to: string; source_id: string; preview_id: string; files: HistoryFileRef[]; created_at: string; expires_at: string; consumed_at?: string }
export interface StageRecord {
  status: StageStatus; at: string; preview_id: string; from: string; to: string; sessions_imported: number; days_written: number;
  decision_id?: string; links?: LinksEffect['status']; projects?: Record<string, string>;
}
export interface InstallReceipt {
  version: 1; install_id: string; created_at: string; created_by: 'setup'; harness: string; eligible: boolean; reason?: IneligibleReason;
  stages: Partial<Record<HistoryStage, StageRecord>>; declined?: Partial<Record<HistoryStage, string>>; pending?: PendingDecision;
}

export type StageStatus = 'imported' | 'partial' | 'accepted' | 'nothing_found';
export interface LinksEffect {
  status: 'ready' | 'deferred' | 'off' | 'skipped' | 'failed';
  producer: 'managed_put_page' | 'legacy_db_import' | 'repo_archive_sync';
  reason?: string; links_created?: number; pages?: number; remaining?: number; pending_revisions?: number; fix?: Action;
}
export interface HistoryPreview {
  version: 1; stage: HistoryStage; days: number; from: string; to: string; source_id: string; preview_id: string;
  sessions: number; bytes: number; found: { sessions: number; bytes: number; oversized: number; capped: number };
  harnesses: Array<{ harness: HistoryHarness; root: string; sessions: number; bytes: number; oversized: number }>;
  latest?: { harness: HistoryHarness; day: string; project?: string };
  /** The files this preview admitted (the import reads only these). */
  files: HistoryFileRef[];
  destination: string; model_calls: 0;
  /** Stages already imported or declined on this install; setup does not offer them again. */
  answered: HistoryStage[];
}
export interface StageResult {
  version: 1; stage: HistoryStage; status: StageStatus | 'consumed'; exit: 0 | 10; source_id: string; from: string; to: string; preview_id: string;
  decision_id?: string; write_mode?: ArchiveRunResult['write_mode']; sessions_admitted: number; sessions_imported: number; days_written: number;
  days_unchanged: number; days_accepted: number; held: Array<{ harness: string; day: string; code: string }>;
  errors: Array<{ code: string; harness: string; day?: string }>; deferred_sessions: number; receipts: string[]; links: LinksEffect | null;
  budget: { budget_ms: number; used_ms: number; stopped_at_deadline: boolean }; lock_retries: number; resume?: Action;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw' };
export const harnessLabel = (h: string) => LABEL[h] ?? h;
const SEP = '\u0000';
const SETTLED = new Set(['written', 'unchanged', 'accepted', 'kept', 'skipped_legacy']);

/** Session roots the import reads: the harness's own folders, or one folder holding claude-code/, codex/ and openclaw/. */
export function historyRoots(opts: { dir?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): Array<{ harness: HistoryHarness; root: string }> {
  if (opts.dir) return HISTORY_HARNESSES.map(harness => ({ harness, root: join(opts.dir!, harness) }));
  const env = opts.env ?? {};
  const home = opts.home ?? homedir();
  return [
    { harness: 'claude-code', root: join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'projects') },
    { harness: 'codex', root: join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'sessions') },
    { harness: 'openclaw', root: join(home, '.openclaw', 'agents') },
  ];
}

export async function readInstallReceipt(engine: BrainEngine): Promise<InstallReceipt | null> {
  const raw = await engine.getConfig(INSTALL_RECEIPT_KEY);
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as InstallReceipt;
    return doc && doc.version === 1 && typeof doc.install_id === 'string' ? doc : null;
  } catch { return null; }
}

/** Read-modify-write of the receipt, compare-and-set on its stored text, so two setups never lose each other's change. */
async function updateReceipt(engine: BrainEngine, change: (r: InstallReceipt) => InstallReceipt): Promise<InstallReceipt> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await engine.getConfig(INSTALL_RECEIPT_KEY);
    const current = await readInstallReceipt(engine);
    if (!raw || !current) throw ineligible('existing_brain');
    const next = change(current);
    const rows = await engine.executeRaw('UPDATE config SET value = $1 WHERE key = $2 AND value = $3 RETURNING key', [JSON.stringify(next), INSTALL_RECEIPT_KEY, raw]);
    if (rows.length) return next;
  }
  throw new Error('the install receipt kept changing under this setup run; run setup again');
}

/** Why the brain is not (or no longer) eligible, or null. */
async function brainBlocker(engine: BrainEngine): Promise<IneligibleReason | null> {
  const privacy = await resolvePrivacy(engine);
  if (privacy.shared) return 'shared_brain';
  if (privacy.unproven) return 'audience_unproven';
  if (!await archiveEnabled(engine)) return 'archive_off';
  return null;
}

/**
 * Writes the install receipt once. Eligible only when this setup run created the brain, no receipt existed and the
 * brain holds no page, it is personal (proven) and the archive is on, and setup named no blocker (setupReason).
 */
export async function recordInstallReceipt(engine: BrainEngine, opts: { harness: string; createdBySetup: boolean; setupReason?: IneligibleReason; now?: Date }): Promise<{ receipt: InstallReceipt; created: boolean }> {
  const existing = await readInstallReceipt(engine);
  if (existing) return { receipt: existing, created: false };
  const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL');
  const reason: IneligibleReason | null = !opts.createdBySetup ? 'existing_brain' : opts.setupReason ?? (Number(n) > 0 ? 'pages_present' : await brainBlocker(engine));
  const receipt: InstallReceipt = {
    version: 1, install_id: randomUUID(), created_at: (opts.now ?? new Date()).toISOString(), created_by: 'setup', harness: opts.harness,
    eligible: reason === null, ...(reason ? { reason } : {}), stages: {},
  };
  const rows = await engine.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [INSTALL_RECEIPT_KEY, JSON.stringify(receipt)]);
  if (rows.length) return { receipt, created: true };
  return { receipt: (await readInstallReceipt(engine))!, created: false };
}

const INELIGIBLE_TEXT: Record<IneligibleReason, string> = {
  existing_brain: 'this brain was not created by a gbrain setup run (an upgrade, a restored or imported brain, or an older install)',
  pages_present: 'the brain already held pages when setup created its install receipt',
  shared_brain: 'the brain is shared (a team or several enabled members)',
  audience_unproven: 'whether the brain is shared could not be checked',
  archive_off: 'the conversation archive is off on this brain, and setup never turns it on',
  pinned_source: 'setup was pinned to a source (a project brain)',
  team_brain: 'setup was run for a team or several people',
  member_bound: 'this connection is bound to one member',
};

function ineligible(reason: IneligibleReason): Error {
  return opError('setup_history_ineligible', 'The setup history import is offered only on a new personal install, and ' + INELIGIBLE_TEXT[reason] + '; nothing was read or written.',
    'Import history yourself with gbrain transcripts archive backfill --from YYYY-MM-DD, or gbrain transcripts ingest <export>.', { reason });
}

/** The receipt, checked against the brain as it is now: eligible receipt, still personal, archive still on. */
export async function eligibleReceipt(engine: BrainEngine): Promise<InstallReceipt> {
  const receipt = await readInstallReceipt(engine);
  if (!receipt) throw ineligible('existing_brain');
  if (!receipt.eligible) throw ineligible(receipt.reason ?? 'existing_brain');
  const blocker = await brainBlocker(engine);
  if (blocker) throw ineligible(blocker);
  return receipt;
}

async function windowDays(engine: BrainEngine, days: number, now: Date): Promise<{ sourceId: string; from: string; to: string }> {
  const sourceId = await configuredSource(engine);
  const zone = (await engine.getConfig(`transcripts.archive.pinned_timezone.${sourceId}`))?.trim() || (await engine.getConfig(ARCHIVE_TIMEZONE_KEY))?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const to = localDay(now.toISOString(), zone);
  return { sourceId, from: addDays(to, -(days - 1)), to };
}

interface Discovered { harness: HistoryHarness; path: string; bytes: number; mtimeMs: number }

/** Every session file in the window under the roots, newest first, with the admission bounds applied. */
function discover(roots: Array<{ harness: HistoryHarness; root: string }>, fromDay: string, deadlineAtMs: number) {
  const floor = Date.parse(fromDay + 'T00:00:00.000Z') - 2 * 86_400_000;
  const all: Discovered[] = [];
  let oversized = 0;
  const per = new Map(roots.map(r => [r.harness, { harness: r.harness, root: r.root, sessions: 0, bytes: 0, oversized: 0 }]));
  for (const { harness, root } of roots) {
    if (Date.now() >= deadlineAtMs) break;
    for (const f of discoverTranscriptFiles([{ format: harness, root, extension: '.jsonl' }])) {
      let mtimeMs: number;
      try { mtimeMs = lstatSync(f.path).mtimeMs; } catch { continue; }
      if (mtimeMs < floor) continue;
      if (f.bytes > HISTORY_BOUNDS.fileBytes) { oversized++; per.get(harness)!.oversized++; continue; }
      all.push({ harness, path: f.path, bytes: f.bytes, mtimeMs });
    }
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const admitted: Discovered[] = [];
  let bytes = 0;
  for (const f of all) {
    if (admitted.length >= HISTORY_BOUNDS.files || bytes + f.bytes > HISTORY_BOUNDS.totalBytes) break;
    admitted.push(f);
    bytes += f.bytes;
    const row = per.get(f.harness)!;
    row.sessions++;
    row.bytes += f.bytes;
  }
  return { admitted, bytes, oversized, capped: all.length - admitted.length, per: [...per.values()] };
}

export const clampDays = (n: number) => Math.min(HISTORY_MAX_DAYS, Math.max(1, Math.floor(n)));

function previewId(installId: string, sourceId: string, stage: HistoryStage, from: string, to: string, files: HistoryFileRef[]): string {
  return sha(JSON.stringify([installId, sourceId, stage, from, to, files.map(f => f.harness + SEP + f.path)])).slice(0, 16);
}

/** A preview of one stage: what would be imported, from which roots, into which source. Parses only the newest file. */
export async function previewHistory(engine: BrainEngine, opts: { stage: HistoryStage; days?: number; dir?: string; env?: NodeJS.ProcessEnv; home?: string; now?: Date; deadlineAtMs?: number }): Promise<HistoryPreview> {
  const receipt = await eligibleReceipt(engine);
  const now = opts.now ?? new Date();
  const days = opts.stage === 'latest' ? HISTORY_MAX_DAYS : clampDays(opts.days ?? HISTORY_MAX_DAYS);
  const { sourceId, from, to } = await windowDays(engine, days, now);
  const found = discover(historyRoots(opts), from, opts.deadlineAtMs ?? Date.now() + SETUP_HISTORY_BUDGET_MS);
  const chosen = opts.stage === 'latest' ? found.admitted.slice(0, 1) : found.admitted;
  const files = chosen.map(f => ({ harness: f.harness, path: f.path }));
  let latest: HistoryPreview['latest'];
  const newest = found.admitted[0];
  if (newest) {
    let project: string | undefined;
    for await (const s of parseFile(newest.path, newest.harness)) { if (s.meta.cwd) project = basename(s.meta.cwd); break; }
    latest = { harness: newest.harness, day: localDay(new Date(newest.mtimeMs).toISOString(), 'UTC'), ...(project ? { project } : {}) };
  }
  return {
    version: 1, stage: opts.stage, days, from, to, source_id: sourceId, preview_id: previewId(receipt.install_id, sourceId, opts.stage, from, to, files),
    sessions: chosen.length, bytes: chosen.reduce((n, f) => n + f.bytes, 0),
    found: { sessions: found.admitted.length, bytes: found.bytes, oversized: found.oversized, capped: found.capped },
    harnesses: found.per, ...(latest ? { latest } : {}), files,
    destination: "the private source '" + sourceId + "' of this personal brain (conversations/<harness>/<day>/...)", model_calls: 0,
    answered: (['latest', 'range'] as const).filter(s => receipt.stages[s]?.status === 'imported' || receipt.declined?.[s]),
  };
}

/** Stores the preview as the one pending decision (replacing an unconsumed one), so an answer later imports exactly it. */
export async function offerHistoryDecision(engine: BrainEngine, preview: HistoryPreview, now = new Date()): Promise<PendingDecision> {
  const decision: PendingDecision = {
    id: randomUUID().slice(0, 13), stage: preview.stage, days: preview.days, from: preview.from, to: preview.to, source_id: preview.source_id, preview_id: preview.preview_id,
    files: preview.files, created_at: now.toISOString(), expires_at: new Date(now.getTime() + HISTORY_DECISION_TTL_MS).toISOString(),
  };
  await updateReceipt(engine, r => ({ ...r, pending: decision }));
  return decision;
}

/** A no for a stage: stored, so setup never asks it again; the pending decision for that stage is dropped. */
export async function declineHistory(engine: BrainEngine, stage: HistoryStage, now = new Date()): Promise<InstallReceipt> {
  await eligibleReceipt(engine);
  return updateReceipt(engine, r => {
    const { pending, ...rest } = r;
    return { ...rest, declined: { ...r.declined, [stage]: now.toISOString() }, ...(pending && pending.stage !== stage ? { pending } : {}) };
  });
}

export type DecisionClaim = { kind: 'claimed'; decision: PendingDecision } | { kind: 'consumed'; stage: HistoryStage; record?: StageRecord };

/** Consumes a pending decision once: a second answer gets the first one's record; an expired or unknown id is refused. */
async function claimDecision(engine: BrainEngine, id: string, now: Date, sourceId: string): Promise<DecisionClaim> {
  let claim: DecisionClaim | null = null;
  await updateReceipt(engine, r => {
    const done = (Object.entries(r.stages) as Array<[HistoryStage, StageRecord]>).find(([, rec]) => rec.decision_id === id);
    if (r.pending?.id === id && r.pending.consumed_at) { claim = { kind: 'consumed', stage: r.pending.stage, ...(done ? { record: done[1] } : {}) }; return r; }
    if (r.pending?.id !== id) {
      if (done) { claim = { kind: 'consumed', stage: done[0], record: done[1] }; return r; }
      throw opError('setup_history_decision_unavailable', 'No pending history import decision ' + id + ' exists on this brain (a newer preview replaced it, it was declined, or it belongs to another install); nothing was imported.',
        'Run gbrain setup again to preview the import and get a new decision.');
    }
    if (Date.parse(r.pending.expires_at) <= now.getTime()) {
      throw opError('setup_history_decision_expired', 'History import decision ' + id + ' expired at ' + r.pending.expires_at + ' before it was answered; nothing was imported.',
        'Run gbrain setup again to preview the import and get a new decision.');
    }
    if (r.pending.source_id !== sourceId) {
      throw opError('setup_history_decision_unavailable', 'History import decision ' + id + " was approved for the archive source '" + r.pending.source_id + "', but the archive source is now '" + sourceId + "'; nothing was imported.",
        "Run gbrain setup again to preview the import into '" + sourceId + "' and get a new decision.");
    }
    claim = { kind: 'claimed', decision: r.pending };
    return { ...r, pending: { ...r.pending, consumed_at: now.toISOString() } };
  });
  return claim!;
}

interface Seen { sessions: Map<string, string>; days: Map<string, string[]>; parsed: Set<string>; messages: number; stopped: boolean }

/** One reader per harness over exactly the admitted files, bounded by the deadline and the message bound. */
function boundedReaders(files: HistoryFileRef[], deadlineAtMs: number, seen: Seen): ArchiveReader[] {
  const byHarness = new Map<HistoryHarness, string[]>();
  for (const f of files) byHarness.set(f.harness, [...(byHarness.get(f.harness) ?? []), f.path]);
  return [...byHarness].map(([harness, paths]) => ({
    harness: harness as TranscriptFormat, name: harness + '-setup-history',
    async *scan({ dayOf }): AsyncGenerator<ArchiveScanEntry> {
      const found = new Map<string, { sessionId: string; dayIds: Map<string, Set<string>>; newest?: string; paths: string[] }>();
      for (const path of paths) {
        if (seen.stopped || Date.now() >= deadlineAtMs || seen.messages >= HISTORY_BOUNDS.messages) { seen.stopped = true; break; }
        for await (const session of parseFile(path, harness as TranscriptFormat)) {
          if (seen.messages > 0 && seen.messages + session.messages.length > HISTORY_BOUNDS.messages) { seen.stopped = true; break; }
          seen.messages += session.messages.length;
          const s = found.get(session.meta.sessionId) ?? { sessionId: session.meta.sessionId, dayIds: new Map<string, Set<string>>(), paths: [] };
          found.set(session.meta.sessionId, s);
          if (!s.paths.includes(path)) s.paths.push(path);
          seen.sessions.set(harness + SEP + session.meta.sessionId, session.meta.cwd ? basename(session.meta.cwd) : '');
          for (const m of session.messages) {
            if (!m.timestamp) continue;
            const day = dayOf(m.timestamp);
            s.dayIds.set(day, (s.dayIds.get(day) ?? new Set<string>()).add(archiveMessageId(m)));
            if (!s.newest || m.timestamp > s.newest) s.newest = m.timestamp;
          }
        }
        if (!seen.stopped) seen.parsed.add(path);
      }
      for (const s of found.values()) {
        seen.days.set(harness + SEP + s.sessionId, [...s.dayIds.keys()]);
        yield {
          harness: harness as TranscriptFormat, conversationKey: s.sessionId, sessionId: s.sessionId, via: 'file',
          days: [...s.dayIds.keys()], dayIds: Object.fromEntries([...s.dayIds].map(([d, ids]) => [d, [...ids]])), ...(s.newest ? { newest: s.newest } : {}),
          load: () => loadSession(harness as TranscriptFormat, s.sessionId, s.paths),
        };
      }
    },
  }));
}

export interface RunHistoryOpts {
  harness: string; stage?: HistoryStage; days?: number; decisionId?: string; dir?: string; env?: NodeJS.ProcessEnv; home?: string;
  deadlineAtMs: number; budgetMs?: number; noExtract?: boolean; now?: Date;
  makeContext?: (sourceId: string) => Promise<OperationContext>;
  archive?: Pick<ArchiveRunOpts, 'commitPaths' | 'syncSource' | 'redact'>;
}

const conversationKey = (k: string) => k.split(SEP)[0] + SEP + transcriptFullId(k.split(SEP)[1]!);

/**
 * Imports one stage: an answered decision (exactly its previewed files) or an explicit stage (previewed here). A
 * stage that finds nothing is recorded nothing_found (the no-history marker). Exit 10 when the coordinator accepted
 * days it has not published; 0 otherwise (partial included, with a resume action). Terminal failures throw.
 */
export async function runSetupHistory(engine: BrainEngine, opts: RunHistoryOpts): Promise<StageResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  await eligibleReceipt(engine);
  let stage: HistoryStage;
  let files: HistoryFileRef[];
  let window: { from: string; to: string; preview_id: string; days: number };
  let decisionId: string | undefined;
  const sourceId = await configuredSource(engine);
  if (opts.decisionId) {
    const claim = await claimDecision(engine, opts.decisionId, now, sourceId);
    if (claim.kind === 'consumed') return consumedResult(claim, sourceId, opts.decisionId);
    stage = claim.decision.stage;
    files = claim.decision.files.filter(f => { try { return lstatSync(f.path).isFile(); } catch { return false; } });
    window = { from: claim.decision.from, to: claim.decision.to, preview_id: claim.decision.preview_id, days: claim.decision.days };
    decisionId = claim.decision.id;
  } else {
    stage = opts.stage ?? 'latest';
    const preview = await previewHistory(engine, { stage, days: opts.days, dir: opts.dir, env: opts.env, home: opts.home, now, deadlineAtMs: opts.deadlineAtMs });
    files = preview.files;
    window = { from: preview.from, to: preview.to, preview_id: preview.preview_id, days: preview.days };
  }
  try {
    return await importStage(engine, opts, { stage, files, window, decisionId, sourceId, started, now });
  } catch (err) {
    if (decisionId) await releaseDecision(engine, decisionId).catch(() => { throw err; });
    throw err;
  }
}

/** A failed import hands its decision back, so answering it again imports; a decision with a stage record stays used. */
async function releaseDecision(engine: BrainEngine, id: string): Promise<void> {
  await updateReceipt(engine, r => {
    if (r.pending?.id !== id || !r.pending.consumed_at || Object.values(r.stages).some(rec => rec?.decision_id === id)) return r;
    const { consumed_at: _released, ...pending } = r.pending;
    return { ...r, pending };
  });
}

async function importStage(engine: BrainEngine, opts: RunHistoryOpts, s: {
  stage: HistoryStage; files: HistoryFileRef[]; window: { from: string; to: string; preview_id: string; days: number }; decisionId?: string; sourceId: string; started: number; now: Date;
}): Promise<StageResult> {
  const { stage, files, window, decisionId, sourceId, started, now } = s;
  const base: StageResult = {
    version: 1, stage, status: 'nothing_found', exit: 0, source_id: sourceId, from: window.from, to: window.to, preview_id: window.preview_id,
    ...(decisionId ? { decision_id: decisionId } : {}), sessions_admitted: files.length, sessions_imported: 0, days_written: 0, days_unchanged: 0,
    days_accepted: 0, held: [], errors: [], deferred_sessions: 0, receipts: [], links: null,
    budget: { budget_ms: opts.budgetMs ?? Math.max(0, opts.deadlineAtMs - started), used_ms: 0, stopped_at_deadline: false }, lock_retries: 0,
  };
  if (!files.length) {
    base.budget.used_ms = Date.now() - started;
    await recordStage(engine, base, {});
    return base;
  }
  const seen: Seen = { sessions: new Map<string, string>(), days: new Map<string, string[]>(), parsed: new Set<string>(), messages: 0, stopped: false };
  let run: ArchiveRunResult;
  const attempt = () => runTranscriptArchive(engine, {
    mode: 'backfill', sourceId, from: window.from, to: window.to, now, readers: boundedReaders(files, opts.deadlineAtMs, seen), deadlineAtMs: opts.deadlineAtMs,
    recheckAudienceEachDay: true, ...(opts.makeContext ? { makeContext: opts.makeContext } : {}), ...opts.archive,
  }).then(r => ({ ok: true as const, r }), (err: unknown) => ({ ok: false as const, err }));
  for (let a = await attempt(); ; a = await attempt()) {
    if (a.ok) { run = a.r; break; }
    const busy = (a.err as { code?: string }).code === 'archive_run_busy';
    if (!busy || base.lock_retries >= HISTORY_LOCK_RETRIES || Date.now() + 500 >= opts.deadlineAtMs) throw a.err;
    base.lock_retries++;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!run.enabled) throw ineligible('archive_off');
  const imported = new Set<string>();
  for (const d of run.days) {
    if (d.harness === 'index') continue;
    if (d.status === 'written' || d.status === 'unchanged' || d.status === 'accepted' || d.status === 'kept') imported.add(d.harness + SEP + d.conversation_key_hash);
    if (d.status === 'held') base.held.push({ harness: d.harness, day: d.day, code: d.code ?? 'held' });
  }
  base.write_mode = run.write_mode;
  base.days_written = run.written;
  base.days_unchanged = run.unchanged;
  base.days_accepted = run.accepted;
  base.errors = run.errors.map(e => ({ code: e.code, harness: e.harness, ...(e.day ? { day: e.day } : {}) }));
  const withRow = new Set(run.days.filter(d => d.harness !== 'index' && SETTLED.has(d.status)).map(d => d.harness + SEP + d.conversation_key_hash));
  const deferredDays = new Set(run.deferred_days);
  const ledger = new Map((await readArchiveLedger(engine, run.source_id)).map(e => [e.harness + SEP + e.conversation_key_hash + SEP + e.day, e]));
  let deferred = files.filter(f => !seen.parsed.has(f.path)).length;
  for (const [k, days] of seen.days) {
    const key = conversationKey(k);
    const inWindow = days.filter(d => d >= run.from && d <= run.to);
    if (!inWindow.length || withRow.has(key)) continue;
    const archived = !inWindow.some(d => deferredDays.has(d)) && inWindow.every(d => { const e = ledger.get(key + SEP + d); return !!e?.hash && e.complete && !e.held; });
    if (archived) imported.add(key);
    else deferred++;
  }
  base.sessions_imported = imported.size;
  base.deferred_sessions = deferred;
  base.budget.stopped_at_deadline = run.stopped_at_deadline === true || seen.stopped;
  if (imported.size === 0 && run.errors.length) {
    throw opError('setup_history_failed', 'The setup history import wrote nothing: ' + run.errors.map(e => e.code + ' (' + e.harness + ')').slice(0, 5).join(', ') + '.',
      'Run gbrain transcripts archive status for each reader\'s error, then run gbrain setup again.');
  }
  if (run.accepted) {
    const accepted = new Set(run.days.filter(d => d.status === 'accepted').map(d => d.harness + SEP + d.conversation_key_hash + SEP + d.day));
    base.receipts = [...new Set([...ledger.values()].filter(e => e.pending && accepted.has(e.harness + SEP + e.conversation_key_hash + SEP + e.day)).flatMap(e => e.pending!.requests))];
  }
  base.links = await linksEffect(engine, run, opts, base);
  base.status = run.accepted ? 'accepted' : base.budget.stopped_at_deadline || base.deferred_sessions > 0 || run.errors.length ? 'partial' : imported.size ? 'imported' : 'nothing_found';
  base.exit = run.accepted ? 10 : 0;
  if (base.status === 'partial') {
    base.resume = { argv: ['gbrain', 'setup', opts.harness, '--history', stage === 'latest' ? 'latest' : String(window.days), ...(opts.dir ? ['--history-dir', opts.dir] : []), ...(opts.noExtract ? ['--no-extract'] : [])], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Runs the same import again: days already written stay unchanged, and the sessions this run did not reach are read.' } as Action;
  }
  base.budget.used_ms = Date.now() - started;
  const projects: Record<string, string> = {};
  for (const [k, project] of seen.sessions) if (project) projects[conversationKey(k).replace(SEP, ':')] = project;
  await recordStage(engine, base, projects);
  return base;
}

function consumedResult(claim: Extract<DecisionClaim, { kind: 'consumed' }>, sourceId: string, id: string): StageResult {
  const r = claim.record;
  return {
    version: 1, stage: claim.stage, status: 'consumed', exit: 0, source_id: sourceId, from: r?.from ?? '', to: r?.to ?? '', preview_id: r?.preview_id ?? '', decision_id: id,
    sessions_admitted: 0, sessions_imported: r?.sessions_imported ?? 0, days_written: 0, days_unchanged: 0, days_accepted: 0, held: [], errors: [], deferred_sessions: 0,
    receipts: [], links: null, budget: { budget_ms: 0, used_ms: 0, stopped_at_deadline: false }, lock_retries: 0,
  };
}

async function recordStage(engine: BrainEngine, result: StageResult, projects: Record<string, string>): Promise<void> {
  const rec: StageRecord = {
    status: result.status as StageStatus, at: new Date().toISOString(), preview_id: result.preview_id, from: result.from, to: result.to,
    sessions_imported: result.sessions_imported, days_written: result.days_written, ...(result.decision_id ? { decision_id: result.decision_id } : {}),
    ...(result.links ? { links: result.links.status } : {}),
  };
  await updateReceipt(engine, r => ({ ...r, stages: { ...r.stages, [result.stage]: { ...rec, projects: { ...r.stages[result.stage]?.projects, ...projects } } } }));
}

/**
 * The graph for what this stage published: the existing stale-extraction derivation over the archive source (one
 * effect per page revision: its watermark). Off for an explicit --no-extract or auto_link off; skipped when nothing
 * was published; pending coordinator writes get no effect until they commit.
 */
async function linksEffect(engine: BrainEngine, run: ArchiveRunResult, opts: RunHistoryOpts, result: StageResult): Promise<LinksEffect> {
  const producer: LinksEffect['producer'] = run.write_mode === 'coordinator' ? 'managed_put_page' : run.write_mode === 'repo' ? 'repo_archive_sync' : 'legacy_db_import';
  const pending = run.accepted ? { pending_revisions: run.accepted } : {};
  const fix = { argv: ['gbrain', 'extract', '--stale', '--source-id', run.source_id], consent: [], actor: 'agent', requires_exclusive: false, why: 'Builds the links of the archive pages this import wrote (keyless, no model call).' } as Action;
  if (opts.noExtract) return { status: 'off', producer, reason: 'no_extract', ...pending, fix };
  const { isAutoLinkEnabled } = await import('../link-extraction.ts');
  if (!await isAutoLinkEnabled(engine)) return { status: 'off', producer, reason: 'auto_link_off', ...pending };
  if (run.written === 0) return { status: 'skipped', producer, reason: run.accepted ? 'pending_publication' : 'nothing_published', ...pending };
  const remaining = opts.deadlineAtMs - Date.now();
  if (remaining < 250) return { status: 'deferred', producer, reason: 'budget', ...pending, fix };
  try {
    const { extractStaleFromDB } = await import('../../commands/extract.ts');
    const r = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: run.source_id, catchUp: false, timeBudgetMs: remaining });
    const ready = r.staleRemaining === 0;
    return { status: ready ? 'ready' : 'deferred', producer, links_created: r.linksCreated, pages: r.pagesProcessed, remaining: r.staleRemaining, ...pending, ...(ready ? {} : { reason: 'budget', fix }) };
  } catch (err) {
    result.errors.push({ code: 'setup_history_links_failed', harness: '*' });
    return { status: 'failed', producer, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200), ...pending, fix };
  }
}

// The setup card.

export type CardStatus = 'measured' | 'off' | 'unavailable';
export interface CardRow { key: 'conversations' | 'harnesses' | 'projects' | 'links' | 'people' | 'companies'; value: number | null; status: CardStatus; reason?: string; by_harness?: Record<string, number> }
export interface CardQuestion { text: string; harness: string; day: string; project?: string; cross_harness: boolean; from: 'decision_line' | 'title' }
export interface HistoryCard { version: 1; source_id: string; rows: CardRow[]; questions: CardQuestion[]; no_history: boolean }

const DECISION_RE = /\b(decided|agreed|chose|settled on|going with|switched to|switch to)\b([^.\n]{6,160})/i;
const TRAILING_STOP = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'under', 'at', 'by', 'or', 'from']);
const INSTRUCTION_RE = /\b(ignore|disregard|instructions?|system prompt|you must|you should|always|never|execute|sudo|curl|token|password|secret|api key|credentials?)\b/i;

/** A short topic from a decision-like line, or null; instruction-worded lines never become a question. */
export function decisionTopic(line: string): string | null {
  if (INSTRUCTION_RE.test(line)) return null;
  const m = DECISION_RE.exec(line);
  if (!m) return null;
  const kept: string[] = [];
  for (const w of m[2]!.replace(/[^A-Za-z0-9 ._/-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(to|on|with|that) /i, '').split(' ').slice(0, 9)) {
    if ([...kept, w].join(' ').length > 60) break;
    kept.push(w);
  }
  while (kept.length && TRAILING_STOP.has(kept.at(-1)!.toLowerCase())) kept.pop();
  const words = kept.join(' ');
  return words.length >= 6 ? words : null;
}

/** What the brain holds after the import, each row measured, off or unavailable, plus three questions from the person's own pages. */
export async function historyCard(engine: BrainEngine, opts: { harness: string }): Promise<HistoryCard> {
  const sourceId = await configuredSource(engine);
  const receipt = await readInstallReceipt(engine);
  const convRows = await engine.executeRaw<{ harness: string | null; n: number | string }>(
    "SELECT frontmatter->'transcript_archive'->>'harness' AS harness, count(DISTINCT frontmatter->'transcript_archive'->>'conversation_key_hash')::int AS n FROM pages "
    + "WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'conversations/%' AND slug NOT LIKE 'conversations/days/%' GROUP BY 1", [sourceId]);
  const byHarness: Record<string, number> = {};
  for (const r of convRows) if (r.harness) byHarness[r.harness] = Number(r.n);
  const total = Object.values(byHarness).reduce((a, b) => a + b, 0);
  const rows: CardRow[] = [
    { key: 'conversations', value: total, status: 'measured', by_harness: byHarness },
    { key: 'harnesses', value: Object.keys(byHarness).length, status: 'measured' },
  ];
  const known = new Set<string>();
  for (const rec of Object.values(receipt?.stages ?? {})) for (const p of Object.values(rec?.projects ?? {})) if (p) known.add(p);
  rows.push(known.size ? { key: 'projects', value: known.size, status: 'measured' } : { key: 'projects', value: null, status: 'unavailable', reason: 'no project folder recorded' });
  const stages = Object.values(receipt?.stages ?? {}).filter(s => s && s.status !== 'nothing_found');
  if (stages.length > 0 && stages.every(s => s!.links === 'off')) rows.push({ key: 'links', value: null, status: 'off', reason: 'link extraction was off for this import' });
  else {
    const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.source_id = $1', [sourceId]);
    rows.push({ key: 'links', value: Number(n), status: 'measured' });
  }
  const kinds = await engine.executeRaw<{ type: string; n: number | string }>("SELECT type, count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND type IN ('person', 'company') GROUP BY type");
  for (const k of kinds) if (Number(k.n) > 0) rows.push({ key: k.type === 'person' ? 'people' : 'companies', value: Number(k.n), status: 'measured' });
  return { version: 1, source_id: sourceId, rows, questions: await cardQuestions(engine, sourceId, opts.harness, receipt), no_history: total === 0 };
}

async function cardQuestions(engine: BrainEngine, sourceId: string, harness: string, receipt: InstallReceipt | null): Promise<CardQuestion[]> {
  const pages = await engine.executeRaw<{ frontmatter: unknown; lead: string | null }>(
    'SELECT p.frontmatter, ' + boundedBodyPrefixSql('p') + " AS lead FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug LIKE 'conversations/%' AND p.slug NOT LIKE 'conversations/days/%' "
    + "ORDER BY p.frontmatter->>'date' DESC, p.slug LIMIT 200", [sourceId]);
  const projects: Record<string, string> = {};
  for (const rec of Object.values(receipt?.stages ?? {})) Object.assign(projects, rec?.projects ?? {});
  const decisions: CardQuestion[] = [];
  const titles: CardQuestion[] = [];
  for (const p of pages) {
    const fm = (typeof p.frontmatter === 'string' ? JSON.parse(p.frontmatter) : p.frontmatter) as { date?: string; transcript_archive?: { harness?: string; conversation_key_hash?: string } };
    const h = fm.transcript_archive?.harness ?? 'unknown';
    const day = fm.date ?? '';
    const project = projects[h + ':' + (fm.transcript_archive?.conversation_key_hash ?? '')] || undefined;
    const where = project ? ' (project ' + project + ')' : '';
    const base = { harness: h, day, ...(project ? { project } : {}), cross_harness: h !== harness };
    const topic = (p.lead ?? '').split('\n').map(decisionTopic).find((t): t is string => !!t);
    if (topic) decisions.push({ ...base, text: 'What did I decide in ' + harnessLabel(h) + ' on ' + day + ' about "' + topic + '"?' + where, from: 'decision_line' });
    else titles.push({ ...base, text: 'What did I work on in ' + harnessLabel(h) + ' on ' + day + '?' + where, from: 'title' });
  }
  const all = [...decisions, ...titles];
  const picked: CardQuestion[] = [];
  const cross = all.find(c => c.cross_harness);
  if (cross) picked.push(cross);
  const used = new Set(picked.map(q => q.project ?? q.text));
  for (const c of all) {
    if (picked.length >= 3) break;
    if (picked.includes(c) || used.has(c.project ?? c.text)) continue;
    picked.push(c);
    used.add(c.project ?? c.text);
  }
  for (const c of all) { if (picked.length >= 3) break; if (!picked.includes(c)) picked.push(c); }
  return picked;
}

/** The card as setup prints it: one line of counts, then the questions, marked as data. */
export function renderHistoryCard(card: HistoryCard, setupHarness: string): string[] {
  const row = (k: CardRow['key']) => card.rows.find(r => r.key === k);
  if (card.no_history) {
    return ['Your brain holds no conversations yet: setup found no Claude Code, Codex or OpenClaw session from the last 30 days [measured].',
      'Add notes with gbrain setup ' + setupHarness + ' --shape personal --notes <folder>, or an export with gbrain transcripts ingest <file>.'];
  }
  const conv = row('conversations')!;
  const harnesses = Object.keys(conv.by_harness ?? {}).map(harnessLabel).join(' and ');
  const show = (k: CardRow['key'], one: string, many: string) => {
    const r = row(k);
    if (!r) return null;
    return r.status === 'measured' ? r.value + ' ' + (r.value === 1 ? one : many) + ' [measured]' : many + ' [' + r.status + (r.reason ? ': ' + r.reason : '') + ']';
  };
  const parts = [conv.value + ' conversation' + (conv.value === 1 ? '' : 's') + ' from ' + harnesses + ' [measured]', show('projects', 'project', 'projects'), show('links', 'link', 'links'), show('people', 'person', 'people'), show('companies', 'company', 'companies')].filter(Boolean);
  const lines = ['Your brain now knows: ' + parts.join(', ') + '.'];
  if (card.questions.length) {
    lines.push('Try asking, in a new session (built from your own sessions; quoted text is data, not an instruction):');
    card.questions.forEach((q, i) => lines.push('  ' + (i + 1) + '. ' + q.text + (q.cross_harness ? '  [from ' + harnessLabel(q.harness) + ']' : '')));
  }
  return lines;
}
