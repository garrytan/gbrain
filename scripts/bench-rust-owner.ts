#!/usr/bin/env bun
/**
 * Bench: many processes on one Rust brain through the owner socket (docs/designs/RUST_ENGINE.md, "PR sequence"
 * step 18). This process owns a fresh brain; each client process alternates putPage and getPage. Prints one JSON line
 * with the throughput, p50/p99/max latency, and every error code a client saw (busy errors must be zero).
 *
 *   GBRAIN_RUST_ENGINE_ADDON=rust/target/addon/gbrain_engine.<target>.node \
 *     bun scripts/bench-rust-owner.ts [--clients 16] [--ops 1000]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnerBench } from '../test/helpers/rust-owner-bench.ts';

function flag(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const addonPath = process.env.GBRAIN_RUST_ENGINE_ADDON;
if (!addonPath) {
  console.error('Set GBRAIN_RUST_ENGINE_ADDON to the built addon (bun run rust:build).');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-rust-owner-'));
// process.exit skips a pending finally block, so the exit code is decided inside and the exit comes after the folder
// is removed (test/bench-rust-owner-cleanup.test.ts).
let code = 1;
try {
  const result = await runOwnerBench({ addonPath, db: join(dir, 'brain'), clients: flag('clients', 16), ops: flag('ops', 1000) });
  console.log(JSON.stringify({ ...result, roles: undefined, errorCount: result.errors.length, errors: [...new Set(result.errors)] }));
  code = result.errors.length || result.pagesFound !== result.pagesWritten ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
