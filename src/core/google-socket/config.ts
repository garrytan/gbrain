/**
 * The socket's settings live on the file plane (~/.gbrain/config.json under
 * GBRAIN_HOME), which the broker's own uid owns, so an agent uid outside the
 * wall can neither read nor change them. Read engine-free by both start paths.
 */
import { loadConfigFileOnly, type GBrainConfig } from '../config.ts';
import { parsePeerList, type GoogleSocketConfig } from './preconditions.ts';

export const GOOGLE_SOCKET_CONFIG_KEYS = [
  'google.mint_socket', 'google.broker_act', 'google.broker_allow_root_gateway', 'google.socket_peers', 'google.broker_joint_probe',
] as const;

export function readGoogleSocketConfig(): GoogleSocketConfig {
  return (loadConfigFileOnly()?.google ?? {}) as GoogleSocketConfig;
}

const truthy = (v: string): boolean | null => (/^(1|true|on|yes)$/i.test(v.trim()) ? true : /^(0|false|off|no)$/i.test(v.trim()) ? false : null);

/** `gbrain config set google.<key> <value>`; returns the line to print, or throws with what is wrong (nothing written). */
export function setGoogleSocketConfigKey(cfg: GBrainConfig, key: string, value: string, save: (cfg: GBrainConfig) => void): string {
  const leaf = key.slice('google.'.length) as keyof GoogleSocketConfig;
  const next: GoogleSocketConfig = { ...((cfg.google ?? {}) as GoogleSocketConfig) };
  if (leaf === 'socket_peers') next.socket_peers = parsePeerList(value);
  else if (leaf === 'broker_joint_probe') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${key} is the socket protocol version the joint probe passed on (4)`);
    next.broker_joint_probe = n;
  } else {
    const on = truthy(value);
    if (on === null) throw new Error(`${key} is true or false`);
    next[leaf] = on as never;
  }
  save({ ...cfg, google: next });
  const notes: Partial<Record<keyof GoogleSocketConfig, string>> = {
    mint_socket: 'gbrain serve opens the Google socket at its next start.',
    broker_act: 'The write broker answers call only when every precondition holds: gbrain google mint status lists them.',
    broker_allow_root_gateway: 'A uid 0 peer is admitted and the GBRAIN_HOME read check is skipped; every audit line records the opt-in.',
  };
  return `Set ${key} = ${JSON.stringify(next[leaf])} (file plane: ~/.gbrain/config.json). ${notes[leaf] ?? 'Restart the socket to apply.'}`.trim();
}
