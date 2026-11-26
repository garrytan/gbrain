/**
 * The Google token socket: `configDir()/run/google.sock`, beside cli.sock,
 * started by `gbrain google mint serve` or by `gbrain serve` when
 * `google.mint_socket` is true. A Unix socket only (never TCP), bound 0600 in
 * the private run directory under GBRAIN_HOME. Every connection's peer uid is
 * read from the kernel (src/core/peer-cred.ts) and must be the owner (this
 * process's uid) or a configured peer; a platform where it cannot be read
 * never opens the socket. Only the owner may list or answer held prompts.
 * Not an operation: remote MCP callers can never reach it.
 */
import { lstatSync, unlinkSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import { join } from 'node:path';
import { configDir } from '../config.ts';
import { cliSocketDir, CliSocketUnsafeError, ensurePrivateDir, privateSocketProblem, socketPathFits, verifyBoundSocket } from '../cli-socket/fs-guard.ts';
import { openVault, type CredentialVault } from '../creds/vault.ts';
import type { FetchImpl } from '../creds/providers/google.ts';
import { tryAcquireNativeLock } from '../persistence/native-lock.ts';
import { peerCredSupport, peerUid, type PeerCredSupport } from '../peer-cred.ts';
import { GoogleBroker } from './broker.ts';
import { BrokerLedger, brokerStatePath, openAuditLog } from './ledger.ts';
import { GoogleMcpClient } from './mcp-client.ts';
import { allowedPeers, brokerGate, type GoogleSocketConfig } from './preconditions.ts';
import { GOOGLE_SOCKET_VERSION, LineReader, SocketError, failure, parseRequest } from './protocol.ts';
import { SocketTokens } from './tokens.ts';

const MAX_CONNECTIONS = 32;
const MAX_QUEUED_PER_CONNECTION = 16;
const IDLE_CONNECTION_MS = 5 * 60_000;
const MINTS_PER_MINUTE = 120;

export const googleSocketPath = (home: string = configDir()): string => join(cliSocketDir(home), 'google.sock');
export const googleAuditPath = (home: string = configDir()): string => join(home, 'logs', 'google-mint.log');

export interface GoogleSocketOptions {
  log: (line: string) => void;
  config: () => GoogleSocketConfig;
  /** Test seams; production derives each from this process. */
  home?: string;
  vault?: CredentialVault;
  fetchImpl?: FetchImpl;
  mcp?: GoogleMcpClient;
  peerCred?: PeerCredSupport;
  uid?: () => number | undefined;
  now?: () => number;
}

export interface GoogleSocketBinding { path: string; close(): void; broker: GoogleBroker }
export type GoogleSocketStart = { ok: true; binding: GoogleSocketBinding } | { ok: false; reason: string };

/** `gbrain serve`'s entry when `google.mint_socket` is true: logs (never throws) when the socket does not open. */
export async function startGoogleSocketForServe(log: (line: string) => void): Promise<GoogleSocketBinding | null> {
  const { readGoogleSocketConfig } = await import('./config.ts');
  try {
    const started = await startGoogleSocket({ log: line => log(`[gbrain serve] ${line}`), config: readGoogleSocketConfig });
    return started.ok ? started.binding : null;
  } catch (error) {
    log(`[gbrain serve] google socket: not started: ${(error as Error).message}`);
    return null;
  }
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createConnection(path);
    const done = (live: boolean) => { clearTimeout(timer); probe.destroy(); resolve(live); };
    const timer = setTimeout(() => done(false), 200);
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
}

export async function startGoogleSocket(opts: GoogleSocketOptions): Promise<GoogleSocketStart> {
  const no = (reason: string): GoogleSocketStart => { opts.log(`google socket: not started: ${reason}`); return { ok: false, reason }; };
  const uid = (opts.uid ?? (() => process.getuid?.()))();
  const support = opts.peerCred ?? peerCredSupport();
  if (!support.ok || uid === undefined) return no(`peer credentials cannot be verified on this platform (${support.ok ? 'no POSIX uid' : support.reason})`);
  const home = opts.home ?? configDir();
  const dir = cliSocketDir(home);
  const path = googleSocketPath(home);
  if (!socketPathFits(path)) return no(`${path} is longer than a Unix socket address allows (move GBRAIN_HOME to a shorter path)`);
  try { ensurePrivateDir(dir); }
  catch (error) { return no((error as Error).message); }

  let lock: Awaited<ReturnType<typeof tryAcquireNativeLock>>;
  try { lock = await tryAcquireNativeLock(`${path}.bind.lock`); }
  catch (error) { return no(`the bind lock is unavailable (${(error as Error).message})`); }
  if (!lock) return no('another process already serves the Google socket for this GBRAIN_HOME');
  const problem = privateSocketProblem(path);
  if (problem !== 'missing') {
    if (problem && problem !== 'open_permissions') { await lock.release(); return no(new CliSocketUnsafeError(problem, path).message); }
    if (await socketAnswers(path)) { await lock.release(); return no('another process already answers the Google socket'); }
    unlinkSync(path);
  }

  const now = opts.now ?? Date.now;
  const vault = opts.vault ?? openVault();
  const tokens = new SocketTokens(vault, opts.fetchImpl ?? fetch, now);
  const audit = openAuditLog(googleAuditPath(home), now);
  const ledger = new BrokerLedger(brokerStatePath(home), now);
  const broker = new GoogleBroker({
    tokens, client: opts.mcp ?? new GoogleMcpClient(opts.fetchImpl ?? fetch), ledger, audit,
    gate: () => {
      const gate = brokerGate(opts.config(), uid, home);
      return ledger.unreadable ? { ...gate, ok: false, unmet: [...gate.unmet, ledger.unreadable] } : gate;
    }, now,
  });
  const mintTimes = new Map<number, number[]>();
  const rejected = new Set<number | null>();
  const sockets = new Set<Socket>();
  let closing = false;

  async function handle(line: string, peer: number): Promise<Record<string, unknown>> {
    let request;
    try { request = parseRequest(JSON.parse(line)); }
    catch (error) {
      const e = error instanceof SocketError ? error : new SocketError('malformed_request', 'a request is one JSON object per line');
      return failure(crypto.randomUUID(), e.code, e.message, e.extra);
    }
    switch (request.op) {
      case 'mint': {
        const id = crypto.randomUUID();
        if (request.profile !== 'ingest') {
          audit([request.caller, request.account, request.profile, 'act_not_mintable']);
          return failure(id, 'act_not_mintable', 'only the read-only "ingest" profile is minted; write actions go through op "call"');
        }
        const t = now();
        const recent = (mintTimes.get(peer) ?? []).filter(x => t - x < 60_000);
        if (recent.length >= MINTS_PER_MINUTE) {
          audit([request.caller, request.account, 'ingest', 'rate_limited']);
          return failure(id, 'rate_limited', `more than ${MINTS_PER_MINUTE} mints a minute from uid ${peer}; cache the token until 5 minutes before expires_at`, { retry_after_s: 60 });
        }
        mintTimes.set(peer, [...recent, t]);
        try {
          const minted = await tokens.mintIngest(request.account);
          audit([request.caller, request.account, 'ingest', 'ok']);
          return { v: GOOGLE_SOCKET_VERSION, ok: true, request_id: id, ...minted };
        } catch (error) {
          const e = error as SocketError;
          audit([request.caller, request.account, 'ingest', e.code]);
          return failure(id, e.code, e.message);
        }
      }
      case 'call':
        if (peer === uid) return failure(crypto.randomUUID(), 'peer_refused', 'op call comes from an agent uid listed in google.socket_peers, never from the broker owner, whose channel approves the calls');
        return broker.call(request);
      case 'status': return broker.status(request);
      case 'tools': return broker.tools(request);
      case 'pending':
      case 'verdict':
        if (peer !== uid) return failure(crypto.randomUUID(), 'peer_refused', 'held prompts are listed and answered only by the owner (gbrain google approvals)');
        return request.op === 'pending' ? broker.pending() : broker.verdict(request);
    }
  }

  const server = net.createServer(socket => {
    socket.on('error', () => {});
    if (closing || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    const peer = peerUid(socket, support.read);
    if (peer === null || !allowedPeers(opts.config(), uid).has(peer)) {
      if (!rejected.has(peer)) { rejected.add(peer); opts.log(`google socket: refused a connection from ${peer === null ? 'an unverifiable peer' : `uid ${peer}`} (not in google.socket_peers)`); }
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_CONNECTION_MS, () => socket.destroy());
    const reader = new LineReader();
    let chain = Promise.resolve();
    let queued = 0;
    socket.on('data', (chunk: string) => {
      const lines = reader.push(chunk);
      if (lines === 'overflow') { socket.destroy(); return; }
      for (const line of lines) {
        if (++queued > MAX_QUEUED_PER_CONNECTION) { socket.destroy(); return; }
        chain = chain.then(async () => {
          try {
            if (socket.destroyed) return;
            let reply: Record<string, unknown>;
            try { reply = await handle(line, peer); }
            catch (error) { reply = failure(crypto.randomUUID(), 'internal', (error as Error).message); }
            if (!socket.destroyed && !socket.write(JSON.stringify(reply) + '\n')) {
              await new Promise<void>(resolve => { socket.once('drain', resolve); socket.once('close', resolve); });
            }
          } finally { queued--; }
        });
      }
    });
  });

  const bound = await new Promise<boolean>(resolve => {
    server.once('error', () => resolve(false));
    const umask = process.umask(0o177);
    try { server.listen(path, () => resolve(true)); }
    finally { process.umask(umask); }
  });
  if (!bound) { await lock.release(); return no(`could not bind ${path}`); }
  server.on('error', () => {});
  let inode: number;
  try { inode = verifyBoundSocket(path); }
  catch (error) { server.close(); await lock.release(); return no(`${path} did not become a private socket (${(error as Error).message})`); }
  const close = () => {
    if (closing) return;
    closing = true;
    process.off('exit', close);
    server.close();
    for (const s of sockets) s.destroy();
    try { if (lstatSync(path).ino === inode) unlinkSync(path); } catch { /* already gone */ }
    void lock!.release();
  };
  process.once('exit', close);
  const cfg = opts.config();
  const gate = brokerGate(cfg, uid, home);
  const foreign = (cfg.socket_peers ?? []).filter(p => p !== uid && p !== 0);
  if (foreign.length) opts.log(`google socket: peer uid ${foreign.join(', ')} cannot open a 0600 socket another uid owns; this release serves the owner and root only`);
  opts.log(`google socket: listening on ${path} (protocol v${GOOGLE_SOCKET_VERSION}; mint on; call ${gate.ok ? `on${gate.rootGateway ? ', root-gateway opt-in' : ''}` : 'off'})`);
  return { ok: true, binding: { path, close, broker } };
}
