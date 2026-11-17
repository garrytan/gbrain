/**
 * archive-default.ts — whether the conversation archive is on for this brain (GST-2768 PR 3, decision A).
 *
 * transcripts.archive.enabled set to on or off always wins. Unset, it resolves on when the brain audience classifies
 * personal (classifyBrainAudience) and off for a shared or unknown brain, which is only offered the archive. A thin
 * client and a remote caller always resolve off: the archive reads the harness sessions of the brain host's own
 * machine. A config read failure resolves off. Nothing here writes config.
 */

import type { BrainEngine } from '../engine.ts';
import { isThinClient, loadConfigFileOnly, type GBrainConfig } from '../config.ts';
import { classifyBrainAudience, SHARED_CLIENT_THRESHOLD, type BrainAudience } from '../facts/writeback-audience.ts';
import { SERVES_DERIVED_KEY, SERVES_KEY, servesPolicyFrom } from '../search/private-visibility.ts';

export const ARCHIVE_ENABLED_KEY = 'transcripts.archive.enabled';

export interface ArchiveEnablement {
  enabled: boolean;
  /** explicit: the switch is set; default: the audience decided; the rest resolve off. */
  source: 'explicit' | 'default' | 'thin_client' | 'remote' | 'config_unreadable';
  audience: BrainAudience | null;
  /** A shared or unknown brain with the switch unset: offered with gbrain transcripts archive on, never turned on. */
  offered: boolean;
  /** GBRA-585: on by the personal default while the brain serves several people, so it can turn off by itself. */
  serves_several?: boolean;
  reason: string;
}

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export async function resolveArchiveEnabled(
  engine: Pick<BrainEngine, 'getConfig'>,
  /** config: the caller's loaded config (the commands layer passes loadConfig()); it names a thin client and may declare
   * brain.audience. Undefined reads the config file. */
  opts: { remote?: boolean; config?: GBrainConfig | null } = {},
): Promise<ArchiveEnablement> {
  const off = (source: ArchiveEnablement['source'], reason: string): ArchiveEnablement => ({ enabled: false, source, audience: null, offered: false, reason });
  if (opts.remote) return off('remote', 'a remote caller never runs the archive');
  const config = opts.config === undefined ? loadConfigFileOnly() : opts.config;
  if (isThinClient(config)) return off('thin_client', 'a thin client reads a remote brain; the archive runs on the brain host');
  let raw: string | null;
  try {
    raw = await engine.getConfig(ARCHIVE_ENABLED_KEY);
  } catch {
    return off('config_unreadable', ARCHIVE_ENABLED_KEY + ' could not be read');
  }
  const value = String(raw ?? '').trim().toLowerCase();
  if (ON.has(value)) return { enabled: true, source: 'explicit', audience: null, offered: false, reason: ARCHIVE_ENABLED_KEY + ' is on' };
  if (OFF.has(value)) return { enabled: false, source: 'explicit', audience: null, offered: false, reason: ARCHIVE_ENABLED_KEY + ' is off' };
  const { audience, reasons } = await classifyBrainAudience(engine as BrainEngine, config);
  if (audience === 'personal') {
    // GBRA-585: a brain that serves several people with brain.audience unset reads personal until its clients say otherwise; say so, so setup, status and doctor agree on why it is on and when it turns off.
    const several = await Promise.all([engine.getConfig(SERVES_KEY), engine.getConfig(SERVES_DERIVED_KEY)])
      .then(([explicit, derived]) => servesPolicyFrom({ [SERVES_KEY]: explicit ?? undefined, [SERVES_DERIVED_KEY]: derived ?? undefined }).several, () => false);
    if (several && reasons[0]?.startsWith('declared:')) return { enabled: true, source: 'default', audience, offered: false, serves_several: true,
      reason: 'on: this brain serves several people, but brain.audience is set to personal, so it stays on however many people\'s clients connect; turn it off with gbrain config set brain.audience shared (gbrain transcripts archive on|off decides it for good)' };
    if (several) return { enabled: true, source: 'default', audience, offered: false, serves_several: true,
      reason: `on for now: this brain serves several people, but brain.audience is unset and fewer than ${SHARED_CLIENT_THRESHOLD} people's clients were active in 30 days, so it reads as personal; it turns off (offered only) once ${SHARED_CLIENT_THRESHOLD} are, or now with gbrain config set brain.audience shared (gbrain transcripts archive on|off decides it for good)` };
    return { enabled: true, source: 'default', audience, offered: false, reason: 'on by default on a personal brain' };
  }
  return { enabled: false, source: 'default', audience, offered: true, reason: 'off by default on a ' + audience + ' brain; offered with gbrain transcripts archive on' };
}
