#!/usr/bin/env bun
/**
 * Bench: what a served Rust brain (protocol v3 over loopback TLS, src/core/rust-engine/served/) adds to a call, against
 * the same call on the plain Rust engine (multi-user mode off) and on the embedded engine that owns the served brain
 * (multi-user mode on). One process hosts all three: a plain RustEngine on its own temp brain, opened with
 * GBRAIN_RUST_MULTIUSER unset; a multi-user RustEngine that owns a second temp brain, with an owner token and a TLS
 * listener on 127.0.0.1 (a throwaway self-signed certificate); and a third RustEngine that is a served client of it.
 * Each sample runs the three in a rotating order so a drifting machine hits them alike. Losses are reported at p50 and
 * p99: the mode's (multi-user embedded minus plain), the wire's (served minus multi-user embedded) and the total
 * (served minus plain).
 *
 * Every write sends a body the brain it lands on does not hold yet: the multi-user embedded arm and the served arm share
 * one brain, so each arm's body names the arm, and a check refuses any write whose page equals the last one written to
 * that slug of that brain (an unchanged-body write costs less, and would hide the write's real cost).
 *   --only <text>   run only the shapes whose name contains <text> (for example --only putPage)
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
const only = flag('only');

const addonPath = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${detectAddonTarget() ?? 'unsupported'}.node`);
if (!existsSync(addonPath)) {
  console.error(`The Rust addon ${addonPath} does not exist; run bun run rust:build or set GBRAIN_TEST_RUST_ENGINE_ADDON.`);
  process.exit(2);
}

// The owner's election reads this before it opens (the operator-env preload drops GBRAIN_ switches, so set it here).
// The plain engine opens with it unset (openPlain), and the store keeps the mode it resolved at open.
process.env.GBRAIN_RUST_MULTIUSER = '1';

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
const round = (n: number): number => Math.round(n * 1000) / 1000;

type Arm = 'plain' | 'embedded' | 'served';
interface Shape { name: string; run: (engine: RustEngine, i: number, arm: Arm) => Promise<unknown>; samples?: number }

const smallPage = (i: number | string) => ({ type: 'note', title: `Bench ${i}`, compiled_truth: `Bench page ${i}. ${'The quick brown fox. '.repeat(20)}`, frontmatter: { n: i } });

/** The last page each slug of each brain got: the plain arm has its own brain, the other two share one. */
const lastWritten = new Map<string, string>();
/** Writes `page` to `slug` through `engine`, after checking the brain does not hold that very page already. */
function freshPut(engine: RustEngine, arm: Arm, slug: string, page: object): Promise<unknown> {
  const key = `${arm === 'plain' ? 'plain' : 'multiuser'}:${slug}`;
  const body = JSON.stringify(page);
  if (lastWritten.get(key) === body) throw new Error(`bench: the ${arm} arm would rewrite ${slug} with the page it already holds`);
  lastWritten.set(key, body);
  return engine.putPage(slug, page as never);
}
const LARGE_BODY = Array.from({ length: 256 * 1024 / 64 }, (_, i) => `line ${String(i).padStart(6, '0')} ${'x'.repeat(48)}\n`).join('');

const shapes: Shape[] = [
  { name: 'getPage (small read)', run: e => e.getPage('bench/seed-0') },
  { name: 'putPage (write)', run: (e, i, arm) => freshPut(e, arm, `bench/write-${i % 64}`, smallPage(`${arm}-${i}`)) },
  { name: 'listPages limit 50', run: e => e.listPages({ limit: 50 } as never) },
  { name: 'putPage ~256 KiB body', run: (e, i, arm) => freshPut(e, arm, 'bench/large', { type: 'note', title: 'Large', compiled_truth: `${arm} ${i}\n${LARGE_BODY}`, frontmatter: { n: `${arm}-${i}` } }) },
];

/** Opens a RustEngine on `dir` with multi-user mode off: the switch is unset for the open only. */
async function openPlain(addon: Awaited<ReturnType<typeof loadRustAddon>>, dir: string): Promise<RustEngine> {
  const engine = openRustEngine({ addon, databasePath: dir });
  delete process.env.GBRAIN_RUST_MULTIUSER;
  try { await engine.connect({ engine: 'pglite', database_path: dir } as never); } finally { process.env.GBRAIN_RUST_MULTIUSER = '1'; }
  if (engine.multiuser) throw new Error('the plain engine opened in multi-user mode');
  return engine;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-served-'));
  const plainDir = mkdtempSync(join(tmpdir(), 'gbrain-bench-plain-'));
  let plain: RustEngine | undefined;
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
    plain = await openPlain(addon, plainDir);
    owner = openRustEngine({ addon, databasePath: dir });
    await owner.connect({ engine: 'pglite', database_path: dir } as never);
    if (!owner.multiuser) throw new Error('the owner did not open in multi-user mode');
    const server = owner.ownerServer();
    if (!server?.attachServed) throw new Error('the Rust owner did not start with protocol v3 (is GBRAIN_RUST_MULTIUSER on?)');
    const { token } = await mintOwnerServerToken(owner as unknown as BrainEngine, 'bench-served');
    listener = await listenServed(server, { host: '127.0.0.1', port: 0, tls });
    client = openRustEngine({ addon, databasePath: dir, served: { url: `gbrain+tls://localhost:${listener.port}`, token, ca: tls.cert } });
    await client.connect({ engine: 'rust', database_path: dir } as never);

    // Seed pages through the owner: enough for listPages to return a full 50, and one to read.
    for (let i = 0; i < 120; i++) { await owner.putPage(`bench/seed-${i}`, smallPage(i) as never); await plain.putPage(`bench/seed-${i}`, smallPage(i) as never); }
    const arms: Array<[Arm, RustEngine]> = [['plain', plain], ['embedded', owner], ['served', client]];

    const results: Array<Record<string, unknown>> = [];
    for (const shape of shapes.filter(s => !only || s.name.includes(only))) {
      const n = shape.samples ?? samples;
      // Warm both paths (connection, caches, JIT) before measuring.
      for (let i = 0; i < 20; i++) for (const [arm, engine] of arms) await shape.run(engine, -1 - i, arm);
      const times: Record<Arm, number[]> = { plain: [], embedded: [], served: [] };
      for (let i = 0; i < n; i++) {
        // Rotate which arm goes first, so none always follows another's cache state.
        for (let k = 0; k < arms.length; k++) {
          const [arm, engine] = arms[(i + k) % arms.length]!;
          const t0 = performance.now();
          await shape.run(engine, i, arm);
          times[arm].push(performance.now() - t0);
        }
      }
      for (const arm of Object.keys(times) as Arm[]) times[arm].sort((a, b) => a - b);
      const at = (arm: Arm, p: number) => pct(times[arm], p);
      const row: Record<string, unknown> = { shape: shape.name, samples: n };
      for (const [p, key] of [[0.5, 'p50'], [0.95, 'p95'], [0.99, 'p99']] as const) {
        for (const arm of Object.keys(times) as Arm[]) row[`${arm}_${key}_ms`] = round(at(arm, p));
        row[`mode_loss_${key}_ms`] = round(at('embedded', p) - at('plain', p));
        row[`wire_loss_${key}_ms`] = round(at('served', p) - at('embedded', p));
        row[`total_loss_${key}_ms`] = round(at('served', p) - at('plain', p));
      }
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
      `Plain Rust (mode off), multi-user embedded and served Rust brain, ${samples} samples per shape (rotating order), loopback TLS.`,
      `Machine: ${machine.cpu_model} x${machine.cpu_count}, ${machine.os}, Bun ${machine.bun}.`,
      '',
      '| Shape | Plain p50 / p99 | Multi-user embedded p50 / p99 | Served p50 / p99 | Mode loss p50 / p99 | Wire loss p50 / p99 | Total loss p50 / p99 |',
      '|---|---:|---:|---:|---:|---:|---:|',
      ...results.map(r => `| ${r.shape} | ${r.plain_p50_ms} / ${r.plain_p99_ms} ms | ${r.embedded_p50_ms} / ${r.embedded_p99_ms} ms | ${r.served_p50_ms} / ${r.served_p99_ms} ms | ${r.mode_loss_p50_ms} / ${r.mode_loss_p99_ms} ms | ${r.wire_loss_p50_ms} / ${r.wire_loss_p99_ms} ms | ${r.total_loss_p50_ms} / ${r.total_loss_p99_ms} ms |`),
      '',
      `JSON: ${outPath}`,
    ];
    console.log(lines.join('\n'));
  } finally {
    try { await client?.disconnect(); } catch { /* closing anyway */ }
    try { await listener?.close(); } catch { /* closing anyway */ }
    try { await owner?.disconnect(); } catch { /* closing anyway */ }
    try { await plain?.disconnect(); } catch { /* closing anyway */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
    rmSync(`${plainDir}.gbrain-owner.lock`, { force: true });
    rmSync(`${dir}.gbrain-owner.lock`, { force: true }); // the owner lock the engine keeps beside the brain folder
    rmSync(tlsDir, { recursive: true, force: true });
  }
}

// process.exit skips a pending finally block, so the exit code is decided after main (and its cleanup) returns.
let code = 0;
try { await main(); } catch (error) { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); code = 1; }
process.exit(code);
