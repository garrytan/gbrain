/** One PGLite engine, independent MCP servers and source/surface state per local chat. */
import { createServer, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer, stdioRpcsInFlightCount, resolveMcpStdioSourceScope } from './server.ts';
import { localOwnerPaths, ownerProof, prepareOwnerDirectory, readOwnerRecord, writeOwnerRecord } from './local-owner-state.ts';
import { loadConfig } from '../core/config.ts';
import { bindResolveIpcForServe } from './resolve-ipc-binding.ts';
import { createPersistenceIpcProvider, residentPersistenceConfig } from '../core/persistence/provider.ts';
import { armStartupSweep } from '../core/sweep.ts';
import type { ResolveIpcBinding } from './resolve-ipc-binding.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { gcSessionContextState } from '../core/context/session-state.ts';
import { startOnboardingRefresher } from '../core/onboard/mcp-onboarding.ts';

function authorized(raw: unknown): raw is {
  cwd: string; envSource?: string; surface: 'verbs' | 'starter' | 'full'; surfaceSource: 'env' | 'flag' | 'config' | 'default';
  invalidSurfaceEnv?: string; access: 'full' | 'read-only'; sourceGuard: boolean;
} {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return typeof r.cwd === 'string' && isAbsolute(r.cwd) && !r.cwd.includes('\0')
    && (r.envSource === undefined || typeof r.envSource === 'string' && r.envSource.length <= 128)
    && ['verbs', 'starter', 'full'].includes(String(r.surface)) && ['env', 'flag', 'config', 'default'].includes(String(r.surfaceSource))
    && ['full', 'read-only'].includes(String(r.access)) && typeof r.sourceGuard === 'boolean'
    && (r.invalidSurfaceEnv === undefined || typeof r.invalidSurfaceEnv === 'string' && r.invalidSurfaceEnv.length <= 128);
}

export async function runLocalOwner(engine: BrainEngine): Promise<void> {
  const paths = localOwnerPaths();
  if (!paths || engine.kind !== 'pglite') throw new Error('Local MCP owner requires a persistent PGLite brain');
  await prepareOwnerDirectory(paths.directory);
  const sockets = new Set<Socket>();
  const writableSources = new Map<Socket, string>();
  const rememberCallable = (source: string) => () => [...writableSources.values()].includes(source);
  let stopping = false;
  let lastClient = Date.now();
  let secret = '';
  const bindings = new Map<string, Promise<ResolveIpcBinding>>();
  const sweeps: Array<{ cancel(): void }> = [];
  const bindSource = (source: string) => {
    if (!isValidSourceId(source)) return Promise.resolve();
    let binding = bindings.get(source);
    if (!binding) {
      binding = bindResolveIpcForServe(engine, source, undefined, { sourceKeyedPglite: true, rememberCallable: rememberCallable(source) });
      bindings.set(source, binding);
      const sweep = armStartupSweep(engine, { sourceId: source });
      if (sweep) sweeps.push(sweep);
    }
    return binding;
  };
  const server = createServer(socket => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); writableSources.delete(socket); lastClient = Date.now(); });
    socket.setTimeout(5000, () => socket.destroy());
    let data = '';
    const challenge = randomBytes(32).toString('hex');
    let nonce: string | undefined;
    const accept = async (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > 8192) { socket.destroy(); return; }
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      socket.pause(); socket.off('data', accept);
      try {
        const envelope = JSON.parse(data.slice(0, newline));
        if (nonce === undefined) {
          if (typeof envelope.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.nonce) || data.length !== newline + 1) { socket.destroy(); return; }
          nonce = envelope.nonce; data = '';
          socket.write(JSON.stringify({ challenge, proof: ownerProof(secret, 'server', challenge, `${nonce}:${paths.identity}`) }) + '\n');
          socket.on('data', accept); socket.resume(); return;
        }
        const hello: unknown = envelope.session;
        const expected = ownerProof(secret, 'client', challenge, `${nonce}:${JSON.stringify(hello)}`);
        if (envelope.protocol !== 1 || envelope.identity !== paths.identity || envelope.challenge !== challenge
          || typeof envelope.proof !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.proof)
          || !timingSafeEqual(Buffer.from(envelope.proof), Buffer.from(expected)) || !authorized(hello)) { socket.destroy(); return; }
        if (data.length !== newline + 1) { socket.destroy(); return; }
        socket.setTimeout(0);
        const transport = new StdioServerTransport(socket, socket);
        const session = await startMcpServer(engine, { ...hello, session: { transport, cwd: hello.cwd, envSource: hello.envSource } });
        socket.once('close', () => { session?.close().catch(() => {}); });
        if (socket.destroyed) { await session?.close(); return; }
        const scope = await resolveMcpStdioSourceScope(engine, hello.cwd, hello);
        if (hello.access === 'full' && !socket.destroyed) writableSources.set(socket, scope.sourceId);
        await bindSource(scope.sourceId);
        socket.write(JSON.stringify({ ok: true, proof: ownerProof(secret, 'server', challenge, `ready:${nonce}:${paths.identity}`) }) + '\n'); socket.resume();
      } catch { socket.end('{"ok":false}\n'); }
    };
    socket.on('data', accept);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local MCP owner listener failed');
  const config = loadConfig();
  const persistence = await createPersistenceIpcProvider(engine, residentPersistenceConfig(config) ?? { engine: engine.kind });
  const ipc = await bindResolveIpcForServe(engine, 'default', persistence, { sourceKeyedPglite: true, rememberCallable: rememberCallable('default') });
  bindings.set('default', Promise.resolve(ipc));
  const sweep = armStartupSweep(engine, { sourceId: 'default' });
  if (sweep) sweeps.push(sweep);
  gcSessionContextState(engine).catch(() => {});
  startOnboardingRefresher(engine, { idle: () => stdioRpcsInFlightCount() === 0 }).catch(() => {});
  // Publish discovery only after the default IPC and persistence bindings are ready.
  const record = writeOwnerRecord(paths.record, { protocol: 1, pid: process.pid, port: address.port, identity: paths.identity });
  secret = record.secret;
  // Keep the owner across chat disconnects, but do not install a permanent OS service.
  const idleMs = Math.max(1000, Number(process.env.GBRAIN_LOCAL_OWNER_IDLE_MS) || 30_000);
  await new Promise<void>(resolve => {
    const stop = () => {
      if (stopping) return;
      stopping = true; clearInterval(timer);
      for (const sweep of sweeps) sweep.cancel();
      for (const binding of bindings.values()) binding.then(b => b.close()).catch(() => {});
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    };
    const timer = setInterval(() => {
      if (!sockets.size && stdioRpcsInFlightCount() === 0 && Date.now() - lastClient >= idleMs) stop();
    }, 500);
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
  try { if (readOwnerRecord(paths.record)?.pid === process.pid) unlinkSync(paths.record); } catch { /* already removed */ }
  await (await import('../core/serve-sync-runner.ts')).shutdownDelegatedSync();
  await (await import('../core/context/checkpoint-harvest.ts')).shutdownCheckpointHarvest();
  await engine.disconnect();
}
