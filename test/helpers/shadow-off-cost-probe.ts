/**
 * Child process for test/shadow-off-cost.test.ts and test/e2e/shadow-off-cost.test.ts. Run as
 *   bun test/helpers/shadow-off-cost-probe.ts <factory|direct> <pglite|postgres>
 * with GBRAIN_HOME and (postgres) DATABASE_URL / (pglite) PROBE_DB_PATH set by the parent. It prints one JSON line.
 *
 *   factory  the engine createEngine() (src/core/engine-factory.ts) returns for the brain the env names
 *   direct   `new PGLiteEngine()` / `new PostgresEngine()`, connected the same way, with no factory
 *
 * Both arms run the same fixed writes. The SQL is captured BELOW the engine, at the driver:
 *   pglite    PGlite.prototype.execProtocolRaw, the one funnel every client message goes through (the engine's statement
 *             cache calls the protocol directly, so wrapping PGlite#query would miss almost everything)
 *   postgres  net.Socket.prototype.write, the bytes the `postgres` driver sends to the server
 * Each client message is decoded from the wire format: Parse and Query carry their SQL text, Bind carries its parameters.
 *
 * A Bun onLoad hook, installed before anything else is imported, lists every .ts file this process loads, so the parent
 * can see whether src/shadow/{attach,wrapper,follow,follower,invalidations}.ts were ever loaded. (Bun's require.cache
 * does not list statically imported modules, so it cannot answer that question.)
 */
import net from 'node:net';
import { types } from 'node:util';

const loaded: string[] = [];
Bun.plugin({
  name: 'shadow-off-cost-module-recorder',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      loaded.push(args.path);
      return { contents: await Bun.file(args.path).text(), loader: 'ts' };
    });
  },
});

const [arm, kind] = process.argv.slice(2) as ['factory' | 'direct', 'pglite' | 'postgres'];
if ((arm !== 'factory' && arm !== 'direct') || (kind !== 'pglite' && kind !== 'postgres')) throw new Error('usage: probe <factory|direct> <pglite|postgres>');

/** One client message per entry: its type letter and the printable part of its payload. */
type Wire = string;

function printable(buf: Uint8Array): string {
  let out = '';
  for (const byte of buf) out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : byte === 0 ? '|' : '.';
  return out;
}

/** Splits a buffer of client messages (type byte, int32 length, payload) into entries; a malformed tail is kept whole. */
function decode(bytes: Uint8Array, into: Wire[]): void {
  let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 5) { into.push(`?:${printable(bytes.subarray(at))}`); return; }
    const type = String.fromCharCode(bytes[at]!);
    const len = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getInt32(0);
    if (len < 4 || at + 1 + len > bytes.length) { into.push(`?:${printable(bytes.subarray(at))}`); return; }
    into.push(`${type}:${printable(bytes.subarray(at + 5, at + 1 + len))}`);
    at += 1 + len;
  }
}

const wire: Wire[] = [];
let recording = false;
function installRecorder(pglite: unknown): void {
  if (kind === 'pglite') {
    const proto = (pglite as { PGlite: { prototype: Record<string, unknown> } }).PGlite.prototype;
    const original = proto.execProtocolRaw as (this: unknown, message: Uint8Array, ...rest: unknown[]) => Promise<Uint8Array>;
    proto.execProtocolRaw = function (this: unknown, message: Uint8Array, ...rest: unknown[]) {
      if (recording) decode(message, wire);
      return original.call(this, message, ...rest);
    };
  } else {
    const proto = net.Socket.prototype as unknown as { write: (this: unknown, chunk: unknown, ...rest: unknown[]) => boolean };
    const original = proto.write;
    proto.write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      if (recording && chunk instanceof Uint8Array) decode(chunk, wire);
      return original.call(this, chunk, ...rest);
    };
  }
}

const pgliteModule = kind === 'pglite' ? await import('@electric-sql/pglite') : null;
installRecorder(pgliteModule);

const { createEngine } = await import('../../src/core/engine-factory.ts');
const dbPath = process.env.PROBE_DB_PATH;
const config = kind === 'pglite'
  ? { engine: 'pglite' as const, database_path: dbPath }
  : { engine: 'postgres' as const, database_url: process.env.DATABASE_URL };

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
const Direct = kind === 'pglite' ? PGLiteEngine : PostgresEngine;

const engine = arm === 'factory' ? await createEngine(config) : new Direct();
const isProxy = types.isProxy(engine);
await engine.connect(config);
await engine.initSchema();

// Taken right after the factory returns and the engine is open, before any write: what the factory pulled into the process.
const loadedAfterOpen = [...loaded];

// PGLite's checkpoint guard (src/core/pglite-engine/checkpoint-guard.ts) decides from Date.now() whether its last WAL probe is
// still fresh, so how many probe queries a batch sends depends on how fast the machine ran it. That is the primary's own
// timing, not shadow's. Freeze the clock for the batch, 10 s past the last probe (its reuse window is 50 ms), so the first
// write always probes and the rest always reuse it, in both arms.
const realNow = Date.now;
if (kind === 'pglite') { const frozen = realNow() + 10_000; Date.now = () => frozen; }
recording = true;
const page = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body` });
await engine.putPage('probe/one', page('One'));
await engine.putPage('probe/two', page('Two'));
await engine.addLink('probe/one', 'probe/two', 'one links to two', 'mentions');
await engine.transaction(async (tx) => {
  await tx.putPage('probe/three', page('Three'));
  await tx.addLink('probe/three', 'probe/one', 'three links to one', 'mentions');
});
await engine.deletePage('probe/two');
recording = false;
Date.now = realNow;

/**
 * The postgres driver names each prepared statement with a random prefix, and PGLite's statement cache numbers its
 * statements per process (gbrain_s1, gbrain_s2 ...) and closes a retired one at the next prepare. Rename every name a
 * Parse (P:) or a Close (C:S) carries to stmt#1, stmt#2 ... in order of first use, so two runs of the same writes compare
 * equal even when load changed which earlier statements the cache had retired. Longer names are replaced first, so
 * gbrain_s3 never rewrites part of gbrain_s34. Nothing else is rewritten.
 */
function canonicalStatementNames(entries: Wire[]): Wire[] {
  const names: string[] = [];
  for (const entry of entries) {
    const name = entry.startsWith('P:') ? entry.slice(2).split('|')[0]! : entry.startsWith('C:S') ? entry.slice(3).split('|')[0]! : '';
    if (name && !names.includes(name)) names.push(name);
  }
  const order = names.map((name, i) => [name, `stmt#${i + 1}`] as const).sort((a, b) => b[0].length - a[0].length);
  return entries.map((entry) => order.reduce((text, [name, canonical]) => text.split(name).join(canonical), entry));
}

const chain: string[] = [];
for (let o = Object.getPrototypeOf(engine); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) chain.push(...Object.getOwnPropertyNames(o));

const out = {
  arm, kind, isProxy,
  samePrototypeAsDirect: Object.getPrototypeOf(engine) === Direct.prototype,
  constructorName: engine.constructor.name,
  ownKeys: Reflect.ownKeys(engine).map(String).sort(),
  protoNames: chain.sort(),
  shadowModulesAfterOpen: loadedAfterOpen.filter((p) => p.includes('/src/shadow/')),
  shadowModulesAfterWrites: loaded.filter((p) => p.includes('/src/shadow/')),
  wire: canonicalStatementNames(wire),
};
await engine.disconnect();
console.log(`PROBE_RESULT ${JSON.stringify(out)}`);
process.exit(0);
