/**
 * The imessage source sweep (`sources.config.kind = 'imessage'`): one private page per chat per day, read from the
 * GBrain Helper on this Mac over 127.0.0.1 (apple/helper-client.ts).
 *
 * Coverage is per chat (`connectors/api-source.ts` windows). A run reads each recent chat's window [from, to): `from`
 * is aligned to the start of a day in the source's time zone, so every day the window touches is read whole and its
 * page rebuilt from scratch. After the first window, the next starts `lookbackDays` before the boundary, so an edit or
 * an unsend in recent days converges and the facts extracted from the changed page are retired. A day whose messages
 * are unchanged (the fingerprint) publishes nothing, so a second run over the same messages writes nothing. A message
 * deleted on the phone after the lookback stays until the page is deleted by hand.
 *
 * Privacy: every page is `visibility: private`, the record is always the database (no directory, nothing committed
 * on a brain with a Git repository), and the source is owner-only (access/owner-only.ts), which is decided at read
 * time from the source's kind. `source_kind: imessage` keeps every copy at the external-untrusted trust tier.
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
import { IMESSAGE_HELPER_PORT_KEY, type IMessageMessage, type IMessageSourceConfig, type IMessageThread } from './types.ts';

export interface IMessageChatState {
  committed_to: string | null;
  window: CoverageWindow | null;
  /** Days published in the lookback horizon: the page path and the fingerprint it was rendered from. */
  days: Record<string, { path: string; fp: string }>;
}

export interface IMessageState extends Record<string, unknown> {
  /** Keyed by the handle-free chat key, so no handle is stored in the cursor. */
  chats: Record<string, IMessageChatState>;
  item_holds?: unknown;
}

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

export async function runIMessageSync(engine: BrainEngine, sourceId: string, cfg: IMessageSourceConfig, opts: SyncOpts, deps: IMessageSyncDeps = {}): Promise<SyncResult> {
  return withConnectorSync(engine, sourceId, 'imessage', cfg, opts,
    async (managed, options) => options.dryRun ? connectorDryRunResult('iMessage', sourceId) : runIMessageSyncInner(engine, sourceId, cfg, options, managed, deps), pendingConnectorResult);
}

async function runIMessageSyncInner(engine: BrainEngine, sourceId: string, cfg: IMessageSourceConfig, opts: SyncOpts,
  managed: ManagedConnectorSync | null, deps: IMessageSyncDeps): Promise<SyncResult> {
  const now = deps.now ?? Date.now;
  const runStart = now();
  const runId = randomUUID();
  let helper = deps.helper;
  if (!helper) {
    const port = await helperPort(engine);
    if (port === null) throw helperNotRunning(sourceId, null, `config ${IMESSAGE_HELPER_PORT_KEY} is not set`);
    const key = resolveApiToken('imessage', cfg.tokenEnv);
    if (!key) throw imessageAuthRequired(sourceId, cfg);
    helper = imessageHelper({ sourceId, port, token: key.token });
  }
  const signal = opts.signal;
  const threads = await helper.threads(signal);

  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]);
  const identity = connectorIdentity('imessage', source.config, source.local_path);
  const cursorKey = connectorDbCursorKey(sourceId, source.incarnation, identity);
  const state: IMessageState = managed ? { ...emptyState(), ...managed.state<IMessageState>(emptyState()) }
    : { ...emptyState(), ...(await readConnectorDbCursor(engine, cursorKey)).state as IMessageState | null };

  const summary: Summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], factsRetired: 0, failedFiles: 0 };
  const holds = await ConnectorHoldSession.open(engine, sourceId, managed, emptyState(), state.item_holds, { full: opts.full });
  const newest = () => Object.values(state.chats).map(c => c.committed_to).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const save = async (final: boolean) => {
    if (managed) {
      await managed.saveState(state, final && summary.status === 'synced', final ? newest() ?? undefined : undefined);
      return;
    }
    await writeConnectorDbCursor(engine, cursorKey, state, final ? { run_id: runId, finished_at: new Date(now()).toISOString(),
      counts: { added: summary.added, modified: summary.modified, deleted: summary.deleted, facts_retired: summary.factsRetired, failed: summary.failedFiles } } : undefined);
  };
  // Always the database: message text never reaches a directory, a commit or a push, whatever the brain has.
  const ctx: ConnectorPublishCtx = { engine, sourceId, managed, summary, label: 'iMessage', tag: 'imessage', record: 'database', dir: null, gated: true };
  const handle = async (key: string, work: () => Promise<void>, slug: string | null): Promise<boolean> => {
    try { await work(); holds.succeed(key); return true; } catch (error) {
      if (stopsRun(error)) throw error;
      summary.failedFiles++;
      await holds.fail(key, error, { slug });
      return false;
    }
  };

  const publishDay = async (thread: IMessageThread, chatKey: string, day: string, messages: IMessageMessage[], fp: string) => {
    const relPath = imessagePagePath(chatKey, day);
    await publishConnectorPage(ctx, {
      relPath,
      markdown: connectorRender(renderIMessageDay({ thread, chatKey, day, timezone: cfg.timezone, messages }), { path: relPath, imessage_chat: chatKey }),
      commitMessage: `imessage(${sourceId}): ${chatKey} ${day}`,
      privateMessage: `imessage(${sourceId}): ${chatKey} ${day} is private; database only`,
      retireReason: 'the iMessage day changed on the Mac',
    });
    state.chats[chatKey]!.days[day] = { path: relPath, fp };
  };

  const deleteDay = async (chatKey: string, day: string) => {
    const entry = state.chats[chatKey]!.days[day];
    await deleteConnectorPage(ctx, entry?.path ?? imessagePagePath(chatKey, day), `imessage(${sourceId}): ${chatKey} ${day} has no messages`,
      'the iMessage day was deleted on the Mac');
    delete state.chats[chatKey]!.days[day];
  };

  const pageExists = async (slug: string) =>
    (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!.n > 0;

  const dayOf = (m: IMessageMessage) => slackDayKey(Date.parse(m.timestamp), cfg.timezone);

  /** One day read again on its own (a day an earlier run held). */
  const rebuildDay = async (thread: IMessageThread, chatKey: string, day: string) => {
    const start = slackDayStartMs(day, cfg.timezone);
    const end = slackDayStartMs(nextSlackDay(day), cfg.timezone);
    const messages = (await helper!.messages(thread.threadId, new Date(start).toISOString(), signal)).filter(m => Date.parse(m.timestamp) < end && dayOf(m) === day);
    if (shownMessages(messages).length) await publishDay(thread, chatKey, day, messages, imessageDayFingerprint(thread, day, messages));
    else if (state.chats[chatKey]!.days[day] || await pageExists(slugifyPath(imessagePagePath(chatKey, day)))) await deleteDay(chatKey, day);
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
      if (!opts.full && ch.days[day]?.fp === fp) continue;
      await handle(key, () => publishDay(thread!, chatKey, day, messages, fp), slugifyPath(imessagePagePath(chatKey, day)));
    }
    for (const day of Object.keys(ch.days)) {
      const start = slackDayStartMs(day, cfg.timezone);
      if (byDay.has(day) || start < from || start >= to) continue;
      await handle(`${chatKey}/${day}`, () => deleteDay(chatKey, day), slugifyPath(ch.days[day]!.path));
    }
    if (thread) {
      // Days held by an earlier run and now outside the window are read again on their own.
      for (const key of holds.dueHeldKeys()) {
        const day = key.startsWith(`${chatKey}/`) ? key.slice(chatKey.length + 1) : null;
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || byDay.has(day)) continue;
        await handle(key, () => rebuildDay(thread, chatKey, day), slugifyPath(imessagePagePath(chatKey, day)));
      }
    }
    const horizon = closeCoverageWindow(ch, cfg.lookbackDays);
    for (const day of Object.keys(ch.days)) if (slackDayStartMs(nextSlackDay(day), cfg.timezone) <= horizon) delete ch.days[day];
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
    if (summary.failedFiles > 0) summary.status = 'partial';
    state.item_holds = holds.finish();
    await save(true);
    await holds.complete();
    if (!managed) {
      await engine.executeRaw('UPDATE sources SET last_sync_at=now(), newest_content_at=COALESCE($1::timestamptz, newest_content_at) WHERE id=$2', [newest(), sourceId]).catch(() => undefined);
    }
  } catch (error) {
    if (stopsRun(error) && !(error as { name?: string }).name?.startsWith('Lock')) {
      try { state.item_holds = holds.holds.finish().state; await save(false); } catch { /* the original error is what the caller sees */ }
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
