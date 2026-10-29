/** `sources add --kind slack`: the registered config, and the add-time check of the token and channels (trusted local CLI only). */
import { OperationError } from '../ops/contract.ts';
import { resolveApiToken } from '../connectors/credentials.ts';
import { ConnectorAuthError, type ConnectorFetch } from '../connectors/client.ts';
import { SYNC_INTERVAL_MIN_FLOOR, type MeetingRecordMode } from '../meetings/types.ts';
import type { MeetingsRecordChoice } from '../meetings/source-add.ts';
import { VERSION } from '../../version.ts';
import { slackApi, SlackChannelUnavailableError } from './client.ts';
import type { SlackChannelInfo, SlackSkippable } from './types.ts';

export interface AddSourceSlackOpts {
  channels: string[];
  record: 'auto' | MeetingRecordMode;
  historyDays?: number;
  lookbackDays?: number;
  syncIntervalMin?: number;
  tokenEnv?: string;
  dir?: string;
  private: boolean;
  timezone?: string;
  maxRequests?: number;
  skip?: SlackSkippable[];
}

/** The `sources.config` a new slack source is registered with. Only non-default tuning keys are written; no token ever is. */
export function slackSourceConfig(opts: AddSourceSlackOpts, choice: MeetingsRecordChoice, federated: boolean | null | undefined, managed: boolean): Record<string, unknown> {
  return {
    kind: 'slack',
    s_channels: opts.channels.join(','),
    s_record: choice.record,
    ...(choice.dir ? { s_dir: choice.dir } : {}),
    ...(opts.historyDays !== undefined ? { s_history_days: opts.historyDays } : {}),
    ...(opts.lookbackDays !== undefined ? { s_lookback_days: opts.lookbackDays } : {}),
    ...(opts.timezone && opts.timezone !== 'UTC' ? { s_timezone: opts.timezone } : {}),
    ...(opts.tokenEnv ? { s_token_env: opts.tokenEnv } : {}),
    ...(opts.private ? { s_visibility: 'private' } : {}),
    ...(opts.maxRequests !== undefined ? { s_max_requests: opts.maxRequests } : {}),
    ...(opts.skip?.length ? { s_skip: [...new Set(opts.skip)].sort().join(',') } : {}),
    ...(opts.syncIntervalMin !== undefined ? { sync_interval_min: Math.max(SYNC_INTERVAL_MIN_FLOOR, opts.syncIntervalMin) } : {}),
    // Chat joins unqualified reads only when the user asks (--federated), as meeting notes do.
    federated: federated ?? false,
    ...(managed && choice.record === 'git' ? { canonical: 'git' } : {}),
  };
}

/**
 * Plan item 1: before a slack source is registered, the token must work (`auth.test`) and the app must be able to read
 * every channel (`conversations.info`); a failure refuses with the fix (save a token, add a scope, invite the app).
 * Prints which channels are private, and that a shared brain flattens Slack's per-channel permissions.
 */
export async function preflightSlackAdd(sourceId: string, opts: AddSourceSlackOpts, deps: { fetchImpl?: ConnectorFetch; log?: (line: string) => void } = {}): Promise<SlackChannelInfo[]> {
  const log = deps.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const key = resolveApiToken('slack', opts.tokenEnv);
  if (!key) {
    throw new OperationError('connector_auth_required', `No Slack app token is available, so source ${sourceId} was not added.`,
      opts.tokenEnv ? `Set ${opts.tokenEnv} to the app's Bot User OAuth Token, then run the sources add command again.`
        : 'Ask the user for their Slack app\'s Bot User OAuth Token and save it on stdin (gbrain connectors auth slack --token -), then run the sources add command again.',
      'docs/guides/meeting-and-slack-sources.md#connector_auth_required');
  }
  const api = slackApi({ token: key.token, userAgent: `gbrain/${VERSION} (+https://github.com/garrytan/gbrain)`, minDelayMs: 0, maxRequests: opts.channels.length + 5,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  const fail = (error: unknown): never => {
    if (error instanceof SlackChannelUnavailableError) throw new OperationError('connector_access_denied',
      `Source ${sourceId} was not added: the Slack app cannot read channel ${error.channelId}.`,
      `Invite the app to that channel (type /invite @<your app> in it) or fix the channel id, then run the sources add command again.`,
      'docs/guides/meeting-and-slack-sources.md#connector_access_denied');
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ConnectorAuthError) throw new OperationError('connector_auth_required', `Source ${sourceId} was not added: ${message}.`,
      'Ask the user for a fresh Bot User OAuth Token from their Slack app and save it on stdin (gbrain connectors auth slack --token -), then run the sources add command again.',
      'docs/guides/meeting-and-slack-sources.md#connector_auth_required');
    throw new OperationError('connector_access_denied', `Source ${sourceId} was not added: ${message}.`,
      'Check the token (gbrain connectors auth slack --token -) and that the app has the channels:read, channels:history, groups:read, groups:history and users:read scopes, then run the sources add command again.',
      'docs/guides/meeting-and-slack-sources.md#connector_access_denied');
  };
  const account = await api.authTest().catch(fail);
  const infos: SlackChannelInfo[] = [];
  for (const channel of opts.channels) infos.push(await api.conversationInfo(channel).catch(fail));
  const privateChannels = infos.filter(info => info.isPrivate);
  log(`Slack workspace ${account.team ?? account.teamId}: ${infos.length} channel${infos.length === 1 ? '' : 's'} readable.`);
  if (privateChannels.length) log(`Private channels (their pages are private and stay out of any Git checkout): ${privateChannels.map(info => `#${info.name} (${info.id})`).join(', ')}.`);
  log('Note: a brain that other people or agents read sees every imported channel together; Slack\'s per-channel membership does not carry over.');
  return infos;
}
