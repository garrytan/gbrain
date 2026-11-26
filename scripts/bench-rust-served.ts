#!/usr/bin/env bun
/**
 * Bench: what a served Rust brain (protocol v3 over loopback TLS, src/core/rust-engine/served/) adds to a call, against
 * the same call on the embedded engine that owns the brain. One process hosts both: an embedded RustEngine on a temp
 * brain, an owner token, a TLS listener on 127.0.0.1 with a throwaway self-signed certificate, and a second RustEngine
 * that is a served client of it. Each sample alternates embedded and served so a drifting machine hits both alike.
 *
 *   bun scripts/bench-rust-served.ts [--samples 1000] [--out /var/tmp/l3/bench-served.json]
 *
 * Needs the Rust addon (`bun run rust:build` writes rust/target/addon/gbrain_engine.<target>.node, or set
 * GBRAIN_TEST_RUST_ENGINE_ADDON). Shapes: getPage (small read), putPage (write), listPages limit 50, and a putPage
 * with a ~256 KiB body. Loopback has no real network latency, so the added time is the protocol's own cost (framing,
 * TLS, the request id and position bookkeeping, the owner's dispatcher), a floor for a remote client.
 * Prints a markdown table and writes the same numbers as JSON.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { mintOwnerServerToken } from '../src/core/rust-engine/served/owner-token.ts';

const MAX_SAMPLES = 2000;

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const samples = Math.min(MAX_SAMPLES, Math.max(10, Math.trunc(Number(flag('samples') ?? 1000))));
if (!Number.isFinite(samples)) { console.error('--samples must be a number'); process.exit(2); }
const outPath = flag('out') ?? '/var/tmp/l3/bench-served.json';

const addonPath = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${detectAddonTarget() ?? 'unsupported'}.node`);
if (!existsSync(addonPath)) {
  console.error(`The Rust addon ${addonPath} does not exist; run bun run rust:build or set GBRAIN_TEST_RUST_ENGINE_ADDON.`);
  process.exit(2);
}

// The owner's election reads this before it opens (the operator-env preload drops GBRAIN_ switches, so set it here).
process.env.GBRAIN_RUST_MULTIUSER = '1';

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
const round = (n: number): number => Math.round(n * 1000) / 1000;

interface Shape { name: string; run: (engine: RustEngine, i: number) => Promise<unknown>; samples?: number }

const smallPage = (i: number) => ({ type: 'note', title: `Bench ${i}`, compiled_truth: `Bench page ${i}. ${'The quick brown fox. '.repeat(20)}`, frontmatter: { n: i } });
const LARGE_BODY = Array.from({ length: 256 * 1024 / 64 }, (_, i) => `line ${String(i).padStart(6, '0')} ${'x'.repeat(48)}\n`).join('');

const shapes: Shape[] = [
  { name: 'getPage (small read)', run: e => e.getPage('bench/seed-0') },
  { name: 'putPage (write)', run: (e, i) => e.putPage(`bench/write-${i % 64}`, smallPage(i) as never) },
  { name: 'listPages limit 50', run: e => e.listPages({ limit: 50 } as never) },
  { name: 'putPage ~256 KiB body', run: (e, i) => e.putPage('bench/large', { type: 'note', title: 'Large', compiled_truth: LARGE_BODY, frontmatter: { n: i } } as never) },
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-served-'));
  const tlsDir = mkdtempSync(join(tmpdir(), 'gbrain-bench-served-tls-'));
  let owner: RustEngine | undefined;
  let client: RustEngine | undefined;
  let listener: ServedListener | undefined;
  try {
    const cert = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem')], { stderr: 'pipe' });
    if (cert.exitCode !== 0) throw new Error(`openssl could not make the bench certificate: ${cert.stderr.toString()}`);
    const tls = { cert: readFileSync(join(tlsDir, 'cert.pem')), key: readFileSync(join(tlsDir, 'key.pem')) };

    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });
    owner = openRustEngine({ addon, databasePath: dir });
    await owner.connect({ engine: 'pglite', database_path: dir } as never);
    const server = owner.ownerServer();
    if (!server?.attachServed) throw new Error('the Rust owner did not start with protocol v3 (is GBRAIN_RUST_MULTIUSER on?)');
    const { token } = await mintOwnerServerToken(owner as unknown as BrainEngine, 'bench-served');
    listener = await listenServed(server, { host: '127.0.0.1', port: 0, tls });
    client = openRustEngine({ addon, databasePath: dir, served: { url: `gbrain+tls://localhost:${listener.port}`, token, ca: tls.cert } });
    await client.connect({ engine: 'rust', database_path: dir } as never);

    // Seed pages through the owner: enough for listPages to return a full 50, and one to read.
    for (let i = 0; i < 120; i++) await owner.putPage(`bench/seed-${i}`, smallPage(i) as never);

    const results: Array<Record<string, unknown>> = [];
    for (const shape of shapes) {
      const n = shape.samples ?? samples;
      // Warm both paths (connection, caches, JIT) before measuring.
      for (let i = 0; i < 20; i++) { await shape.run(owner, i); await shape.run(client, i); }
      const embedded: number[] = []; const served: number[] = [];
      for (let i = 0; i < n; i++) {
        // Alternate which side goes first, so neither always follows the other's cache state.
        const order = i % 2 === 0 ? [owner, client] : [client, owner];
        for (const engine of order) {
          const t0 = performance.now();
          await shape.run(engine, i);
          (engine === owner ? embedded : served).push(performance.now() - t0);
        }
      }
      embedded.sort((a, b) => a - b); served.sort((a, b) => a - b);
      const row = {
        shape: shape.name, samples: n,
        embedded_p50_ms: round(pct(embedded, 0.5)), embedded_p95_ms: round(pct(embedded, 0.95)),
        served_p50_ms: round(pct(served, 0.5)), served_p95_ms: round(pct(served, 0.95)),
        added_p50_ms: round(pct(served, 0.5) - pct(embedded, 0.5)), added_p95_ms: round(pct(served, 0.95) - pct(embedded, 0.95)),
      };
      results.push(row);
    }

    const machine = {
      os: `${process.platform} ${process.arch}`, node_platform: process.platform, cpu_model: cpus()[0]?.model ?? 'unknown', cpu_count: cpus().length,
      bun: Bun.version, transport: 'gbrain+tls://localhost (loopback, TLS 1.2+)',
    };
    const out = { generated_at: new Date().toISOString(), samples, machine, results };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

    const lines = [
      `Served vs embedded Rust brain, ${samples} samples per shape (interleaved), loopback TLS.`,
      `Machine: ${machine.cpu_model} x${machine.cpu_count}, ${machine.os}, Bun ${machine.bun}.`,
      '',
      '| Shape | Embedded p50 | Embedded p95 | Served p50 | Served p95 | Added p50 | Added p95 |',
      '|---|---:|---:|---:|---:|---:|---:|',
      ...results.map(r => `| ${r.shape} | ${r.embedded_p50_ms} ms | ${r.embedded_p95_ms} ms | ${r.served_p50_ms} ms | ${r.served_p95_ms} ms | ${r.added_p50_ms} ms | ${r.added_p95_ms} ms |`),
      '',
      `JSON: ${outPath}`,
    ];
    console.log(lines.join('\n'));
  } finally {
    try { await client?.disconnect(); } catch { /* closing anyway */ }
    try { await listener?.close(); } catch { /* closing anyway */ }
    try { await owner?.disconnect(); } catch { /* closing anyway */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.gbrain-owner.lock`, { force: true }); // the owner lock the engine keeps beside the brain folder
    rmSync(tlsDir, { recursive: true, force: true });
  }
}

// process.exit skips a pending finally block, so the exit code is decided after main (and its cleanup) returns.
let code = 0;
try { await main(); } catch (error) { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); code = 1; }
process.exit(code);
