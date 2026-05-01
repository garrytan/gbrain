import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We mock process.exit before importing shutdown so signal handlers don't
// terminate the test runner. The handlers fire synchronously but call
// engine.disconnect() in a microtask — we flush with a tick before asserting.
let exitCalls: number[] = [];
const realExit = process.exit;

beforeEach(() => {
  exitCalls = [];
  // @ts-expect-error — overriding process.exit signature for the duration of the test
  process.exit = (code?: number) => { exitCalls.push(code ?? 0); };
});

afterEach(() => {
  process.exit = realExit;
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGHUP');
  // stdin 'end' listeners are leaked across tests; that's tolerable in a test
  // process where stdin is a pipe and never EOFs in practice.
});

const tick = () => new Promise(r => setTimeout(r, 10));

describe('installShutdownHandlers', () => {
  test('SIGTERM triggers engine.disconnect()', async () => {
    const { installShutdownHandlers, _resetForTesting } = await freshImport();
    _resetForTesting();
    let disconnects = 0;
    installShutdownHandlers(makeEngine(() => { disconnects++; }));

    process.emit('SIGTERM');
    await tick();

    expect(disconnects).toBe(1);
    expect(exitCalls).toEqual([0]);
  });

  test('SIGINT exits with code 130', async () => {
    const { installShutdownHandlers, _resetForTesting } = await freshImport();
    _resetForTesting();
    installShutdownHandlers(makeEngine(() => {}));
    process.emit('SIGINT');
    await tick();
    expect(exitCalls).toEqual([130]);
  });

  test('SIGHUP exits with code 129', async () => {
    const { installShutdownHandlers, _resetForTesting } = await freshImport();
    _resetForTesting();
    installShutdownHandlers(makeEngine(() => {}));
    process.emit('SIGHUP');
    await tick();
    expect(exitCalls).toEqual([129]);
  });

  test('disconnect is called only once even with multiple signals', async () => {
    const { installShutdownHandlers, _resetForTesting } = await freshImport();
    _resetForTesting();
    let disconnects = 0;
    installShutdownHandlers(makeEngine(() => { disconnects++; }));

    process.emit('SIGTERM');
    process.emit('SIGTERM');
    process.emit('SIGINT');
    await tick();

    expect(disconnects).toBe(1);
  });

  test('installShutdownHandlers is idempotent', async () => {
    const { installShutdownHandlers, _resetForTesting } = await freshImport();
    _resetForTesting();
    let disconnectsA = 0;
    let disconnectsB = 0;
    installShutdownHandlers(makeEngine(() => { disconnectsA++; }));
    // Second call with a different engine should be a no-op — we must not
    // accidentally swap the live engine reference and disconnect a stale one.
    installShutdownHandlers(makeEngine(() => { disconnectsB++; }));

    process.emit('SIGTERM');
    await tick();

    expect(disconnectsA).toBe(1);
    expect(disconnectsB).toBe(0);
  });

  test('disconnect failure does not block process.exit', async () => {
    const { installShutdownHandlers, _resetForTesting } = await freshImport();
    _resetForTesting();
    installShutdownHandlers(makeEngine(() => {
      throw new Error('simulated disconnect failure');
    }));

    process.emit('SIGTERM');
    await tick();

    expect(exitCalls).toEqual([0]);
  });
});

// PGLite end-to-end: connect, install handlers, fire SIGTERM, then verify the
// brain re-opens cleanly. This is the regression test for the WAL corruption
// incident — guards the behavior the shutdown handlers exist to provide.
describe('PGLite WAL safety after SIGTERM', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-shutdown-pglite-'));
  });
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test('SIGTERM during connected PGLite session leaves brain re-openable', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { installShutdownHandlers, _resetForTesting } = await freshImport();
    _resetForTesting();

    const dataDir = join(dir, 'brain.pglite');
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dataDir });
    await engine.initSchema();
    await engine.putPage('shutdown-test', {
      type: 'concept',
      title: 'Shutdown test',
      compiled_truth: 'ensure WAL flushes on signal',
      timeline: '',
      frontmatter: {},
    });

    installShutdownHandlers(engine);

    process.emit('SIGTERM');
    await tick();
    await tick();

    // Re-open with a fresh engine — must succeed, page must be present.
    const engine2 = new PGLiteEngine();
    await engine2.connect({ engine: 'pglite', database_path: dataDir });
    const page = await engine2.getPage('shutdown-test');
    await engine2.disconnect();

    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('flushes on signal');
  }, 30_000);
});

// ---- helpers ----

interface DisconnectableEngine {
  disconnect(): Promise<void>;
}

function makeEngine(onDisconnect: () => void): DisconnectableEngine {
  return {
    disconnect: async () => { onDisconnect(); },
  };
}

// Bun caches modules. Each test gets a fresh shutdown.ts via cache-busting
// query string so the `installed` and `shuttingDown` module-level flags reset.
async function freshImport(): Promise<typeof import('../src/core/shutdown.ts')> {
  const url = new URL('../src/core/shutdown.ts?t=' + Date.now() + Math.random(), import.meta.url);
  return await import(url.href);
}
