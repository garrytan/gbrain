/**
 * #4679 — the serve idle maintenance sweep must target the SAME source the
 * stdio dispatch and the startup sweep resolve (GBRAIN_SOURCE > .gbrain-source
 * dotfile > local_path > sources.default > …), not `GBRAIN_SOURCE || 'default'`.
 *
 * Pre-fix, a dotfile/local_path-scoped stdio serve wrote MCP pages into that
 * source with auto_links {skipped:'remote'} while every idle sweep reconciled
 * links against 'default' — in-session writes got zero edges until a restart.
 *
 * Serial: top-level mock.module (captures runMaintenanceSweep's opts without
 * running the real sweep, and records which resident tickers a serve starts)
 * + process.chdir (serve.ts resolves from process.cwd()).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import * as realSweep from '../src/core/sweep.ts';
import * as realDrain from '../src/core/facts/drain-scheduler.ts';
import * as realMovement from '../src/core/persistence/sync-movement.ts';
import * as realHeadWatcher from '../src/core/serve-head-watcher.ts';
import { withEnv } from './helpers/with-env.ts';

const sweepCalls: Array<{ sourceId?: string }> = [];
mock.module('../src/core/sweep.ts', () => ({
  ...realSweep,
  runMaintenanceSweep: async (_e: BrainEngine, opts: { sourceId?: string }) => {
    sweepCalls.push(opts);
    return {};
  },
}));

const tickerStarts: string[] = [];
mock.module('../src/core/facts/drain-scheduler.ts', () => ({
  ...realDrain,
  startFactsDrainScheduler: () => { tickerStarts.push('facts_drain'); return { stop: async () => {} }; },
}));
mock.module('../src/core/persistence/sync-movement.ts', () => ({
  ...realMovement,
  startMovementWatch: () => { tickerStarts.push('movement_watch'); return { stop: () => {} }; },
}));
mock.module('../src/core/serve-head-watcher.ts', () => ({
  ...realHeadWatcher,
  startServeHeadWatcher: () => { tickerStarts.push('head_watcher'); return { stop: async () => {} }; },
}));

// Imported AFTER the mock so serve.ts's lazy `import('../core/sweep.ts')`
// resolves to the capture above.
const { runServe } = await import('../src/commands/serve.ts');
type ServeOptions = import('../src/commands/serve.ts').ServeOptions;

// Same fake-engine shape as test/mcp-stdio-source-resolution.test.ts: answers
// the resolver's sources/config probes; nothing else on the engine is touched.
function makeEngine(registeredSources: string[]): BrainEngine {
  return {
    kind: 'pglite',
    disconnect: async () => {},
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const id = params?.[0];
        return (typeof id === 'string' && registeredSources.includes(id) ? [{ id } as T] : []);
      }
      if (sql.includes('SELECT id, local_path FROM sources')) return [];
      if (sql.includes('SELECT id, config, archived FROM sources')) {
        return registeredSources.map(id => ({ id, config: null, archived: false }) as T);
      }
      return [];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

const scratchDirs: string[] = [];
const originalCwd = process.cwd();
afterAll(() => {
  process.chdir(originalCwd);
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
}

describe('serve idle sweep source resolution (#4679)', () => {
  test('idle sweep resolves through the stdio source ladder (dotfile), not GBRAIN_SOURCE || default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-idle-sweep-'));
    scratchDirs.push(dir);
    const dotfile = join(dir, '.gbrain-source');
    writeFileSync(dotfile, 'wiki\n');
    chmodSync(dotfile, 0o600);

    const stdin = new EventEmitter();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const engine = makeEngine(['default', 'wiki']);
    const serveOpts: ServeOptions = {
      stdin: stdin as never,
      signals: new EventEmitter() as never,
      exit: () => {},
      log: () => {},
      startMcpServer: async () => {},
      getParentPid: () => 1, // parent watchdog skipped → the only interval is the idle sweep's
      probeWatchdog: () => true,
      setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return { unref() {} }; },
      clearInterval: () => {},
      mcpStdio: false,
      bootTimeoutMs: 0,
      sweepEnabled: true,
      factsDrain: false, // its own 10-minute timer is covered by test/facts-drain-scheduler.test.ts
    };

    process.chdir(dir);
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        await runServe(engine, [], serveOpts);
        expect(timers.length).toBe(1);
        timers[0].fn(); // tick 1 attaches the stdin activity listener
        timers[0].fn(); // tick 2: quiet window → sweep fires
        await waitFor(() => sweepCalls.length >= 1);
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(sweepCalls.length).toBe(1);
    expect(sweepCalls[0].sourceId).toBe('wiki');
  }, 20_000);

  test('#7599: a read-only serve on Postgres arms no idle sweep; read-write, or on PGLite, it does', async () => {
    const armed: string[] = [];
    for (const [kind, args] of [['postgres', ['--access', 'read-only']], ['postgres', ['--access=read-only']], ['postgres', []], ['pglite', ['--access', 'read-only']]] as const) {
      let timers = 0;
      await withEnv({ GBRAIN_SOURCE: undefined }, () => runServe({ ...makeEngine(['default']), kind } as BrainEngine, [...args], {
        stdin: new EventEmitter() as never, signals: new EventEmitter() as never, exit: () => {}, log: () => {}, startMcpServer: async () => {},
        getParentPid: () => 1, probeWatchdog: () => true, setInterval: () => { timers++; return { unref() {} }; }, clearInterval: () => {},
        mcpStdio: false, bootTimeoutMs: 0, sweepEnabled: true, factsDrain: false,
      }));
      armed.push(`${kind} ${args.join(' ') || 'read-write'}: ${timers}`);
    }
    expect(armed).toEqual(['postgres --access read-only: 0', 'postgres --access=read-only: 0', 'postgres read-write: 1', 'pglite --access read-only: 1']);
  }, 20_000);

  test('#7599: a read-only serve on Postgres starts no resident ticker (facts drain, movement watch, head watcher); read-write, or on PGLite, it does', async () => {
    const started: string[] = [];
    for (const [kind, args] of [['postgres', ['--access', 'read-only']], ['postgres', ['--access=read-only']], ['postgres', []], ['pglite', ['--access', 'read-only']]] as const) {
      tickerStarts.length = 0;
      await withEnv({ GBRAIN_SOURCE: undefined }, () => runServe({ ...makeEngine(['default']), kind } as BrainEngine, [...args], {
        stdin: new EventEmitter() as never, signals: new EventEmitter() as never, exit: () => {}, log: () => {}, startMcpServer: async () => {},
        getParentPid: () => 1, probeWatchdog: () => true, setInterval: () => ({ unref() {} }), clearInterval: () => {},
        mcpStdio: false, bootTimeoutMs: 0, sweepEnabled: false, factsDrain: {},
      }));
      started.push(`${kind} ${args.join(' ') || 'read-write'}: ${[...tickerStarts].sort().join(',') || 'none'}`);
    }
    // The facts drain is PGLite-only (a Postgres brain has a job worker), so a read-write Postgres serve starts the other two.
    expect(started).toEqual([
      'postgres --access read-only: none',
      'postgres --access=read-only: none',
      'postgres read-write: head_watcher,movement_watch',
      'pglite --access read-only: facts_drain,head_watcher,movement_watch',
    ]);
  }, 20_000);
});
