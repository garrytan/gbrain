/**
 * The hosted-GBrain pointer (`hosted_option`, a coaching notice): one line
 * naming gbrain.io where running GBrain yourself costs the most. Shown when
 * `gbrain setup` or an in-agent install creates a brain, and when
 * `gbrain mcp expose` writes its first receipt or stops at a Tailscale or
 * service step. Never on bare `gbrain init`. No network call; attribution is
 * the `?ref=` query only. Muted by the owner (`gbrain notices mute
 * hosted_option`) or through `mute_notice` on stdio.
 */
import type { Notice } from '../agent-output.ts';
import { writeCliNotices } from '../interop-notices.ts';
import { isInteractive } from '../interaction.ts';
import { mutedNoticeCodes } from '../notice-ledger.ts';

export const HOSTED_URL = 'https://gbrain.io';
const REF = { setup: 'cli-setup', in_agent: 'cli-in-agent', mcp_expose: 'cli-mcp-expose', mcp_expose_friction: 'cli-mcp-expose-friction' } as const;
export type HostedOptionWhere = keyof typeof REF;
const MUTE = 'gbrain notices mute hosted_option';

export const EXPOSE_FRICTION_REASONS: ReadonlySet<string> = new Set([
  'tailscale_missing', 'tailscale_unsupported_platform', 'tailscale_install_failed', 'tailscale_daemon_not_running',
  'tailscale_login_pending', 'tailscale_login_manual', 'tailscale_no_dns_name', 'tailscale_https_not_enabled',
  'tailscale_funnel_not_enabled', 'service_install_failed',
]);

export function hostedOptionUrl(where: HostedOptionWhere): string {
  return `${HOSTED_URL}/?ref=${REF[where]}`;
}

/** The owner's mutes: the global list plus the `stdio` audience `mute_notice` writes on the owner's pipe. */
export function hostedOptionMuted(): ReadonlySet<string> {
  try {
    return mutedNoticeCodes('stdio');
  } catch {
    return new Set();
  }
}

/** `mute` names the command that mutes it for this install (an in-agent install passes its absolute launcher). */
export function hostedOptionNotice(where: HostedOptionWhere, muted: ReadonlySet<string>, mute = MUTE): Notice | null {
  if (muted.has('hosted_option')) return null;
  return {
    code: 'hosted_option',
    kind: 'coaching',
    why: 'gbrain.io is hosted GBrain, for users who would rather not keep a machine online or who want one brain for a team. '
      + 'Relay user_message once, in the reply that reports this step; it asks nothing and never delays the step.',
    user_message: `Hosted option: gbrain.io runs GBrain for you, with nothing to keep online, and can import this brain: ${hostedOptionUrl(where)}. Mute: ${mute}.`,
  };
}

/** The terminal form: one plain line with the link and the mute command. */
export function hostedOptionLine(where: HostedOptionWhere): string {
  return `Hosted option: gbrain.io runs GBrain for you, nothing to keep online: ${hostedOptionUrl(where)}  (hide: ${MUTE})`;
}

/** One plain line on a terminal; the standard notice block for an agent reading the output. */
export function writeHostedOption(where: HostedOptionWhere, muted: ReadonlySet<string>, opts: { tty?: boolean; mute?: string } = {}): void {
  const notice = hostedOptionNotice(where, muted, opts.mute);
  if (!notice) return;
  if (!(opts.tty ?? isInteractive())) return writeCliNotices([notice]);
  process.stderr.write(`${hostedOptionLine(where)}\n`);
}
