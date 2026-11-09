/**
 * GBRA-224 W1: the one-time notice that an install whose channel was never set now follows stable. Printed on the
 * first update check after the flip, once per GBRAIN_HOME (an exclusively created marker file), on stderr, in the
 * `[gbrain notice …]` form that parseMarker never reads as `UPGRADE_AVAILABLE`. Never under `--json` or the MCP
 * server (it waits for a later plain invocation), and never when a flag, GBRAIN_RELEASE_CHANNEL or
 * `self_upgrade.channel` chose the channel. File plane only, so repo-less and repo brains behave the same.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from './config.ts';
import { jsonRequested } from './cli-force-exit.ts';
import { resolveReleaseChannel } from './self-upgrade.ts';

export const CHANNEL_NOTICE_CODE = 'release_channel';
export const CHANNEL_NOTICE_TEXT = `[gbrain notice ${CHANNEL_NOTICE_CODE}] This install now follows the stable channel: weekly releases promoted after testing. To get every release instead, run: gbrain config set self_upgrade.channel alpha`;
const MCP_COMMANDS = new Set(['serve', 'mcp']);

export function channelNoticePath(): string {
  return gbrainPath('notices', 'release-channel-stable');
}

/** Print the notice when it applies and was never printed under this GBRAIN_HOME; returns whether it printed. */
export function maybeEmitChannelNotice(opts: {
  command: string;
  args: readonly string[];
  cfg: { self_upgrade?: { channel?: string } } | null;
  env?: string | undefined;
  write?: (line: string) => void;
}): boolean {
  if (MCP_COMMANDS.has(opts.command) || jsonRequested(opts.args)) return false;
  if (resolveReleaseChannel(opts.cfg, null, opts.env).source !== 'default') return false;
  const path = channelNoticePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }
  (opts.write ?? (line => process.stderr.write(line)))(`${CHANNEL_NOTICE_TEXT}\n`);
  return true;
}
