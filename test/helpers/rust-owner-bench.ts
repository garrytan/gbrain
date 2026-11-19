/**
 * Many processes on one Rust brain (docs/designs/RUST_ENGINE.md, "PR sequence" step 18). This process opens the brain
 * and owns it; `clients` child processes (rust-owner-child.ts `mixed`) connect as clients of that owner and, once all
 * of them are ready, each runs `ops` operations at the same time, alternating putPage and getPage through the owner
 * socket. Used by test/rust-owner-clients.test.ts and scripts/bench-rust-owner.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngine } from '../../src/core/rust-engine.ts';

const CHILD = join(import.meta.dir, 'rust-owner-child.ts');

export interface OwnerBenchResult {
  clients: number;
  ops: number;
  roles: string[];
  ownerRole: string | null;
  errors: string[];
  wallMs: number;
  opsPerSecond: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  pagesWritten: number;
  pagesFound: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function startClient(addonPath: string, db: string, worker: number, ops: number) {
  const child: ChildProcess = spawn(process.execPath, [CHILD, 'mixed', db, String(worker), String(ops)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GBRAIN_RUST_ENGINE_ADDON: addonPath },
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  let onReady!: (line: Record<string, unknown>) => void;
  let onDone!: (line: Record<string, unknown>) => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => { onReady = resolve; fail = reject; });
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    onDone = resolve;
    const earlier = fail;
    fail = error => { earlier(error); reject(error); };
  });
  done.catch(() => undefined);
  let buf = '';
  child.stdout!.on('data', chunk => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop()!;
    for (const part of parts) {
      const line = JSON.parse(part) as Record<string, unknown>;
      if (line.fatal !== undefined) fail(new Error(`client ${worker} failed: ${part}`));
      else if (line.ready) onReady(line);
      else if (line.done) onDone(line);
    }
  });
  child.on('close', code => fail(new Error(`client ${worker} exited ${code}: ${stderr}`)));
  return { child, ready, done };
}

export async function runOwnerBench(opts: { addonPath: string; db: string; clients: number; ops: number }): Promise<OwnerBenchResult> {
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: opts.addonPath } });
  const owner: RustEngine = openRustEngine({ addon, databasePath: opts.db });
  await owner.connect({ engine: 'pglite', database_path: opts.db } as never);
  const children = Array.from({ length: opts.clients }, (_, worker) => startClient(opts.addonPath, opts.db, worker, opts.ops));
  try {
    const ready = await Promise.all(children.map(c => c.ready));
    const started = performance.now();
    for (const c of children) c.child.stdin!.write('go\n');
    const done = await Promise.all(children.map(c => c.done));
    const wallMs = performance.now() - started;
    const latencies = done.flatMap(line => line.latencies as number[]).sort((a, b) => a - b);
    const errors = done.flatMap(line => line.errors as string[]);
    const writesPerClient = Math.ceil(opts.ops / 2);
    let pagesFound = 0;
    for (let worker = 0; worker < opts.clients; worker++) {
      for (let n = 0; n < writesPerClient; n++) if (await owner.getPage(`mix/w${worker}-${n}`)) pagesFound++;
    }
    return {
      clients: opts.clients, ops: opts.ops,
      roles: ready.map(line => String(line.role)), ownerRole: owner.ownerRole,
      errors, wallMs: Math.round(wallMs),
      opsPerSecond: Math.round(latencies.length / (wallMs / 1000)),
      p50Ms: Number(percentile(latencies, 50).toFixed(2)),
      p99Ms: Number(percentile(latencies, 99).toFixed(2)),
      maxMs: Number((latencies.at(-1) ?? 0).toFixed(2)),
      pagesWritten: writesPerClient * opts.clients, pagesFound,
    };
  } finally {
    for (const c of children) c.child.kill('SIGKILL');
    await owner.disconnect();
  }
}
