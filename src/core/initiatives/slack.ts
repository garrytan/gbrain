/**
 * The Slack bot client the initiatives lifecycle uses (bind checks, closing
 * messages, leaving channels, thread replies on Slack-born ideas). The token
 * is the Slack connector token (GBRAIN_CONNECTOR_SLACK_TOKEN or
 * `gbrain connectors auth slack`); null when none is configured.
 */
import { resolveApiToken } from '../connectors/credentials.ts';
import { slackApi, type SlackApi } from '../slack/client.ts';
import { VERSION } from '../../version.ts';

export function initiativesSlackApi(opts: { tokenEnv?: string } = {}): SlackApi | null {
  const token = resolveApiToken('slack', opts.tokenEnv)?.token ?? null;
  if (!token) return null;
  return slackApi({ token, userAgent: `gbrain/${VERSION} (+https://github.com/garrytan/gbrain)`, minDelayMs: 1100 });
}
