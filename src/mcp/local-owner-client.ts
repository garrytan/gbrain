/** stdio stays the public interface; no database connection, port or token setup in clients. */
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../core/config.ts';
import { probeLivePgliteHolder } from '../core/bootstrap/uninstall.ts';
import { acquireNativeLock } from '../core/persistence/native-lock.ts';
import { clampSurface, parseAccessFlag, parseSurfaceFlag, resolveStdioSurface, SURFACE_SOURCE_LABEL } from './surface.ts';
import { localOwnerPaths, ownerProof, prepareOwnerDirectory, readOwnerRecord, type LocalOwnerRecord } from './local-owner-state.ts';
class SessionRejectedError extends Error {}

export async function connectLocalOwner(record: LocalOwnerRecord, context: object): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: record.port });
    socket.setTimeout(5000, () => socket.destroy(new Error('Local MCP owner handshake timed out')));
    let buffer = '';
    let proved = false;
    const nonce = randomBytes(32).toString('hex');
    let challenge = '';
    const onError = (error: Error) => { socket.destroy(); reject(error); };
    socket.once('error', onError);
    socket.once('connect', () => socket.write(JSON.stringify({ nonce }) + '\n'));
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4096) return onError(new Error('Invalid local MCP owner handshake'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (!proved) {
        try {
          const hello = JSON.parse(buffer.slice(0, newline));
          if (typeof hello.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(hello.challenge)
            || hello.proof !== ownerProof(record.secret, 'server', hello.challenge, `${nonce}:${record.identity}`)) throw new Error('Local MCP owner authentication failed');
          challenge = hello.challenge;
          proved = true; buffer = buffer.slice(newline + 1);
          socket.write(JSON.stringify({ protocol: 1, identity: record.identity, challenge: hello.challenge, session: context,
            proof: ownerProof(record.secret, 'client', hello.challenge, `${nonce}:${JSON.stringify(context)}`) }) + '\n');
        } catch { onError(new Error('Local MCP owner authentication failed')); }
        return;
      }
      socket.pause(); socket.off('data', onData); socket.off('error', onError); socket.setTimeout(0);
      try {
        const ready = JSON.parse(buffer.slice(0, newline));
        if (ready.ok !== true || ready.proof !== ownerProof(record.secret, 'server', challenge, `ready:${nonce}:${record.identity}`)) throw new Error('not ready');
      } catch { return onError(new SessionRejectedError('Local MCP owner could not attach this session. Check its source binding (GBRAIN_SOURCE) and configuration.')); }
      if (buffer.length > newline + 1) socket.unshift(Buffer.from(buffer.slice(newline + 1)));
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('end', () => onError(new Error('Local MCP owner closed during handshake')));
  });
}

function startOwner(): void {
  // Reuse the exact running version, including source checkouts and compiled binaries.
  const script = process.argv[1];
  const prefix = script && existsSync(script) && /\.[cm]?[jt]s$/.test(script) ? ['--no-env-file', script] : [];
  const env: NodeJS.ProcessEnv = { ...process.env, GBRAIN_BRAIN_ID: 'host' };
  delete env.GBRAIN_SOURCE;
  delete env.GBRAIN_SURFACE;
  delete env.GBRAIN_MCP_FORCE_SURFACE;
  const child = spawn(process.execPath, [...prefix, '--brain', 'host', 'serve', '--local-owner'],
    { env, cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

/** Return false for transports/engines whose original lifecycle must remain in charge. */
export async function serveViaLocalOwner(args: string[]): Promise<boolean> {
  if (args.includes('--http') && parseAccessFlag(args) === 'read-only') {
    throw new Error('--access read-only applies to stdio serve only; for HTTP narrow each token with gbrain auth rescope-token <name> --operations <op,...>');
  }
  if (args.includes('--http') || args.includes('--direct') || args.includes('--local-owner')) return false;
  const paths = localOwnerPaths();
  if (!paths) return false;
  const { parseStdioIdleTimeout, resolveEofDrainMs, readLiveParentPid } = await import('../commands/serve.ts');
  const idleSeconds = parseStdioIdleTimeout(args);
  const resolved = resolveStdioSurface(parseSurfaceFlag(args), loadConfig());
  const context = { cwd: process.cwd(), envSource: process.env.GBRAIN_SOURCE,
    surface: clampSurface(resolved.surface), surfaceSource: resolved.source, invalidSurfaceEnv: resolved.invalidEnv,
    access: parseAccessFlag(args), sourceGuard: args.includes('--source-guard') };
  const lock = await acquireNativeLock(paths.lock, { timeoutMs: 90_000 });
  if (!lock) throw new Error('Timed out waiting for the local MCP owner startup');
  let socket: Socket | undefined;
  try {
    await prepareOwnerDirectory(paths.directory);
    const existing = readOwnerRecord(paths.record);
    const holder = probeLivePgliteHolder(paths.database);
    // A previously configured HTTP/direct server retains its status/recovery contract.
    if (holder && (!existing || holder.pid !== existing.pid)) return false;
    if (existing) {
      // Never adopt a live owner from a different installation/configuration.
      if (existing.identity !== paths.identity) {
        try { process.kill(existing.pid, 0); throw new Error('A local MCP owner is running with different settings; close its sessions before changing settings.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      } else {
        try { socket = await connectLocalOwner(existing, context); }
        catch (error) { if (error instanceof SessionRejectedError) throw error; /* stale listener: DB lock still protects startup */ }
      }
    }
    if (!socket) {
      startOwner();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const record = readOwnerRecord(paths.record);
        if (record?.identity === paths.identity) {
          try { socket = await connectLocalOwner(record, context); break; }
          catch (error) { if (error instanceof SessionRejectedError) throw error; /* boot still in progress */ }
        }
        await delay(100);
      }
      if (!socket) throw new Error('Local MCP owner did not become ready. Run gbrain serve --direct to inspect the database startup error.');
    }
  } finally { await lock.release(); }
  if (resolved.invalidEnv !== undefined) console.error(`[gbrain serve] ignoring GBRAIN_SURFACE="${resolved.invalidEnv}" (use verbs | starter | full)`);
  console.error(`[gbrain serve] surface=${context.surface} (source: ${SURFACE_SOURCE_LABEL[resolved.source]})`);
  const active = socket;
  await new Promise<void>((resolve, reject) => {
    const pending = new Set<string>();
    let ended = false;
    let outputPaused = false;
    let requestBuffer = '', responseBuffer = '';
    const requestDecoder = new StringDecoder('utf8'), responseDecoder = new StringDecoder('utf8');
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const parent = readLiveParentPid();
    const watchdog = setInterval(() => { if (readLiveParentPid() !== parent) close(); }, 5000);
    const close = () => {
      clearInterval(watchdog); clearTimeout(idleTimer); clearTimeout(drainTimer);
      process.stdin.unpipe(active); active.destroy(); resolve();
    };
    const rearm = () => { if (idleSeconds) { clearTimeout(idleTimer); idleTimer = setTimeout(close, idleSeconds * 1000); } };
    const observe = (chunk: Buffer | string, responses: boolean) => {
      const text = typeof chunk === 'string' ? chunk : (responses ? responseDecoder : requestDecoder).write(chunk);
      let buffer = (responses ? responseBuffer : requestBuffer) + text;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        let diagnostic = false;
        try {
          const message = JSON.parse(buffer.slice(0, at));
          if (responses && message.method === 'gbrain/local_owner_stderr' && typeof message.params?.line === 'string') {
            process.stderr.write(message.params.line);
            diagnostic = true;
          }
          if (typeof message.id === 'number' || typeof message.id === 'string') {
            const id = JSON.stringify(message.id);
            if (responses) pending.delete(id); else if (typeof message.method === 'string') pending.add(id);
          }
        } catch { /* The SDK owns protocol validation; tracking never changes wire bytes. */ }
        if (responses && !diagnostic && !process.stdout.write(buffer.slice(0, at + 1)) && !outputPaused) {
          outputPaused = true; active.pause();
          process.stdout.once('drain', () => { outputPaused = false; if (!active.destroyed) active.resume(); });
        }
        buffer = buffer.slice(at + 1);
      }
      if (buffer.length > 10 * 1024 * 1024) { close(); return; }
      if (responses) responseBuffer = buffer; else requestBuffer = buffer;
      rearm();
      if (ended && !pending.size) queueMicrotask(close);
    };
    const eof = () => {
      if (process.env.MCP_STDIO === '1' || ended) return;
      ended = true;
      if (!pending.size) close(); else drainTimer = setTimeout(close, resolveEofDrainMs());
    };
    active.once('error', reject);
    active.once('close', close);
    process.stdin.once('end', eof);
    process.stdin.once('close', eof);
    process.once('SIGTERM', close); process.once('SIGINT', close);
    // Piping happens only after the owner attached the SDK transport; no initialize frame is lost.
    active.on('data', chunk => observe(chunk, true));
    process.stdin.on('data', chunk => observe(chunk, false));
    process.stdin.pipe(active, { end: false });
    active.resume();
    rearm();
  });
  (await import('../core/cli-force-exit.ts')).flushThenExit(0);
  return true;
}
