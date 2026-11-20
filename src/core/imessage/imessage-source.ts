/**
 * The imessage source sweep (`sources.config.kind = 'imessage'`): one private page per chat per day, read from the
 * GBrain Helper on this Mac over 127.0.0.1 (apple/helper-client.ts).
 *
 * Coverage is per chat (`connectors/api-source.ts` windows). A run reads each recent chat's window [from, to): `from`
 * is aligned to the start of a day in the source's time zone, so every day the window touches is read whole and its
 * page rebuilt from scratch. After the first window, the next starts `lookbackDays` before the boundary, so an edit or
 * an unsend in recent days converges and the facts extracted from the changed page are retired. A day whose messages
 * are unchanged (the fingerprint) publishes nothing, so a second run over the same messages writes nothing. A message
 * deleted on the phone after the lookback stays until the page is deleted by hand (in the owned folder, until the
 * source is removed).
 *
 * Privacy: every page is `visibility: private` and the source is owner-only (access/owner-only.ts), decided at read
 * time from the source's kind; `source_kind: imessage` keeps every copy at the external-untrusted trust tier.
 *
 * Record (GST-3022): on a personal, unmanaged brain whose default source is a Git checkout, every chat-day page is also
 * a file under `.gbrain-owned/<id>/` in that checkout (owned-folder/), written by one commit per run before the
 * database rows, and pushed the way every other page is. Anywhere else the pages are database-only and the run says
 * why (owned-folder/destination.ts). In the folder, a day file is removed only when the helper positively reported the
 * day empty inside the window it read, and a run that would remove more than 20 day files, or more than a tenth of
 * them, removes none and says so.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';
import { withConnectorSync, pendingConnectorResult, type ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { connectorIdentity } from '../persistence/connector-identity.ts';
import { ConnectorHoldSession, connectorHoldsResult } from '../connectors/connector-hold-session.ts';
import { connectorDbCursorKey, readConnectorDbCursor, writeConnectorDbCursor } from '../connectors/db-cursor.ts';
import { resolveApiToken } from '../connectors/credentials.ts';
import { connectorRender } from '../connectors/connector-text.ts';
import {
  afterConnectorPublish, closeCoverageWindow, connectorDryRunResult, deleteConnectorPage, openCoverageWindow, publishConnectorPage, runScoped,
  type ConnectorPublishCtx, type CoverageWindow, type PublishSummary,
} from '../connectors/api-source.ts';
import { slugifyPath } from '../sync.ts';
import { nextSlackDay, slackAlignToDay, slackDayKey, slackDayStartMs } from '../slack/render.ts';
import { IMESSAGE_THREADS_LIMIT, helperNotRunning, imessageHelper, type IMessageHelper } from '../apple/helper-client.ts';
import { imessageChatKey, imessageDayFingerprint, imessagePagePath, renderIMessageDay, shownMessages } from './render.ts';
import { connectorSpeakerOwnerStamp, type SpeakerOwnerStamp } from '../identity/speaker-owner.ts';
import { IMESSAGE_HELPER_PORT_KEY, type IMessageMessage, type IMessageSourceConfig, type IMessageThread } from './types.ts';
import { resolveOwnedDestination, type OwnedDatabaseOnlyReason } from '../owned-folder/destination.ts';
import { git } from '../git/git-run.ts';
import { adoptRedactions, commitOwnedBatch, ownedConflict, OWNER_FILE, readOwnedState, README_FILE, writeOwnedState, type OwnedFolderState, type OwnedHold } from '../owned-folder/writer.ts';
import { ownedFolderRel } from '../owned-folder/paths.ts';

export interface IMessageChatState {
  committed_to: string | null;
  window: CoverageWindow | null;
  /** Days published in the lookback horizon: the page path and the fingerprint it was rendered from. */
  days: Record<string, { path: string; fp: string }>;
}

/** Where the last run put the pages, for `gbrain sources status` (pages_in). */
export interface IMessageRecordStatus {
  record: 'folder' | 'database';
  folder: string | null;
  reason: OwnedDatabaseOnlyReason | null;
  detail: string | null;
  checked_at: string;
}

export interface IMessageState extends Record<string, unknown> {
  /** Keyed by the handle-free chat key, so no handle is stored in the cursor. */
  chats: Record<string, IMessageChatState>;
  item_holds?: unknown;
  /** The owned folder's record (GST-3022): what this source last committed there, saved in its own row (readOwnedState). */
  owned?: OwnedFolderState & { held?: Record<string, OwnedHold> };
  record_status?: IMessageRecordStatus;
}

/** A day file removal this run holds back: more than this many day files, or more than this share of them. */
export const OWNED_MASS_REMOVAL_DAYS = 20;
export const OWNED_MASS_REMOVAL_SHARE = 0.1;

type DayOp =
  | { op: 'write'; key: string; chatKey: string; day: string; relPath: string; markdown: string; fp: string }
  | { op: 'delete'; key: string; chatKey: string; day: string; relPath: string; positive: boolean };

const emptyState = (): IMessageState => ({ chats: {} });

export interface IMessageSyncDeps {
  /** Test seam: a helper bound to a fake transport. */
  helper?: IMessageHelper;
  now?: () => number;
}

interface Summary extends PublishSummary { status: 'synced' | 'partial'; failedFiles: number }

export function imessageAuthRequired(sourceId: string, cfg: Pick<IMessageSourceConfig, 'tokenEnv'>): OperationError {
  return new OperationError('apple_helper_unauthorized', `iMessage source ${sourceId} has no GBrain Helper token. Nothing was imported.`,
    cfg.tokenEnv ? `Set ${cfg.tokenEnv} to the helper's token in the environment that runs the sync, then run: gbrain sync --source ${sourceId}`
      : `Save the helper's token for gbrain (GBRAIN_CONNECTOR_IMESSAGE_TOKEN, or the 0600 file ~/.gbrain/connectors/imessage.json), then run: gbrain sync --source ${sourceId}`,
    'docs/guides/apple-setup.md#apple_helper_unauthorized');
}

/** A helper failure that stops the run (helper down, token refused, no Full Disk Access, an unknown database), never one chat. */
const stopsRun = (error: unknown) => runScoped(error) || (error instanceof OperationError && error.code.startsWith('apple_'));

async function helperPort(engine: BrainEngine): Promise<number | null> {
  const raw = (await engine.getConfig(IMESSAGE_HELPER_PORT_KEY).catch(() => null))?.trim();
  const port = raw ? Number(raw) : NaN;
  return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/** A committed day file a run changes in the database only is stale: held, so the next folder run rewrites it and a rebuild skips it. */
function staleHolds(recorded: Record<string, string>, paths: string[], detail: string): Record<string, OwnedHold> {
  return Object.fromEntries(paths.filter(p => recorded[p]).map(p => [p, { code: 'owned_folder_conflict' as const, detail }]));
}

export async function runIMessageSync(engine: BrainEngine, sourceId: string, cfg: IMessageSourceConfig, opts: SyncOpts, deps: IMessageSyncDeps = {}): Promise<SyncResult> {
  return withConnectorSync(engine, sourceId, 'imessage', cfg, opts,
    async (managed, options) => options.dryRun ? connectorDryRunResult('iMessage', sourceId) : runIMessageSyncInner(engine, sourceId, cfg, options, managed, deps, await connectorSpeakerOwnerStamp(engine, sourceId)), pendingConnectorResult);
}

async function runIMessageSyncInner(engine: BrainEngine, sourceId: string, cfg: IMessageSourceConfig, opts: SyncOpts,
  managed: ManagedConnectorSync | null, deps: IMessageSyncDeps, ownerStamp: SpeakerOwnerStamp | null): Promise<SyncResult> {
  const now = deps.now ?? Date.now;
  const runStart = now();
  const runId = randomUUID();
  let helper = deps.helper;
  const signal = opts.signal;
  // With --full and no helper on this Mac, the run rebuilds the database pages from the owned folder (below).
  let unreachable: OperationError | null = null;
  let threads: IMessageThread[] = [];
  try {
    if (!helper) {
      const port = await helperPort(engine);
      if (port === null) throw helperNotRunning(sourceId, null, `config ${IMESSAGE_HELPER_PORT_KEY} is not set`);
      const key = resolveApiToken('imessage', cfg.tokenEnv);
      if (!key) throw imessageAuthRequired(sourceId, cfg);
      helper = imessageHelper({ sourceId, port, token: key.token });
    }
    threads = await helper.threads(signal);
  } catch (error) {
    if (!opts.full || !(error instanceof OperationError) || error.code !== 'apple_helper_not_running') throw error;
    unreachable = error;
  }

  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]);
  const identity = connectorIdentity('imessage', source.config, source.local_path);
  const cursorKey = connectorDbCursorKey(sourceId, source.incarnation, identity);
  const state: IMessageState = managed ? { ...emptyState(), ...managed.state<IMessageState>(emptyState()) }
    : { ...emptyState(), ...(await readConnectorDbCursor(engine, cursorKey)).state as IMessageState | null, owned: await readOwnedState(engine, sourceId, source.incarnation, 'imessage') };

  const chatsBefore = structuredClone(state.chats);
  const summary: Summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], factsRetired: 0, failedFiles: 0 };
  const holds = await ConnectorHoldSession.open(engine, sourceId, managed, emptyState(), state.item_holds, { full: opts.full });
  const newest = () => Object.values(state.chats).map(c => c.committed_to).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const save = async (final: boolean) => {
    if (managed) {
      await managed.saveState(state, final && summary.status === 'synced', final ? newest() ?? undefined : undefined);
      return;
    }
    if (state.owned) await writeOwnedState(engine, sourceId, 'imessage', state.owned);
    await writeConnectorDbCursor(engine, cursorKey, { ...state, owned: undefined }, final ? { run_id: runId, finished_at: new Date(now()).toISOString(),
      counts: { added: summary.added, modified: summary.modified, deleted: summary.deleted, facts_retired: summary.factsRetired, failed: summary.failedFiles } } : undefined);
  };
  // The database rows are imported after the run's one commit (owned-folder/writer.ts); the import itself is database-mode.
  const ctx: ConnectorPublishCtx = { engine, sourceId, managed, summary, label: 'iMessage', tag: 'imessage', record: 'database', dir: null, gated: true };
  const owned = state.owned?.incarnation === source.incarnation ? state.owned : undefined;
  const destination = managed
    ? { record: 'database' as const, reason: 'managed' as const, detail: 'the brain is managed by its coordinator', root: null }
    : await resolveOwnedDestination(engine, sourceId, owned?.push_urls ?? null);
  if (owned && destination.root) adoptRedactions(destination.root, ownedFolderRel(sourceId), owned);
  state.record_status = { record: destination.record, folder: destination.record === 'folder' ? ownedFolderRel(sourceId) : null,
    reason: destination.record === 'database' ? destination.reason : null, detail: destination.record === 'database' ? destination.detail : null,
    checked_at: new Date(now()).toISOString() };
  const ownedDays = Object.keys(owned?.files ?? {}).filter(p => p !== OWNER_FILE && p !== README_FILE).length;
  if (destination.record === 'database' && destination.reason !== 'no_repository' && destination.reason !== 'managed') {
    process.stderr.write(`[gbrain notice owned_folder_database_only] iMessage source ${sourceId}: pages stay in the database only because ${destination.detail}.${
      ownedDays ? ` The ${ownedDays} day file(s) committed under ${ownedFolderRel(sourceId)}/ earlier stay there; gbrain sources remove ${sourceId} removes them.` : ''}${
      destination.reason === 'remote_changed' ? ` If the new destination is right, run: gbrain sources rebind ${sourceId}` : ''}\n`);
  }
  /** Imports every day file this source committed, from the blob it recorded, skipping held days; asks nothing of the Mac. */
  const rebuildFromFolder = async (root: string): Promise<SyncResult> => {
    const held = owned?.held ?? {};
    const rel = ownedFolderRel(sourceId);
    for (const [path, blob] of Object.entries(owned!.files)) {
      const m = /^imessage\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
      if (!m || held[path]) continue;
      const [, chatKey, day] = m as unknown as [string, string, string];
      await handle(`${chatKey}/${day}`, async () => {
        const bytes = git(root, ['cat-file', 'blob', blob]);
        if (bytes.code !== 0) throw ownedConflict(`${rel}/${path}`, 'has no committed copy gbrain can read', sourceId);
        await publishConnectorPage(ctx, { relPath: path, markdown: bytes.stdout, commitMessage: `imessage(${sourceId}): ${chatKey} ${day}`,
          privateMessage: `imessage(${sourceId}): ${chatKey} ${day} is private; database only`, retireReason: 'the iMessage day was rebuilt from the owned folder' });
      }, slugifyPath(path));
    }
    if (summary.failedFiles > 0) summary.status = 'partial';
    state.item_holds = holds.finish();
    await save(false);
    await holds.complete();
    process.stderr.write(`[gbrain notice imessage_rebuilt_from_folder] iMessage source ${sourceId}: the helper on this Mac is not reachable (${unreachable!.message}), so the database pages were rebuilt from ${rel}/${Object.keys(held).length ? `, leaving out ${Object.keys(held).length} held day(s)` : ''}. Nothing new was read from Messages.\n`);
    await afterConnectorPublish(ctx, opts);
    return { status: summary.status === 'partial' ? 'partial' : summary.added + summary.modified > 0 ? 'synced' : 'up_to_date',
      fromCommit: null, toCommit: '', added: summary.added, modified: summary.modified, deleted: 0, renamed: 0,
      chunksCreated: summary.chunksCreated, embedded: summary.embedded, pagesAffected: summary.pagesAffected,
      ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles, filesImported: summary.added + summary.modified, reason: 'connector_item_failures' as const } : {}),
      ...connectorHoldsResult(sourceId, holds.summary()) };
  };
  const ops: DayOp[] = [];
  const horizons = new Map<string, number>();
  const heldPaths = new Set(Object.keys(owned?.held ?? {}));
  const handle = async (key: string, work: () => Promise<void>, slug: string | null): Promise<boolean> => {
    try { await work(); holds.succeed(key); return true; } catch (error) {
      if (stopsRun(error)) throw error;
      summary.failedFiles++;
      await holds.fail(key, error, { slug });
      return false;
    }
  };
  if (unreachable) {
    if (destination.record !== 'folder' || !ownedDays) throw unreachable;
    return rebuildFromFolder(destination.root);
  }

  /** Queues a day page; the run commits every queued file at once, then imports the rows (applyOp). */
  const publishDay = (thread: IMessageThread, chatKey: string, day: string, messages: IMessageMessage[], fp: string) => {
    const relPath = imessagePagePath(chatKey, day);
    ops.push({ op: 'write', key: `${chatKey}/${day}`, chatKey, day, relPath, fp,
      markdown: connectorRender(renderIMessageDay({ thread, chatKey, day, timezone: cfg.timezone, messages, ...(ownerStamp ? { owner: ownerStamp } : {}) }), { path: relPath, imessage_chat: chatKey }) });
  };

  /** `positive`: the helper reported the day empty inside a window it read (a listed chat), not a guess from an unlisted one. */
  const deleteDay = (chatKey: string, day: string, positive: boolean) => {
    const entry = state.chats[chatKey]!.days[day];
    ops.push({ op: 'delete', key: `${chatKey}/${day}`, chatKey, day, relPath: entry?.path ?? imessagePagePath(chatKey, day), positive });
  };

  const applyOp = async (op: DayOp) => {
    if (op.op === 'write') {
      await publishConnectorPage(ctx, { relPath: op.relPath, markdown: op.markdown, commitMessage: `imessage(${sourceId}): ${op.chatKey} ${op.day}`,
        privateMessage: `imessage(${sourceId}): ${op.chatKey} ${op.day} is private; database only`, retireReason: 'the iMessage day changed on the Mac' });
      state.chats[op.chatKey]!.days[op.day] = { path: op.relPath, fp: op.fp };
      return;
    }
    await deleteConnectorPage(ctx, op.relPath, `imessage(${sourceId}): ${op.chatKey} ${op.day} has no messages`, 'the iMessage day was deleted on the Mac');
    delete state.chats[op.chatKey]!.days[op.day];
  };

  const pageExists = async (slug: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!.n > 0;

  const dayOf = (m: IMessageMessage) => slackDayKey(Date.parse(m.timestamp), cfg.timezone);

  /** One day read again on its own (a day an earlier run held). */
  const rebuildDay = async (thread: IMessageThread, chatKey: string, day: string) => {
    const start = slackDayStartMs(day, cfg.timezone);
    const end = slackDayStartMs(nextSlackDay(day), cfg.timezone);
    const messages = (await helper!.messages(thread.threadId, new Date(start).toISOString(), signal)).filter(m => Date.parse(m.timestamp) < end && dayOf(m) === day);
    if (shownMessages(messages).length) publishDay(thread, chatKey, day, messages, imessageDayFingerprint(thread, day, messages));
    else if (state.chats[chatKey]!.days[day] || await pageExists(slugifyPath(imessagePagePath(chatKey, day)))) deleteDay(chatKey, day, true);
  };

  const syncChat = async (thread: IMessageThread | null, chatKey: string) => {
    const ch = state.chats[chatKey] ??= { committed_to: null, window: null, days: {} };
    if (opts.full) Object.assign(ch, { committed_to: null, window: null });
    const window = openCoverageWindow(ch, { runStart, historyDays: cfg.historyDays, lookbackDays: cfg.lookbackDays, alignFrom: ms => slackAlignToDay(ms, cfg.timezone) });
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    // A chat whose newest message is older than the window is not read: its days in the window have no messages. A chat
    // the helper lists with no newest-message time is read, so its days are never deleted on a guess.
    const recent = !!thread && (thread.lastMessageAt === null || Date.parse(thread.lastMessageAt) >= from);
    const byDay = new Map<string, IMessageMessage[]>();
    for (const m of recent ? await helper!.messages(thread!.threadId, window.from, signal) : []) {
      const at = Date.parse(m.timestamp);
      if (at < from || at >= to) continue;
      const day = dayOf(m);
      byDay.set(day, [...byDay.get(day) ?? [], m]);
    }
    for (const [day, messages] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
      const key = `${chatKey}/${day}`;
      if (!holds.shouldAttempt(key) || slackDayStartMs(day, cfg.timezone) < from) continue;
      if (!shownMessages(messages).length) { byDay.delete(day); continue; }
      const fp = imessageDayFingerprint(thread!, day, messages);
      if (!opts.full && ch.days[day]?.fp === fp && !heldPaths.has(imessagePagePath(chatKey, day))) continue;
      await handle(key, async () => publishDay(thread!, chatKey, day, messages, fp), slugifyPath(imessagePagePath(chatKey, day)));
    }
    for (const day of Object.keys(ch.days)) {
      const start = slackDayStartMs(day, cfg.timezone);
      if (byDay.has(day) || start < from || start >= to) continue;
      deleteDay(chatKey, day, !!thread);
    }
    if (thread) {
      // Days held by an earlier run and now outside the window are read again on their own.
      for (const key of holds.dueHeldKeys()) {
        const day = key.startsWith(`${chatKey}/`) ? key.slice(chatKey.length + 1) : null;
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || byDay.has(day)) continue;
        await handle(key, () => rebuildDay(thread, chatKey, day), slugifyPath(imessagePagePath(chatKey, day)));
      }
    }
    horizons.set(chatKey, closeCoverageWindow(ch, cfg.lookbackDays));
  };

  /** Days that ended at or before a chat's closed window are forgotten, once this run's pages are in. */
  const forgetClosedDays = () => {
    for (const [chatKey, horizon] of horizons) {
      const ch = state.chats[chatKey];
      if (ch) for (const day of Object.keys(ch.days)) if (slackDayStartMs(nextSlackDay(day), cfg.timezone) <= horizon) delete ch.days[day];
    }
  };

  /**
   * The run's one commit, then the database rows. In the folder, a removal needs a positive report (the helper listed
   * the chat and read the window), a mass removal is held whole, and a held file still imports its day to the database.
   */
  const commitAndApply = async () => {
    const recorded = owned?.files ?? {};
    if (destination.record !== 'folder') {
      if (owned) state.owned = { ...owned, held: { ...owned.held, ...staleHolds(recorded, ops.map(op => op.relPath), `changed while pages were database-only (${destination.reason})`) } };
      for (const op of ops) await handle(op.key, () => applyOp(op), slugifyPath(op.relPath));
      forgetClosedDays();
      return;
    }
    const writes = new Map<string, string>();
    const removes: string[] = [];
    const apply: DayOp[] = [];
    for (const op of ops) {
      if (op.op === 'write') { writes.set(op.relPath, op.markdown); apply.push(op); continue; }
      if (!recorded[op.relPath]) { apply.push(op); continue; }
      if (op.positive) { removes.push(op.relPath); apply.push(op); }
    }
    const massHeld = new Set<string>();
    if (removes.length > OWNED_MASS_REMOVAL_DAYS || (removes.length > 2 && removes.length > ownedDays * OWNED_MASS_REMOVAL_SHARE)) {
      process.stderr.write(`[gbrain notice owned_mass_removal_held] iMessage source ${sourceId}: this run would remove ${removes.length} of ${ownedDays} day files from ${ownedFolderRel(sourceId)}/, so it removed none and kept those days in the database. The next run tries again; if the chats really were deleted on the Mac, run: gbrain sources remove ${sourceId}\n`);
      for (const p of removes) massHeld.add(p);
      removes.length = 0;
      for (let i = apply.length - 1; i >= 0; i--) if (massHeld.has(apply[i]!.relPath) && apply[i]!.op === 'delete') apply.splice(i, 1);
    }
    const days = writes.size + removes.length;
    const where = destination.pushUrls.length ? destination.pushUrls.join(', ') : 'this checkout only';
    let batch: ReturnType<typeof commitOwnedBatch>;
    let folderRefused = false;
    try {
      batch = commitOwnedBatch({ root: destination.root, rel: destination.rel, sourceId, kind: 'imessage', incarnation: source.incarnation,
      pushUrls: destination.pushUrls, writes, removes,
      message: owned?.last_batch ? `imessage(${sourceId}): ${writes.size} chat-days updated, ${removes.length} removed`
        : `imessage(${sourceId}): import ${days} chat-days into ${destination.rel} (${where})` }, owned ?? null);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      folderRefused = true;
      // The folder is not this source's, or Git refused the commit (a rebase, a hook, the lock, no identity): every day
      // goes to the database this run, and each changed day is retried in the folder next run.
      const reason = error.code === 'owned_folder_conflict' ? 'conflict' as const : 'git_error' as const;
      state.record_status = { ...state.record_status!, record: 'database', folder: null, reason, detail: error.message };
      process.stderr.write(`[gbrain notice owned_folder_database_only] iMessage source ${sourceId}: pages stay in the database only because ${reason === 'git_error' ? `Git refused the commit (${error.code}): ` : ''}${error.message} ${error.suggestion ?? ''}\n`);
      batch = { sha: null, written: {}, removed: [], firstWrite: false,
        held: { ...Object.fromEntries([...writes.keys()].map(p => [p, { code: 'owned_folder_conflict' as const, detail: error.message }])), ...staleHolds(recorded, removes, error.message) } };
      apply.splice(0, apply.length, ...ops.filter(op => op.op === 'write' || !recorded[op.relPath] || (op.positive && !massHeld.has(op.relPath))));
    }
    const files = { ...recorded, ...batch.written };
    for (const p of batch.removed) delete files[p];
    const held = { ...owned?.held ?? {} };
    for (const p of [...Object.keys(batch.written), ...batch.removed, ...writes.keys()]) delete held[p];
    Object.assign(held, batch.held);
    state.owned = { incarnation: source.incarnation, push_urls: owned?.push_urls ?? destination.pushUrls, files,
      last_batch: batch.sha ?? owned?.last_batch ?? null, last_batch_at: batch.sha ? new Date(now()).toISOString() : owned?.last_batch_at ?? null, held };
    // The commit is recorded before any row is imported, with the chats as they were before this run: a run that stops
    // here reads the same window again next time, finds its own files unchanged and imports them.
    if (batch.sha) {
      const live = state.chats;
      state.chats = chatsBefore;
      try { await save(false); } finally { state.chats = live; }
    }
    if (!folderRefused) for (const hold of Object.values(batch.held)) {
      process.stderr.write(`[gbrain notice ${hold.code}] iMessage source ${sourceId}: ${hold.detail}; that day is in the database only until it is fixed.\n`);
    }
    for (const op of apply) await handle(op.key, () => applyOp(op), slugifyPath(op.relPath));
    forgetClosedDays();
    const live = new Set(Object.values(state.chats).flatMap(c => Object.values(c.days).map(d => d.path)));
    for (const p of Object.keys(held)) if (!live.has(p) && !files[p]) delete held[p];
  };

  try {
    const listed = new Map(threads.map(thread => [imessageChatKey(thread.threadId), thread]));
    for (const [chatKey, thread] of listed) {
      if (!holds.shouldAttempt(chatKey)) continue;
      await handle(chatKey, () => syncChat(thread, chatKey), null);
    }
    // A chat the helper no longer lists (deleted on the Mac) has no messages left; when the list was cut at its limit, an
    // unlisted chat may only be older, so it is left alone.
    if (threads.length < IMESSAGE_THREADS_LIMIT) {
      for (const chatKey of Object.keys(state.chats)) {
        if (listed.has(chatKey) || !Object.keys(state.chats[chatKey]!.days).length || !holds.shouldAttempt(chatKey)) continue;
        await handle(chatKey, () => syncChat(null, chatKey), null);
      }
    }
    await commitAndApply();
    if (summary.failedFiles > 0) summary.status = 'partial';
    state.item_holds = holds.finish();
    await save(true);
    await holds.complete();
    if (!managed) {
      await engine.executeRaw('UPDATE sources SET last_sync_at=now(), newest_content_at=COALESCE($1::timestamptz, newest_content_at) WHERE id=$2', [newest(), sourceId]).catch(() => undefined);
    }
  } catch (error) {
    if (stopsRun(error) && !(error as { name?: string }).name?.startsWith('Lock')) {
      // Windows close as each chat is read and pages are written at the end, so a stopped run keeps the windows it started with.
      try { state.chats = chatsBefore; state.item_holds = holds.holds.finish().state; await save(false); } catch { /* the original error is what the caller sees */ }
    }
    throw error;
  }

  await afterConnectorPublish(ctx, opts);
  return {
    status: summary.status === 'partial' ? 'partial' : summary.added + summary.modified + summary.deleted > 0 ? 'synced' : 'up_to_date',
    fromCommit: null, toCommit: '', added: summary.added, modified: summary.modified, deleted: summary.deleted, renamed: 0,
    chunksCreated: summary.chunksCreated, embedded: summary.embedded, pagesAffected: summary.pagesAffected,
    ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
    ...(summary.status === 'partial' ? { filesImported: summary.added + summary.modified,
      reason: summary.failedFiles > 0 ? 'connector_item_failures' as const : signal?.aborted ? 'timeout' as const : 'connector_partial' as const } : {}),
    ...connectorHoldsResult(sourceId, holds.summary()),
  };
}
