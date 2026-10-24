/**
 * GBRA-175: the warm CLI socket's probe, which the upgrade restart uses to check that the running serve accepts the
 * installed build. Kept apart from src/cli/cli-socket-client.ts, whose op rendering reaches the whole CLI.
 */
import net from 'node:net';
import { loadConfig, configDir, configPath, isThinClient } from '../config.ts';
import { getCliOptions } from '../cli-options.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { VERSION } from '../../version.ts';
import { cliSocketDir, cliSocketPath, connectProblem } from './fs-guard.ts';
import { cliSocketIdentity } from './identity.ts';
import { peerCredSupport, peerUid, type PeerCredSupport } from './peer-cred.ts';
import { CONNECT_TIMEOUT_MS, FrameReader, HANDSHAKE_TIMEOUT_MS, isHandshakeFrame, MAX_RESPONSE_BYTES, type CliSocketProbe } from './protocol.ts';
import type { WarmSocketState } from '../upgrade-restart.ts';

/**
 * GBRA-175: whether the running serve's warm socket accepts this build and this shell's brain identity. Handshake only:
 * the serve runs nothing. `absent` when this brain has no socket (not Postgres, a thin client, or serve runs without
 * --cli-socket); a socket file nobody answers is `refused` (`connect_failed`), so a serve that did not come back shows.
 */
export function probeCliSocket(peerCred: PeerCredSupport = peerCredSupport()): Promise<WarmSocketState> {
  const config = loadConfig();
  if (!config || config.engine !== 'postgres' || !config.database_url || isThinClient(config)) return Promise.resolve({ state: 'absent' });
  const home = configDir();
  const path = cliSocketPath(home);
  const problem = connectProblem(path, cliSocketDir(home));
  if (problem === 'missing') return Promise.resolve({ state: 'absent' });
  if (problem) return Promise.resolve({ state: 'refused', reason: problem });
  if (!peerCred.ok) return Promise.resolve({ state: 'refused', reason: `peer_credentials_unsupported (${peerCred.reason})` });
  const support = peerCred;
  let brainId: string;
  try { brainId = resolveBrainId(getCliOptions().brain); } catch (error) { return Promise.resolve({ state: 'refused', reason: `brain_unresolved (${(error as Error).message})` }); }
  const probe: CliSocketProbe = { v: 1, kind: 'probe', identity: cliSocketIdentity({ config, brainId, configDir: home, configFile: configPath(), version: VERSION, env: process.env }) };
  return new Promise(resolve => {
    const socket = net.createConnection(path);
    const reader = new FrameReader(MAX_RESPONSE_BYTES);
    const finish = (state: WarmSocketState) => { clearTimeout(timer); socket.destroy(); resolve(state); };
    const timer = setTimeout(() => finish({ state: 'refused', reason: 'handshake_timeout' }), CONNECT_TIMEOUT_MS + HANDSHAKE_TIMEOUT_MS);
    socket.once('error', error => finish({ state: 'refused', reason: `connect_failed (${(error as NodeJS.ErrnoException).code ?? error.message})` }));
    socket.once('close', () => finish({ state: 'refused', reason: 'serve_closed' }));
    socket.once('connect', () => {
      if (peerUid(socket, support.read) !== process.getuid?.()) { finish({ state: 'refused', reason: 'serve_uid_mismatch' }); return; }
      socket.write(JSON.stringify(probe) + '\n');
    });
    socket.on('data', data => {
      const frames = reader.push(typeof data === 'string' ? Buffer.from(data) : data);
      if (frames === 'overflow') { finish({ state: 'refused', reason: 'response_too_large' }); return; }
      if (!frames.length) return;
      let value: unknown;
      try { value = JSON.parse(frames[0]!); } catch { value = null; }
      if (!isHandshakeFrame(value)) finish({ state: 'refused', reason: 'malformed_response' });
      else if (value.accepted) finish({ state: 'accepted' });
      else finish({ state: 'refused', reason: value.reason, ...(value.mismatch ? { mismatch: value.mismatch } : {}) });
    });
  });
}
