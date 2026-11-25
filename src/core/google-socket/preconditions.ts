/**
 * The write broker's activation gate, checked inside the socket module so
 * both start paths (`gbrain google mint serve` and `gbrain serve` with
 * `google.mint_socket`) enforce it. `call` stays off (`broker_precondition_unmet`)
 * unless every item holds; each unmet item names the config line that fixes it.
 *
 *  - `google.broker_act` is true (default false).
 *  - `google.socket_peers` names the peer uids explicitly.
 *  - The agent's uid cannot read GBRAIN_HOME: no peer is this process's uid or
 *    root, and GBRAIN_HOME has no group or other access. With
 *    `google.broker_allow_root_gateway` (default false) a uid 0 peer is
 *    admitted and this check is skipped, because root reads everything; the
 *    opt-in is recorded on every audit line.
 *  - `google.broker_joint_probe` records protocol 4, set by the owner once the
 *    joint compatibility probe with the caller's plugin passed.
 *
 * The isolated verdict channel is `gbrain google approvals` run by the owner,
 * which always exists.
 */
import { statSync } from 'node:fs';
import { GOOGLE_SOCKET_VERSION } from './protocol.ts';
import type { GateResult } from './broker.ts';

export interface GoogleSocketConfig {
  mint_socket?: boolean;
  broker_act?: boolean;
  broker_allow_root_gateway?: boolean;
  socket_peers?: number[];
  broker_joint_probe?: number;
}

export function brokerGate(cfg: GoogleSocketConfig, ownerUid: number, home: string, homeMode: (path: string) => number = p => statSync(p).mode): GateResult {
  const unmet: string[] = [];
  const rootGateway = cfg.broker_allow_root_gateway === true;
  if (cfg.broker_act !== true) unmet.push('google.broker_act is false (gbrain config set google.broker_act true)');
  const peers = cfg.socket_peers ?? [];
  if (peers.length === 0) unmet.push('no peer uid is allowed (gbrain config set google.socket_peers <uid>[,<uid>])');
  if (ownerUid === 0) unmet.push('the broker runs as root, so its owner-only approval channel cannot be told apart from a root caller; run it as its own non-root uid');
  if (peers.includes(ownerUid)) unmet.push(`peer uid ${ownerUid} is this process's own uid, so the agent could read the vault and answer its own prompts; run the broker as its own uid`);
  if (!rootGateway) {
    if (peers.includes(0)) unmet.push('uid 0 is a peer; a root gateway needs gbrain config set google.broker_allow_root_gateway true');
    let mode = 0o777;
    try { mode = homeMode(home); } catch { /* unreadable counts as open */ }
    if ((mode & 0o077) !== 0) unmet.push(`${home} is readable by other users (chmod 700 ${home})`);
  }
  if (cfg.broker_joint_probe !== GOOGLE_SOCKET_VERSION) {
    unmet.push(`the joint compatibility probe has not been recorded for protocol ${GOOGLE_SOCKET_VERSION} (gbrain config set google.broker_joint_probe ${GOOGLE_SOCKET_VERSION})`);
  }
  return { ok: unmet.length === 0, unmet, rootGateway };
}

/** Uids the socket admits: this process's own (the owner) plus the configured peers. */
export function allowedPeers(cfg: GoogleSocketConfig, ownerUid: number): Set<number> {
  return new Set([ownerUid, ...(cfg.socket_peers ?? [])]);
}

/** Parses `google.socket_peers` (comma-separated uids). */
export function parsePeerList(value: string): number[] {
  const uids = value.split(',').map(s => s.trim()).filter(Boolean).map(s => Number(s));
  if (uids.length === 0 || uids.some(n => !Number.isInteger(n) || n < 0)) throw new Error('google.socket_peers is a comma-separated list of uids, e.g. 1001 or 0');
  return [...new Set(uids)];
}
