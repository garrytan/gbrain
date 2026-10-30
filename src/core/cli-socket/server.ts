/**
 * The serve side of the warm CLI socket (opt-in: `gbrain serve --cli-socket`
 * or config `serve.cli_socket`). Postgres brains only; PGLite already
 * delegates through the persistence owner socket. Every connection's peer uid
 * is read from the kernel and compared with this process's uid before a byte
 * is parsed; a platform where that cannot be read never opens the listener.
 */
import { lstatSync, unlinkSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import type { BrainEngine } from '../engine.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { getCliOptions } from '../cli-options.ts';
import { configDir, configPath } from '../config.ts';
import { tryAcquireNativeLock } from '../persistence/native-lock.ts';
import { VERSION } from '../../version.ts';
import { executeCliSocketRequest, type ExecutedRequest } from './execute.ts';
import { CliSocketUnsafeError, cliSocketDir, cliSocketPath, ensurePrivateDir, privateSocketProblem, socketPathFits, verifyBoundSocket } from './fs-guard.ts';
import { cliSocketIdentity, cliSocketIdentityMismatch, type CliSocketIdentity } from './identity.ts';
import { installOutputCapture } from './output-capture.ts';
import { refusalCounter } from './refusals.ts';
import { beginForegroundRequest } from '../foreground-activity.ts';
import { peerCredSupport, peerUid, type PeerCredSupport } from './peer-cred.ts';
import { FrameReader, isCliSocketProbe, isCliSocketRequest, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_ROUND_TRIP_MS, REQUEST_READ_TIMEOUT_MS,
  type CliSocketRequest, type HandshakeFrame, type ResultFrame } from './protocol.ts';

const MAX_CONNECTIONS = 32;
const MAX_ACTIVE_REQUESTS = 8;

export interface CliSocketBinding { path: string; close(): void }

export interface CliSocketServerOptions {
  engine: BrainEngine;
  log: (line: string) => void;
  /** Test seams; production derives each from this process. */
  peerCred?: PeerCredSupport;
  home?: string;
  identity?: CliSocketIdentity;
  uid?: () => number | undefined;
  brainId?: () => string;
  execute?: (request: CliSocketRequest, signal: AbortSignal) => Promise<ExecutedRequest>;
  /** After this long a request whose work has not settled is logged once (its slot is still held). */
  stuckAfterMs?: number;
}

/**
 * serve's entry, called only when the socket was asked for (`--cli-socket`, or `serve.cli_socket` in the connect-time
 * config merge): serve decides that without loading this module. Logs (never throws) when it cannot open the socket.
 */
export async function startCliSocket(engine: BrainEngine, log: (line: string) => void): Promise<CliSocketBinding | null> {
  try { return await startCliSocketServer({ engine, log }); }
  catch (error) { log(`[gbrain serve] cli-socket: not started: ${(error as Error).message}`); return null; }
}

function frame(value: HandshakeFrame | ResultFrame): string {
  const text = JSON.stringify(value) + '\n';
  return Buffer.byteLength(text) > MAX_RESPONSE_BYTES ? JSON.stringify({ v: 1, kind: 'fallback', reason: 'response_too_large' }) + '\n' : text;
}

/** True when `path` answers a connect, i.e. another serve owns it. */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createConnection(path);
    const done = (live: boolean) => { clearTimeout(timer); probe.destroy(); resolve(live); };
    const timer = setTimeout(() => done(false), 200);
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
}

/** Proves the platform reader returns this process's uid on a real accepted socket before any real listener exists. */
async function peerCredSelfTest(dir: string, support: Extract<PeerCredSupport, { ok: true }>, uid: number): Promise<boolean> {
  const path = `${dir}/p${process.pid}`;
  try { unlinkSync(path); } catch { /* absent */ }
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      try { unlinkSync(path); } catch { /* already gone */ }
      resolve(ok);
    };
    const server = net.createServer(socket => { const seen = peerUid(socket, support.read); socket.destroy(); finish(seen === uid); });
    const timer = setTimeout(() => finish(false), 2_000);
    server.once('error', () => finish(false));
    server.listen(path, () => { const client = net.createConnection(path); client.once('error', () => finish(false)); });
  });
}

/**
 * Binds the socket when it is safe to: peer credentials verified on this
 * platform, a private run directory, no live owner. Returns null (with one log
 * line saying why) when it does not bind; never throws into the serve.
 */
export async function startCliSocketServer(opts: CliSocketServerOptions): Promise<CliSocketBinding | null> {
  const log = (line: string) => opts.log(`[gbrain serve] cli-socket: ${line}`);
  const uid = (opts.uid ?? (() => process.getuid?.()))();
  if (opts.engine.kind !== 'postgres') { log('not started: the CLI socket serves Postgres brains only (PGLite CLI calls already reach a running serve).'); return null; }
  let brainId: string;
  try { brainId = (opts.brainId ?? (() => resolveBrainId(getCliOptions().brain)))(); }
  catch (error) { log(`not started: the serve's brain cannot be resolved (${(error as Error).message}).`); return null; }
  if (brainId !== 'host') { log(`not started: this serve is on mount brain "${brainId}"; the CLI socket serves the host brain only.`); return null; }
  const databaseUrl = (opts.engine as { connectedDatabaseUrl?: string }).connectedDatabaseUrl;
  if (!databaseUrl) { log('not started: the engine does not report the database it connected to.'); return null; }
  const support = opts.peerCred ?? peerCredSupport();
  if (!support.ok || uid === undefined) { log(`not started: peer credentials cannot be verified on this platform (${support.ok ? 'no POSIX uid' : support.reason}).`); return null; }
  const home = opts.home ?? configDir();
  const dir = cliSocketDir(home);
  const path = cliSocketPath(home);
  if (!socketPathFits(path) || !socketPathFits(`${dir}/p${process.pid}`)) { log(`not started: ${path} is longer than a Unix socket address allows.`); return null; }
  try { ensurePrivateDir(dir); }
  catch (error) { log(`not started: ${(error as Error).message}`); return null; }
  if (!await peerCredSelfTest(dir, support, uid)) { log('not started: the peer-credential self-test did not return this process\'s uid.'); return null; }

  let lock: Awaited<ReturnType<typeof tryAcquireNativeLock>>;
  try { lock = await tryAcquireNativeLock(`${path}.bind.lock`); }
  catch (error) { log(`not started: the bind lock is unavailable (${(error as Error).message}).`); return null; }
  if (!lock) { log('not started: another serve holds the CLI socket for this GBRAIN_HOME.'); return null; }
  const problem = privateSocketProblem(path);
  if (problem !== 'missing') {
    if (problem && problem !== 'open_permissions') { await lock.release(); log(`not started: ${new CliSocketUnsafeError(problem, path).message}`); return null; }
    if (await socketAnswers(path)) { await lock.release(); log('not started: another serve already answers the CLI socket.'); return null; }
    unlinkSync(path);
  }

  const identity = opts.identity ?? cliSocketIdentity({
    config: { engine: 'postgres', database_url: databaseUrl }, brainId, configDir: home, configFile: configPath(), version: VERSION, env: process.env,
  });
  const execute = opts.execute ?? ((request: CliSocketRequest, signal: AbortSignal) => executeCliSocketRequest(opts.engine, request, signal));
  installOutputCapture();

  const sockets = new Set<Socket>();
  let active = 0;
  let closing = false;
  const rejectedUids = new Set<number | null>();
  const loggedMismatches = new Set<string>();
  const refusals = refusalCounter(dir);
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    if (closing || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    const peer = peerUid(socket, support.read);
    if (peer !== uid) {
      if (!rejectedUids.has(peer)) { rejectedUids.add(peer); log(`rejected a connection from ${peer === null ? 'an unverifiable peer' : `uid ${peer}`}.`); }
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const reader = new FrameReader(MAX_REQUEST_BYTES);
    const readTimer = setTimeout(() => socket.destroy(), REQUEST_READ_TIMEOUT_MS);
    readTimer.unref();
    let handled = false;
    socket.on('data', data => {
      if (handled) return;
      const frames = reader.push(typeof data === 'string' ? Buffer.from(data) : data);
      if (frames === 'overflow') { handled = true; socket.destroy(); return; }
      if (frames.length === 0) return;
      handled = true;
      clearTimeout(readTimer);
      void (async () => {
        let request: unknown;
        try { request = JSON.parse(frames[0]!); } catch { request = null; }
        if (isCliSocketProbe(request)) {
          const mismatch = cliSocketIdentityMismatch(identity, request.identity);
          socket.end(frame(mismatch ? { v: 1, accepted: false, reason: 'identity_mismatch', mismatch } : { v: 1, accepted: true }));
          return;
        }
        if (!isCliSocketRequest(request)) { socket.end(frame({ v: 1, accepted: false, reason: 'malformed_request' })); return; }
        const mismatch = cliSocketIdentityMismatch(identity, request.identity);
        if (mismatch) {
          if (!loggedMismatches.has(mismatch)) { loggedMismatches.add(mismatch); log(`refused a CLI call: identity_mismatch (${mismatch} differs from this serve's); that CLI takes its cold path.`); }
          refusals.record(mismatch);
          socket.end(frame({ v: 1, accepted: false, reason: 'identity_mismatch', mismatch }));
          return;
        }
        if (active >= MAX_ACTIVE_REQUESTS) { socket.end(frame({ v: 1, accepted: false, reason: 'busy' })); return; }
        // Active until the request's own work settles, not until it answered: a timed-out handler still holds its slot.
        active++;
        const finishForeground = beginForegroundRequest();
        const started = performance.now();
        let settled: Promise<unknown> = Promise.resolve();
        // GBRA-156: a client that goes away before its answer cancels the request's remaining work and frees its connections.
        const cancel = new AbortController();
        let answered = false;
        socket.once('close', () => {
          if (answered || cancel.signal.aborted) return;
          cancel.abort(new Error('client_disconnected'));
          log(`a ${request.command} request's client disconnected after ${Math.round(performance.now() - started)} ms; its remaining work is cancelled.`);
        });
        try {
          socket.write(frame({ v: 1, accepted: true }));
          let result: ResultFrame;
          try { ({ frame: result, settled } = await execute(request, cancel.signal)); }
          catch { result = { v: 1, kind: 'fallback', reason: 'serve_error' }; }
          answered = true;
          if (!socket.destroyed) socket.end(frame(result));
        } finally {
          let done = false;
          const stuck = setTimeout(() => {
            if (!done) log(`a ${request.command} request is still running ${Math.round((performance.now() - started) / 1000)} s after it started; its slot stays held until it finishes (${active} of ${MAX_ACTIVE_REQUESTS} in use).`);
          }, Math.max(0, (opts.stuckAfterMs ?? MAX_ROUND_TRIP_MS) - (performance.now() - started)));
          stuck.unref();
          void settled.then(() => { done = true; clearTimeout(stuck); active--; finishForeground(); }, () => { done = true; clearTimeout(stuck); active--; finishForeground(); });
        }
      })();
    });
  });

  const bound = await new Promise<boolean>(resolve => {
    server.once('error', () => resolve(false));
    // listen() binds synchronously; under umask 0177 the kernel creates the socket 0600, so nothing is chmod'ed afterwards.
    const umask = process.umask(0o177);
    try { server.listen(path, () => resolve(true)); }
    finally { process.umask(umask); }
  });
  if (!bound) { await lock.release(); log(`not started: could not bind ${path}.`); return null; }
  server.on('error', () => {});
  let inode: number;
  try { inode = verifyBoundSocket(path); }
  catch (error) { server.close(); await lock.release(); log(`not started: ${path} did not become a private socket (${(error as Error).message}).`); return null; }
  const close = () => {
    if (closing) return;
    closing = true;
    process.off('exit', close);
    refusals.flush();
    server.close();
    for (const socket of sockets) socket.destroy();
    try { if (lstatSync(path).ino === inode) unlinkSync(path); } catch { /* already gone */ }
    void lock!.release();
  };
  process.once('exit', close);
  log(`listening on ${path} (read ops: search, query, get, recall).`);
  return { path, close };
}
