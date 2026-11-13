/** Real resident for private-HTTP lifecycle tests; all state belongs to a synthetic test home. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { runServeHttp } from '../../src/commands/serve-http.ts';
import { installSignalHandlers, _registeredCleanupCountForTests } from '../../src/core/process-cleanup.ts';
import { resolveSocketPathForConfig } from '../../src/core/context/resolve-ipc.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

const home = process.env.GBRAIN_HOME!;
const socketPath = process.env.GBRAIN_HTTP_UNIX_SOCKET!;
const databasePath = path.join(home, 'brain');
const config = { engine: 'pglite' as const, database_path: databasePath };
fs.mkdirSync(path.join(home, '.gbrain'), { recursive: true });
fs.writeFileSync(path.join(home, '.gbrain', 'config.json'), JSON.stringify(config));
configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
installSignalHandlers({ keepServingOnLogEpipe: true });
const engine = new PGLiteEngine();
await engine.connect(config);
await engine.initSchema();
const baseline = _registeredCleanupCountForTests();
const ipcPath = resolveSocketPathForConfig(config);
const disconnect = engine.disconnect.bind(engine);
engine.disconnect = async () => {
  const socketExistedAtDisconnect = fs.existsSync(socketPath);
  await disconnect();
  fs.writeFileSync(path.join(home, 'disconnected.json'), JSON.stringify({ socketExistedAtDisconnect }));
};
const close = http.Server.prototype.close;
if (process.env.GBRAIN_TEST_PRIVATE_CLOSE_FAULT === 'callback-error') {
  // Inject only the completion fault at the public HTTP boundary; the real native listener is still closed.
  http.Server.prototype.close = function(callback) {
    const privateListener = this.address() === socketPath;
    return close.call(this, error => callback?.(error ?? (privateListener ? new Error('synthetic-private-close-error') : undefined)));
  };
}
// Readiness is the production lifecycle's SIGINT subscription, after its IPC and engine cleanup registration.
const ready = setInterval(() => {
  if (process.listenerCount('SIGINT') === 0) return;
  fs.writeFileSync(path.join(home, 'ready.json'), JSON.stringify({ ipcPath, baseline }));
  clearInterval(ready);
}, 25);
let exitCode = 0;
try {
  await runServeHttp(engine, {
    port: Number(process.env.GBRAIN_TEST_HTTP_PORT), tokenTtl: 3600,
    publicUrl: `http://127.0.0.1:${process.env.GBRAIN_TEST_HTTP_PORT}`,
    bind: '127.0.0.1', enableDcr: false,
  });
  fs.writeFileSync(path.join(home, 'stopped.json'), JSON.stringify({
    baseline, remaining: _registeredCleanupCountForTests(),
    socketExists: fs.existsSync(socketPath), ipcExists: ipcPath ? fs.existsSync(ipcPath) : false,
  }));
} catch (error) {
  exitCode = 1;
  const failure = error as Error & { code?: string };
  fs.writeFileSync(path.join(home, 'failed.json'), JSON.stringify({
    code: failure.code, message: failure.message,
    baseline, remaining: _registeredCleanupCountForTests(), socketExists: fs.existsSync(socketPath),
  }));
} finally {
  clearInterval(ready);
  http.Server.prototype.close = close;
  await engine.disconnect();
}
process.exit(exitCode);
