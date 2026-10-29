/**
 * The slack source sweep (`sources.config.kind = 'slack'`): one page per
 * channel per day.
 *
 * Coverage is per channel (`connectors/api-source.ts` windows), so a channel
 * the app can no longer read is held without stopping the others. Each run
 * reads a channel's window [from, to): `from` is aligned to the start of a day
 * in the source's time zone, so every day the window touches is read whole and
 * its page is rebuilt from scratch, never merged with a delta. A day whose
 * top-level messages are unchanged since its last publish (the fingerprint)
 * costs one history read and no reply reads; `--full` rebuilds every day.
 * After the window, the next one starts `lookbackDays` before the boundary, so
 * edits, deletions and new replies to threads started in the lookback converge.
 * A reply to a thread that started before the lookback is not seen (a disclosed
 * coverage limit); a reply also sent to the channel is.
 *
 * Privacy: a private channel's pages are `visibility: private`, database-only
 * on a Git-recorded source. A channel that becomes private has every page of
 * it re-published private, its committed files removed at HEAD, and the facts
 * extracted from it retired (T23).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';
import { withConnectorSync, pendingConnectorResult, type ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { connectorIdentity } from '../persistence/connector-identity.ts';
import { connectorAccountChanged } from '../persistence/connector-errors.ts';
import { sameConnectorAccount, type ConnectorAccount } from '../persistence/connector-state.ts';
import { ConnectorHoldSession, connectorHoldsResult } from '../connectors/connector-hold-session.ts';
import { connectorDbCursorKey, readConnectorDbCursor, writeConnectorDbCursor } from '../connectors/db-cursor.ts';
import { resolveApiToken } from '../connectors/credentials.ts';
import { connectorRender } from '../connectors/connector-text.ts';
import { ConnectorAccessDeniedError, ConnectorAuthError, ConnectorRateLimitedError, ConnectorRunLimitError } from '../connectors/client.ts';
import {
  afterConnectorPublish, closeCoverageWindow, deleteConnectorPage, openCoverageWindow, publishConnectorPage, recordRateLimit, runScoped,
  type ConnectorPublishCtx, type CoverageWindow, type PublishSummary,
} from '../connectors/api-source.ts';
import { slugifyPath } from '../sync.ts';
import { VERSION } from '../../version.ts';
import { SlackChannelUnavailableError, slackApi, type SlackApi } from './client.ts';
import { nextSlackDay, renderSlackDay, skippedMessage, slackAlignToDay, slackDayFingerprint, slackDayKey, slackDayStartMs, slackPagePath } from './render.ts';
import type { SlackAccount, SlackChannelInfo, SlackMessage, SlackSourceConfig, SlackUser } from './types.ts';

/** The user list is re-read when a message names a user it lacks, or once this old. */
const USERS_MAX_AGE_MS = 7 * 86_400_000;

export interface SlackChannelState {
  committed_to: string | null;
  window: CoverageWindow | null;
  name: string;
  private: boolean;
  /** Days published in the lookback horizon: the page path and the fingerprint it was rendered from. */
  days: Record<string, { path: string; fp: string }>;
}

export interface SlackState extends Record<string, unknown> {
  channels: Record<string, SlackChannelState>;
  /** Display names of the users the pages mention (T27): refreshed by one users.list at most per run. */
  users: Record<string, SlackUser>;
  users_listed_at: string | null;
  account?: ConnectorAccount | null;
  item_holds?: unknown;
}

const emptyState = (): SlackState => ({ channels: {}, users: {}, users_listed_at: null });

export interface SlackSyncDeps {
  /** Test seam: an API bound to a fake transport. */
  api?: SlackApi;
  now?: () => number;
}

interface Summary extends PublishSummary { status: 'synced' | 'partial'; failedFiles: number }

export function slackConnectorAccount(account: SlackAccount): ConnectorAccount {
  return { kind: 'slack', teamId: account.teamId, enterpriseId: account.enterpriseId };
}

export function slackAuthRequired(sourceId: string, cfg: Pick<SlackSourceConfig, 'tokenEnv'>, detail?: string): OperationError {
  return new OperationError('connector_auth_required',
    `Slack source ${sourceId} has no working Slack app token${detail ? ` (${detail})` : ''}. Nothing was imported.`,
    cfg.tokenEnv ? `Set ${cfg.tokenEnv} to the app's Bot User OAuth Token in the environment that runs the sync, then run: gbrain sync --source ${sourceId}`
      : `Ask the user for their Slack app's Bot User OAuth Token and save it on stdin: gbrain connectors auth slack --token - ; then run: gbrain sync --source ${sourceId}. The token was read from GBRAIN_CONNECTOR_SLACK_TOKEN or ~/.gbrain/connectors/slack.json.`,
    'docs/guides/meeting-and-slack-sources.md#connector_auth_required');
}

export function slackChannelRefused(sourceId: string, error: SlackChannelUnavailableError): OperationError {
  return new OperationError('connector_access_denied', `Slack source ${sourceId} cannot read channel ${error.channelId}: ${error.message}. Nothing was imported.`,
    `Invite the app to that channel (type /invite @<your app> in it), or check the channel id; then run gbrain sync --source ${sourceId}.`,
    'docs/guides/meeting-and-slack-sources.md#connector_access_denied');
}

function translate(sourceId: string, cfg: SlackSourceConfig, error: unknown): unknown {
  if (error instanceof ConnectorAuthError) return slackAuthRequired(sourceId, cfg, 'Slack rejected it');
  if (error instanceof SlackChannelUnavailableError) return slackChannelRefused(sourceId, error);
  if (error instanceof ConnectorAccessDeniedError) {
    return new OperationError('connector_access_denied', `The Slack token for ${sourceId} may not do this: ${error.message}. Nothing more was imported.`,
      `Grant the app the scopes the source needs (channels:read, channels:history, groups:read, groups:history, users:read), reinstall it, save the new token with gbrain connectors auth slack --token -, then run gbrain sync --source ${sourceId}.`,
      'docs/guides/meeting-and-slack-sources.md#connector_access_denied');
  }
  if (error instanceof ConnectorRateLimitedError) {
    const at = error.retryAt ? new Date(error.retryAt).toISOString() : null;
    return new OperationError('rate_limited', `Slack rate-limited ${sourceId}${at ? ` until ${at}` : ''}; progress so far was saved.`,
      `Wait${at ? ` until ${at}` : ''}; autopilot resumes it by itself, or run gbrain sync --source ${sourceId} after that.`,
      'docs/guides/meeting-and-slack-sources.md#rate_limited');
  }
  return error;
}

export async function runSlackSync(engine: BrainEngine, sourceId: string, cfg: SlackSourceConfig, opts: SyncOpts, deps: SlackSyncDeps = {}): Promise<SyncResult> {
  return withConnectorSync(engine, sourceId, 'slack', cfg, opts,
    (managed, options) => runSlackSyncInner(engine, sourceId, cfg, options, managed, deps), pendingConnectorResult);
}

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

async function runSlackSyncInner(engine: BrainEngine, sourceId: string, cfg: SlackSourceConfig, opts: SyncOpts,
  managed: ManagedConnectorSync | null, deps: SlackSyncDeps): Promise<SyncResult> {
  const now = deps.now ?? Date.now;
  const runStart = now();
  const runId = randomUUID();
  let api = deps.api;
  if (!api) {
    const key = resolveApiToken('slack', cfg.tokenEnv);
    if (!key) throw slackAuthRequired(sourceId, cfg);
    api = slackApi({ token: key.token, userAgent: `gbrain/${VERSION} (+https://github.com/garrytan/gbrain)`, now, maxRequests: cfg.maxRequests });
  }
  const signal = opts.signal;
  let account: SlackAccount;
  try { account = await api.authTest(signal); } catch (e) {
    if (e instanceof ConnectorRateLimitedError && e.retryAt) await recordRateLimit(engine, sourceId, e.retryAt);
    throw translate(sourceId, cfg, e);
  }
  const resolved = slackConnectorAccount(account);

  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]);
  const identity = connectorIdentity('slack', source.config, source.local_path);
  const cursorKey = connectorDbCursorKey(sourceId, source.incarnation, identity);
  let state: SlackState;
  if (managed) {
    await managed.assertAccount(resolved);
    state = { ...emptyState(), ...managed.state<SlackState>(emptyState()) };
  } else {
    state = { ...emptyState(), ...(await readConnectorDbCursor(engine, cursorKey)).state as SlackState | null };
    if (state.account && !sameConnectorAccount(state.account, resolved)) throw connectorAccountChanged(sourceId, 'slack', identity.config, state.account, resolved);
    state.account = resolved;
  }

  // First sync of a channel: refuse the run, with the fix, when the app cannot read it (plan item 1).
  const infos = new Map<string, SlackChannelInfo>();
  for (const id of cfg.channels) {
    if (state.channels[id]) continue;
    try { infos.set(id, await api.conversationInfo(id, signal)); } catch (e) {
      if (e instanceof ConnectorRateLimitedError && e.retryAt) await recordRateLimit(engine, sourceId, e.retryAt);
      throw translate(sourceId, cfg, e);
    }
  }
  for (const [id, info] of infos) state.channels[id] = { committed_to: null, window: null, name: info.name, private: info.isPrivate, days: {} };

  const summary: Summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], factsRetired: 0, failedFiles: 0 };
  const holds = await ConnectorHoldSession.open(engine, sourceId, managed, emptyState(), state.item_holds, { full: opts.full });
  const newest = () => Object.values(state.channels).map(c => c.committed_to).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const save = async (final: boolean) => {
    if (managed) {
      await managed.saveState(state, final && summary.status === 'synced', final ? newest() ?? undefined : undefined);
      return;
    }
    await writeConnectorDbCursor(engine, cursorKey, state, final ? { run_id: runId, finished_at: new Date(now()).toISOString(),
      counts: { added: summary.added, modified: summary.modified, deleted: summary.deleted, facts_retired: summary.factsRetired, failed: summary.failedFiles } } : undefined);
  };
  const ctx: ConnectorPublishCtx = { engine, sourceId, managed, summary, label: 'Slack', tag: 'slack', record: cfg.record, dir: cfg.dir };
  const handle = async (key: string, work: () => Promise<void>, slug: string | null): Promise<boolean> => {
    try { await work(); holds.succeed(key); return true; } catch (error) {
      if (runScoped(error)) throw error;
      summary.failedFiles++;
      await holds.fail(key, error, { slug });
      return false;
    }
  };

  let listedUsers = false;
  const ensureUsers = async (messages: SlackMessage[]) => {
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.user) ids.add(m.user);
      for (const match of (m.text ?? '').matchAll(MENTION_RE)) ids.add(match[1]!);
    }
    const stale = !state.users_listed_at || runStart - Date.parse(state.users_listed_at) > USERS_MAX_AGE_MS;
    if (listedUsers || (!stale && [...ids].every(id => state.users[id]))) return;
    const list = await api!.usersList(signal);
    listedUsers = true;
    state.users_listed_at = new Date(runStart).toISOString();
    for (const id of new Set([...Object.keys(state.users), ...ids])) state.users[id] = list.get(id) ?? state.users[id] ?? { name: id, deleted: false, bot: false };
  };

  const publishDay = async (info: SlackChannelInfo, day: string, messages: SlackMessage[], fp: string) => {
    const replies = new Map<string, SlackMessage[]>();
    for (const m of messages) {
      if ((m.reply_count ?? 0) > 0 && m.subtype !== 'thread_broadcast') replies.set(m.ts, await api!.replies(info.id, m.ts, signal));
    }
    await ensureUsers([...messages, ...[...replies.values()].flat()]);
    const relPath = slackPagePath(info.id, day);
    await publishConnectorPage(ctx, {
      relPath,
      markdown: connectorRender(renderSlackDay({ channel: info, day, timezone: cfg.timezone, account, messages, replies, users: state.users, privateOnly: cfg.privateOnly, skip: cfg.skip }),
        { path: relPath, slack_channel_id: info.id }),
      commitMessage: `slack(${sourceId}): #${info.name.replace(/\s+/g, ' ').slice(0, 60)} ${day}\n\nslack_channel_id: ${info.id}\nslack_team_id: ${account.teamId}`,
      privateMessage: `slack(${sourceId}): ${info.id} ${day} is private; database only`,
      retireReason: 'the Slack day changed upstream',
    });
    state.channels[info.id]!.days[day] = { path: relPath, fp };
  };

  const deleteDay = async (channelId: string, day: string) => {
    const entry = state.channels[channelId]!.days[day];
    await deleteConnectorPage(ctx, entry?.path ?? slackPagePath(channelId, day), `slack(${sourceId}): ${channelId} ${day} has no messages upstream`,
      'the Slack day was deleted upstream');
    delete state.channels[channelId]!.days[day];
  };

  /**
   * T23: a private channel's pages that are not private yet (the channel became private) are rebuilt from Slack as
   * private, which takes them out of the checkout and retires their facts; a day emptied upstream is deleted.
   */
  const makeChannelPrivate = async (info: SlackChannelInfo) => {
    const rows = await engine.executeRaw<{ day: string }>(
      `SELECT DISTINCT frontmatter->>'date' AS day FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'slack_channel_id'=$2
        AND COALESCE(frontmatter->>'visibility','') <> 'private' AND frontmatter->>'date' IS NOT NULL ORDER BY 1`, [sourceId, info.id]);
    for (const { day } of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      await handle(`${info.id}/${day}`, () => rebuildDay(info, day), slugifyPath(slackPagePath(info.id, day)));
    }
  };

  /** One day read again on its own (a held day, or a day of a channel that became private). */
  const rebuildDay = async (info: SlackChannelInfo, day: string) => {
    const messages = (await api!.history(info.id, slackDayStartMs(day, cfg.timezone) / 1000, slackDayStartMs(nextSlackDay(day), cfg.timezone) / 1000, signal))
      .filter(m => !skippedMessage(m, cfg.skip));
    if (messages.length) await publishDay(info, day, messages, slackDayFingerprint({ channel: info, messages, privateOnly: cfg.privateOnly }));
    else if (state.channels[info.id]!.days[day] || await pageExists(slugifyPath(slackPagePath(info.id, day)))) await deleteDay(info.id, day);
  };

  const pageExists = async (slug: string) =>
    (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!.n > 0;

  const syncChannel = async (channelId: string) => {
    const info = infos.get(channelId) ?? await api!.conversationInfo(channelId, signal);
    const ch = state.channels[channelId] ??= { committed_to: null, window: null, name: info.name, private: info.isPrivate, days: {} };
    ch.name = info.name;
    ch.private = info.isPrivate;
    if (info.isPrivate) await makeChannelPrivate(info);
    const window = openCoverageWindow(ch, { runStart, historyDays: cfg.historyDays, lookbackDays: cfg.lookbackDays, alignFrom: ms => slackAlignToDay(ms, cfg.timezone) });
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    const byDay = new Map<string, SlackMessage[]>();
    for (const m of await api!.history(channelId, from / 1000, to / 1000, signal)) {
      if (skippedMessage(m, cfg.skip)) continue;
      const day = slackDayKey(Number(m.ts) * 1000, cfg.timezone);
      byDay.set(day, [...byDay.get(day) ?? [], m]);
    }
    for (const [day, messages] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
      const key = `${channelId}/${day}`;
      if (!holds.shouldAttempt(key)) continue;
      const fp = slackDayFingerprint({ channel: info, messages, privateOnly: cfg.privateOnly });
      if (!opts.full && ch.days[day]?.fp === fp) continue;
      await handle(key, () => publishDay(info, day, messages, fp), slugifyPath(slackPagePath(channelId, day)));
    }
    for (const day of Object.keys(ch.days)) {
      const start = slackDayStartMs(day, cfg.timezone);
      if (byDay.has(day) || start < from || start >= to) continue;
      await handle(`${channelId}/${day}`, () => deleteDay(channelId, day), slugifyPath(ch.days[day]!.path));
    }
    // Days held by an earlier run and now outside the window are read again on their own.
    for (const key of holds.dueHeldKeys()) {
      const day = key.startsWith(`${channelId}/`) ? key.slice(channelId.length + 1) : null;
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || byDay.has(day)) continue;
      await handle(key, () => rebuildDay(info, day), slugifyPath(slackPagePath(channelId, day)));
    }
    const horizon = closeCoverageWindow(ch, cfg.lookbackDays);
    for (const day of Object.keys(ch.days)) if (slackDayStartMs(nextSlackDay(day), cfg.timezone) <= horizon) delete ch.days[day];
  };

  try {
    for (const channelId of cfg.channels) {
      if (!holds.shouldAttempt(channelId)) continue;
      await handle(channelId, () => syncChannel(channelId), null);
    }
    if (summary.failedFiles > 0) summary.status = 'partial';
    state.item_holds = holds.finish();
    await save(true);
    await holds.complete();
    if (!managed) {
      await engine.executeRaw('UPDATE sources SET last_sync_at=now(), newest_content_at=COALESCE($1::timestamptz, newest_content_at) WHERE id=$2', [newest(), sourceId]).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof ConnectorRateLimitedError && error.retryAt) await recordRateLimit(engine, sourceId, error.retryAt);
    if (runScoped(error) && !(error as { name?: string }).name?.startsWith('Lock')) {
      try { state.item_holds = holds.holds.finish().state; await save(false); } catch { /* the original error is what the caller sees */ }
    }
    // The per-run request cap (T11) ends the run partial; the open windows resume next run.
    if (!(error instanceof ConnectorRunLimitError)) throw translate(sourceId, cfg, error);
    summary.status = 'partial';
    process.stderr.write(`[slack] ${sourceId}: ${error.message}; the next sync resumes where this one stopped\n`);
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
