#!/usr/bin/env bun
/**
 * Engine graduation day-1 spike: measures the two logical copy routes from a
 * PGLite brain into a Postgres target and the target-side trigger behaviour.
 * Findings: docs/designs/engine-graduation-spike.md.
 *
 *   graduation-spike.ts fixture <dir> [--pages 1000] [--seed 42]   build a history brain
 *   graduation-spike.ts legacy <dir>                                build the hand-made legacy brain
 *   graduation-spike.ts target-init <url>                           drop + initSchema the target
 *   graduation-spike.ts route-b <dir> <url> [--mode copy|values] [--bypass replica|disable|none] [--defer-indexes]
 *   graduation-spike.ts route-a <dir> <url> [--format copy|inserts]
 *   graduation-spike.ts verify <dir> <url>                          counts + per-table sha256, source vs target
 *   graduation-spike.ts triggers <dir> <url>                        copy with user triggers enabled, per table
 *
 * route-a needs `@electric-sql/pglite-tools@0.3.3` (not a foresights dependency: install it locally without
 * saving) and `psql` on PATH. SPIKE_NO_PREPARE=1 disables prepared statements for a transaction-mode pooler.
 *
 * `<dir>` holds `brain/` (PGLite data dir), `home/` (isolated GBRAIN_HOME)
 * and `checkouts/`. `<url>` must name a disposable database: target-init drops
 * every object in its public schema. Every command prints one JSON document.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from '#postgres';

type Row = Record<string, string | null>;
type Sql = ReturnType<typeof postgres>;

/** Relations a graduation never copies (plan §4: discard, rebuild, schema-owned). */
export const NOT_COPIED = new Set(['planner_stats_deltas', 'planner_stats_state', 'gbrain_cycle_locks', 'budget_reservations',
  'subagent_rate_leases', 'oauth_codes', 'query_cache', 'code_traversal_cache', 'file_migration_ledger', 'persistence_graduation']);
const ENGINE_LOCAL_CONFIG = ['engine', 'version', 'embedding_columns', 'search_embedding_column'];
/** Column transforms applied to the copied rows and to the source side of every digest. */
const TRANSFORMS: Record<string, Record<string, string>> = { persistence_brain: { enabled: "'false'" } };
const ROW_FILTERS: Record<string, string> = { config: `key NOT IN (${ENGINE_LOCAL_CONFIG.map(k => `'${k}'`).join(',')})` };

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const ms = (t0: number) => Math.round(performance.now() - t0);

// ---------------------------------------------------------------- engines

interface Reader { query(sql: string, params?: unknown[]): Promise<Row[]>; exec(sql: string): Promise<void> }

async function openPglite(dir: string, init = false) {
  process.env.GBRAIN_HOME = join(dir, 'home');
  delete process.env.DATABASE_URL; delete process.env.GBRAIN_DATABASE_URL;
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: join(dir, 'brain') });
  if (init) await engine.initSchema();
  return engine;
}
function pgliteReader(engine: { db: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> } }): Reader {
  return {
    query: async (s, p) => (await engine.db.query(s, p)).rows as Row[],
    exec: async s => { await engine.db.exec(s); },
  };
}
function target(url: string, opts: Record<string, unknown> = {}): Sql {
  return postgres(url, { max: 2, onnotice: () => {}, prepare: process.env.SPIKE_NO_PREPARE !== '1', ...opts });
}
function sqlReader(sql: Sql): Reader {
  return { query: async (s, p) => (await sql.unsafe(s, (p ?? []) as never[])) as unknown as Row[], exec: async s => { await sql.unsafe(s); } };
}

// ---------------------------------------------------------------- catalog

export interface TableMeta { name: string; columns: { name: string; type: string; generated: boolean; collatable: boolean }[]; pk: string[] }

export async function catalog(r: Reader): Promise<{ tables: TableMeta[]; fks: { child: string; parent: string }[]; sequences: string[] }> {
  const cols = await r.query(`SELECT c.relname AS rel, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type,
      (a.attgenerated <> '')::text AS gen, (t.typcollation <> 0)::text AS coll
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`);
  const pks = await r.query(`SELECT c.relname AS rel, a.attname AS col FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE n.nspname = 'public' AND i.indisprimary ORDER BY c.relname, k.ord`);
  const fks = await r.query(`SELECT DISTINCT cc.relname AS child, pc.relname AS parent FROM pg_constraint k
    JOIN pg_class cc ON cc.oid = k.conrelid JOIN pg_class pc ON pc.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = cc.relnamespace WHERE k.contype = 'f' AND n.nspname = 'public'`);
  const seqs = await r.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`);
  const tables = new Map<string, TableMeta>();
  for (const c of cols) {
    const t = tables.get(c.rel!) ?? { name: c.rel!, columns: [], pk: [] };
    t.columns.push({ name: c.col!, type: c.type!, generated: c.gen === 'true', collatable: c.coll === 'true' });
    tables.set(c.rel!, t);
  }
  for (const p of pks) tables.get(p.rel!)!.pk.push(p.col!);
  return { tables: [...tables.values()], fks: fks.map(f => ({ child: f.child!, parent: f.parent! })), sequences: seqs.map(s => s.name!) };
}

/** Parents before children; self-FKs ignored (one pass is enough when FK triggers are bypassed). */
export function topoOrder(tables: TableMeta[], fks: { child: string; parent: string }[]): TableMeta[] {
  const byName = new Map(tables.map(t => [t.name, t]));
  const out: TableMeta[] = []; const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`FK cycle: ${[...path, name].join(' -> ')}`);
    state.set(name, 'visiting');
    for (const f of fks) if (f.child === name && f.parent !== name && byName.has(f.parent)) visit(f.parent, [...path, name]);
    state.set(name, 'done'); out.push(byName.get(name)!);
  };
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) visit(t.name, []);
  return out;
}

const copied = (t: TableMeta) => !NOT_COPIED.has(t.name);
const copyColumns = (t: TableMeta) => t.columns.filter(c => !c.generated);
function selectList(t: TableMeta, applyTransforms: boolean): string {
  return copyColumns(t).map(c => {
    const tr = applyTransforms ? TRANSFORMS[t.name]?.[c.name] : undefined;
    return tr ? `${tr}::text AS ${ident(c.name)}` : `${ident(c.name)}::text AS ${ident(c.name)}`;
  }).join(', ');
}
function orderKey(t: TableMeta): { cols: TableMeta['columns']; order: string } {
  const cols = t.pk.length ? t.pk.map(k => t.columns.find(c => c.name === k)!) : copyColumns(t);
  return { cols, order: cols.map(c => `s.${ident(c.name)}${c.collatable ? ' COLLATE "C"' : ''}`).join(', ') };
}

/** Keyset-batched read of one table, values as canonical text, ordered by PK under COLLATE "C". */
async function* readBatches(r: Reader, t: TableMeta, batchRows: number, applyTransforms: boolean): AsyncGenerator<Row[]> {
  const { cols, order } = orderKey(t);
  const filter = ROW_FILTERS[t.name];
  if (!t.pk.length) { // no PK: one ordered read (the spike reports these tables)
    const rows = await r.query(`SELECT ${selectList(t, applyTransforms)} FROM ${ident(t.name)} AS s${filter ? ` WHERE ${filter}` : ''} ORDER BY ${order}`);
    if (rows.length) yield rows;
    return;
  }
  let last: (string | null)[] | null = null;
  for (;;) {
    const keyset = last ? `(${cols.map(c => `s.${ident(c.name)}${c.collatable ? ' COLLATE "C"' : ''}`).join(', ')}) > (${cols.map((c, i) => `$${i + 1}::${c.type}${c.collatable ? ' COLLATE "C"' : ''}`).join(', ')})` : '';
    const where = [filter, keyset].filter(Boolean).join(' AND ');
    const rows = await r.query(`SELECT ${selectList(t, applyTransforms)} FROM ${ident(t.name)} AS s${where ? ` WHERE ${where}` : ''} ORDER BY ${order} LIMIT ${batchRows}`, last ?? []);
    if (!rows.length) return;
    yield rows;
    if (rows.length < batchRows) return;
    last = cols.map(c => rows[rows.length - 1][c.name]);
  }
}

const SESSION = `SET TimeZone = 'UTC'; SET DateStyle = 'ISO'; SET extra_float_digits = 3; SET IntervalStyle = 'postgres'`;

// ---------------------------------------------------------------- digest

export async function digestAll(r: Reader, tables: TableMeta[], applyTransforms: boolean): Promise<Record<string, { rows: number; sha256: string }>> {
  await r.exec(SESSION);
  const out: Record<string, { rows: number; sha256: string }> = {};
  for (const t of tables) {
    const h = createHash('sha256'); let rows = 0;
    for await (const batch of readBatches(r, t, 2000, applyTransforms)) {
      for (const row of batch) { h.update(JSON.stringify(copyColumns(t).map(c => row[c.name]))); h.update('\n'); }
      rows += batch.length;
    }
    out[t.name] = { rows, sha256: h.digest('hex') };
  }
  return out;
}

/** Target-side digest inside one transaction so SET LOCAL holds on a transaction-mode pooler. */
async function digestTarget(sql: Sql, tables: TableMeta[]) {
  return sql.begin(async tx => digestAll({ query: async (s, p) => (await tx.unsafe(s, (p ?? []) as never[])) as unknown as Row[],
    exec: async s => { await tx.unsafe(s.replace(/SET /g, 'SET LOCAL ')); } }, tables, false));
}

// ---------------------------------------------------------------- Route B: inventory-driven copier

const copyEscape = (v: string | null) => v === null ? '\\N' : v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

export interface CopyOptions { mode: 'copy' | 'values'; bypass: 'replica' | 'disable' | 'none'; batchRows: number; batchBytes: number }

/** One table: delete the target's rows, then insert the source rows, in one target transaction. */
export async function copyTable(src: Reader, sql: Sql, t: TableMeta, o: CopyOptions): Promise<number> {
  const cols = copyColumns(t);
  const colList = cols.map(c => ident(c.name)).join(', ');
  const filter = ROW_FILTERS[t.name];
  let rows = 0;
  await sql.begin(async tx => {
    if (o.bypass === 'replica') await tx.unsafe('SET LOCAL session_replication_role = replica');
    await tx.unsafe(`DELETE FROM ${ident(t.name)}${filter ? ` WHERE ${filter}` : ''}`);
    rows = await insertRows(src, tx as unknown as Sql, t, o);
  });
  return rows;
}

/** Stream the source rows of one table into the open target transaction. */
async function insertRows(src: Reader, tx: Sql, t: TableMeta, o: CopyOptions): Promise<number> {
  const cols = copyColumns(t);
  const colList = cols.map(c => ident(c.name)).join(', ');
  let rows = 0;
  {
    if (o.mode === 'copy') {
      const q = tx.unsafe(`COPY ${ident(t.name)} (${colList}) FROM STDIN`);
      const w = await q.writable();
      // 'finish' fires once the server confirms the COPY. A server-side refusal reaches 'error' only with the
      // driver fix described in the spike doc; unpatched, a refused COPY never settles (see copyRefusalHang).
      const finished = new Promise<void>((res, rej) => { w.on('finish', res); w.on('error', rej); });
      const failed = finished.then(() => new Promise<never>(() => {}));
      failed.catch(() => {});
      let buf: string[] = []; let bytes = 0;
      const flush = async () => { if (!buf.length) return; const chunk = buf.join(''); buf = []; bytes = 0; if (!w.write(chunk)) await Promise.race([new Promise(r => w.once('drain', r)), failed]); };
      for await (const batch of readBatches(src, t, o.batchRows, true)) {
        for (const row of batch) { const line = cols.map(c => copyEscape(row[c.name])).join('\t') + '\n'; buf.push(line); bytes += line.length; if (bytes >= o.batchBytes) await flush(); }
        rows += batch.length;
      }
      await flush(); w.end(); await finished;
    } else {
      const maxRows = Math.max(1, Math.floor(65_000 / cols.length));
      for await (const batch of readBatches(src, t, Math.min(o.batchRows, maxRows), true)) {
        const params: (string | null)[] = []; const tuples: string[] = [];
        for (const row of batch) tuples.push(`(${cols.map(c => { params.push(row[c.name]); return `$${params.length}::text::${c.type}`; }).join(', ')})`);
        await tx.unsafe(`INSERT INTO ${ident(t.name)} (${colList}) VALUES ${tuples.join(', ')}`, params as never[]);
        rows += batch.length;
      }
    }
  }
  return rows;
}

/** Exact sequence positions (last_value, is_called), raised to the column max when that is higher. */
export async function copySequences(src: Reader, sql: Sql, sequences: string[], targetSeqs: Set<string>): Promise<number> {
  let n = 0;
  for (const s of sequences) {
    if (!targetSeqs.has(s)) continue;
    const [{ last_value, is_called }] = await src.query(`SELECT last_value::text, is_called::text FROM ${ident(s)}`);
    await sql.unsafe(`SELECT setval($1::regclass, $2::bigint, $3::boolean)`, [ident(s), last_value, is_called === 'true'] as never[]);
    n++;
  }
  return n;
}

async function userTriggers(sql: Sql) {
  return sql.unsafe(`SELECT c.relname AS rel, t.tgname AS name, t.tgenabled AS enabled, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1, 2`) as unknown as Promise<{ rel: string; name: string; enabled: string; def: string }[]>;
}

async function deferredIndexes(sql: Sql): Promise<{ name: string; def: string }[]> {
  return sql.unsafe(`SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND am.amname IN ('hnsw','ivfflat','gin','gist') AND NOT x.indisprimary AND NOT x.indisunique
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.oid)`) as unknown as Promise<{ name: string; def: string }[]>;
}

async function cmdRouteB(dir: string, url: string) {
  const o: CopyOptions = { mode: (arg('mode', 'copy') as CopyOptions['mode']), bypass: (arg('bypass', 'replica') as CopyOptions['bypass']),
    batchRows: Number(arg('batch-rows', '2000')), batchBytes: Number(arg('batch-bytes', String(4 << 20))) };
  const t0 = performance.now();
  const engine = await openPglite(dir);
  const src = pgliteReader(engine as never);
  await src.exec(SESSION);
  const sql = target(url);
  const cat = await catalog(src);
  const tcat = await catalog(sqlReader(sql));
  const tnames = new Set(tcat.tables.map(t => t.name));
  const order = topoOrder(cat.tables, cat.fks).filter(copied).filter(t => tnames.has(t.name));
  const timings: Record<string, number> = { open: ms(t0) };
  let dropped: { name: string; def: string }[] = [];
  if (flag('defer-indexes')) {
    const t1 = performance.now(); dropped = await deferredIndexes(sql);
    for (const d of dropped) await sql.unsafe(`DROP INDEX ${ident(d.name)}`);
    timings.dropIndexes = ms(t1);
  }
  const triggers = o.bypass === 'disable' ? [...new Set((await userTriggers(sql)).map(t => t.rel))].filter(r => order.some(t => t.name === r)) : [];
  if (o.bypass === 'disable') for (const r of triggers) await sql.unsafe(`ALTER TABLE ${ident(r)} DISABLE TRIGGER USER`);
  const t2 = performance.now(); const perTable: Record<string, { rows: number; ms: number }> = {};
  for (const t of order) { const t3 = performance.now(); perTable[t.name] = { rows: await copyTable(src, sql, t, o), ms: ms(t3) }; }
  timings.copy = ms(t2);
  if (o.bypass === 'disable') for (const r of triggers) await sql.unsafe(`ALTER TABLE ${ident(r)} ENABLE TRIGGER USER`);
  const t4 = performance.now();
  const seqs = await copySequences(src, sql, cat.sequences, new Set(tcat.sequences));
  timings.sequences = ms(t4);
  if (dropped.length) { const t5 = performance.now(); for (const d of dropped) await sql.unsafe(d.def); timings.buildIndexes = ms(t5); }
  timings.total = ms(t0);
  const rows = Object.values(perTable).reduce((a, b) => a + b.rows, 0);
  const slow = Object.entries(perTable).sort((a, b) => b[1].ms - a[1].ms).slice(0, 6);
  await engine.disconnect(); await sql.end();
  return { route: 'B', ...o, tables: order.length, rows, sequences: seqs, deferredIndexes: dropped.map(d => d.name), timings, slowest: Object.fromEntries(slow),
    noPk: order.filter(t => !t.pk.length).map(t => t.name) };
}

// ---------------------------------------------------------------- Route A: pglite-tools pgDump

async function cmdRouteA(dir: string, url: string) {
  const format = arg('format', 'copy');
  const t0 = performance.now();
  const engine = await openPglite(dir);
  const src = pgliteReader(engine as never);
  const cat = await catalog(src);
  const sql = target(url);
  const tcat = await catalog(sqlReader(sql));
  const tnames = new Set(tcat.tables.map(t => t.name)); const tseqs = new Set(tcat.sequences);
  const included = cat.tables.filter(copied).filter(t => tnames.has(t.name));
  const { pgDump } = await import('@electric-sql/pglite-tools/pg_dump' as string);
  const t1 = performance.now();
  const args = ['--data-only', '--no-owner', '--no-privileges', ...(format === 'inserts' ? ['--column-inserts', '--rows-per-insert=500'] : []),
    ...included.filter(t => !ROW_FILTERS[t.name]).map(t => `--table=public.${ident(t.name)}`),
    ...cat.sequences.filter(q => tseqs.has(q)).map(q => `--table=public.${ident(q)}`)];
  const file: File = await pgDump({ pg: engine.db as never, args });
  let dump = await file.text();
  const timings: Record<string, number> = { dump: ms(t1), dumpBytes: dump.length };
  await engine.disconnect();
  writeFileSync(join(dir, `route-a.${format}.sql`), dump);
  // The data-only dump assumes empty tables; initSchema seeded some. Clear them in the same transaction.
  const t2 = performance.now();
  const prelude = `BEGIN;\nSET LOCAL session_replication_role = replica;\n${included.filter(t => !ROW_FILTERS[t.name]).map(t => `DELETE FROM public.${ident(t.name)};`).join('\n')}\n`;
  const scrubbed = dump.split('\n').filter(l => !/^SET transaction_timeout/.test(l)).join('\n');
  const removed = dump.length - scrubbed.length;
  // pg_dump cannot filter rows or rewrite columns: transforms become UPDATEs, filtered tables go through the in-process copier.
  const transforms = Object.entries(TRANSFORMS).map(([t, cols]) => `UPDATE public.${ident(t)} SET ${Object.entries(cols).map(([c, v]) => `${ident(c)} = ${v}`).join(', ')};`).join('\n');
  dump = prelude + scrubbed + `\n${transforms}\nCOMMIT;\n`;
  const path = join(dir, `route-a.${format}.apply.sql`); writeFileSync(path, dump);
  const res = Bun.spawnSync(['psql', url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path], { stdout: 'pipe', stderr: 'pipe' });
  timings.apply = ms(t2);
  const t3 = performance.now();
  const src2 = pgliteReader((await openPglite(dir)) as never); await src2.exec(SESSION);
  for (const t of included.filter(t => ROW_FILTERS[t.name])) await copyTable(src2, sql, t, { mode: 'copy', bypass: 'replica', batchRows: 2000, batchBytes: 4 << 20 });
  timings.filteredTables = ms(t3);
  await sql.end();
  return { route: 'A', format, tables: included.length, timings, transactionTimeoutLineRemoved: removed > 0, psqlExit: res.exitCode,
    psqlStderr: res.stderr.toString().slice(0, 2000) };
}

// ---------------------------------------------------------------- verify

async function cmdVerify(dir: string, url: string) {
  const engine = await openPglite(dir);
  const src = pgliteReader(engine as never);
  const sql = target(url);
  const cat = await catalog(src);
  const tcat = await catalog(sqlReader(sql));
  const tnames = new Set(tcat.tables.map(t => t.name));
  const tables = cat.tables.filter(copied).filter(t => tnames.has(t.name));
  const t0 = performance.now();
  const a = await digestAll(src, tables, true);
  const tSrc = ms(t0);
  const t1 = performance.now();
  const b = await digestTarget(sql, tables);
  const tTgt = ms(t1);
  const mismatches = tables.filter(t => a[t.name].sha256 !== b[t.name].sha256).map(t => ({ table: t.name, source: a[t.name].rows, target: b[t.name].rows }));
  const countOf = async (r: Reader, t: TableMeta) => Number((await r.query(`SELECT count(*)::text AS n FROM ${ident(t.name)}${ROW_FILTERS[t.name] ? ` WHERE ${ROW_FILTERS[t.name]}` : ''}`))[0].n);
  const countMismatches: string[] = [];
  for (const t of tables) {
    const [x, y] = [await countOf(src, t), await countOf(sqlReader(sql), t)];
    if (x !== y || x !== a[t.name].rows) countMismatches.push(`${t.name}: count(*) ${x} vs ${y}, digested ${a[t.name].rows}`);
  }
  const seqDiff: string[] = [];
  for (const s of cat.sequences.filter(s => tcat.sequences.includes(s))) {
    const [x] = await src.query(`SELECT last_value::text AS v, is_called::text AS c FROM ${ident(s)}`);
    const [y] = await sql.unsafe(`SELECT last_value::text AS v, is_called::text AS c FROM ${ident(s)}`) as unknown as Row[];
    if (x.v !== y.v || x.c !== y.c) seqDiff.push(`${s}: ${x.v}/${x.c} vs ${y.v}/${y.c}`);
  }
  const trig = await userTriggers(sql);
  await engine.disconnect(); await sql.end();
  return { ok: mismatches.length === 0 && seqDiff.length === 0 && countMismatches.length === 0, countMismatches, tables: tables.length,
    rows: Object.values(a).reduce((s, x) => s + x.rows, 0), digestMs: { source: tSrc, target: tTgt }, mismatches, sequenceMismatches: seqDiff,
    triggersNotEnabled: trig.filter(t => t.enabled !== 'O').map(t => `${t.rel}.${t.name}=${t.enabled}`) };
}

// ---------------------------------------------------------------- triggers enabled: what rewrites, what refuses

async function cmdTriggers(dir: string, url: string) {
  // 1. Verbatim copy under replica: the target equals the source.
  const engine = await openPglite(dir);
  const src = pgliteReader(engine as never);
  await src.exec(SESSION);
  const sql = target(url);
  const cat = await catalog(src);
  const tnames = new Set((await catalog(sqlReader(sql))).tables.map(t => t.name));
  const order = topoOrder(cat.tables, cat.fks).filter(copied).filter(t => tnames.has(t.name));
  for (const t of order) await copyTable(src, sql, t, { mode: 'copy', bypass: 'replica', batchRows: 2000, batchBytes: 4 << 20 });
  const [{ enabled }] = await sql.unsafe('SELECT enabled::text FROM persistence_brain') as unknown as Row[];
  const trig = await userTriggers(sql);
  const base = await digestAll(src, order, true);
  // 2. Per table with user triggers: re-insert its rows with triggers firing (origin role), diff every table, roll back.
  const results: Record<string, unknown> = {};
  for (const rel of [...new Set(trig.map(t => t.rel))]) {
    const t = order.find(x => x.name === rel);
    if (!t) { results[rel] = 'not copied'; continue; }
    const Rollback = new Error('rollback');
    try {
      await sql.begin(async tx => {
        const txr: Reader = { query: async (q, p) => (await tx.unsafe(q, (p ?? []) as never[])) as unknown as Row[], exec: async q => { await tx.unsafe(q.replace(/SET /g, 'SET LOCAL ')); } };
        await tx.unsafe('SET LOCAL session_replication_role = replica');
        await tx.unsafe(`DELETE FROM ${ident(t.name)}${ROW_FILTERS[t.name] ? ` WHERE ${ROW_FILTERS[t.name]}` : ''}`);
        await tx.unsafe('SET LOCAL session_replication_role = origin');
        await tx.unsafe('SAVEPOINT ins');
        let refused: string | null = null;
        try { await insertRows(src, tx as unknown as Sql, t, { mode: 'values', bypass: 'none', batchRows: 2000, batchBytes: 4 << 20 }); }
        catch (e) { refused = (e as Error).message.split('\n')[0]; await tx.unsafe('ROLLBACK TO SAVEPOINT ins'); }
        if (refused) { results[rel] = { refused }; throw Rollback; }
        const after = await digestAll(txr, order, false);
        const changed: Record<string, unknown> = {};
        for (const x of order) {
          if (after[x.name].sha256 === base[x.name].sha256) continue;
          const cols: Record<string, number> = {}; const { cols: kc } = orderKey(x);
          const srcRows = new Map<string, Row>();
          for await (const b of readBatches(src, x, 5000, true)) for (const r of b) srcRows.set(JSON.stringify(kc.map(c => r[c.name])), r);
          let added = 0;
          for await (const b of readBatches(txr, x, 5000, false)) for (const r of b) {
            const sr = srcRows.get(JSON.stringify(kc.map(c => r[c.name])));
            if (!sr) { added++; continue; }
            for (const c of copyColumns(x)) if (sr[c.name] !== r[c.name]) cols[c.name] = (cols[c.name] ?? 0) + 1;
          }
          changed[x.name] = { rowsAdded: added, rowsRemoved: Math.max(0, base[x.name].rows - after[x.name].rows + added), columnsChanged: cols };
        }
        results[rel] = Object.keys(changed).length ? { rewrites: changed } : 'verbatim';
        throw Rollback;
      });
    } catch (e) { if (e !== Rollback) results[rel] = { error: (e as Error).message.split('\n')[0] }; }
  }
  await engine.disconnect(); await sql.end();
  return { persistenceBrainEnabled: enabled, userTriggers: trig.length, tablesWithTriggers: Object.keys(results).length,
    triggers: Object.fromEntries([...new Set(trig.map(t => t.rel))].map(r => [r, trig.filter(t => t.rel === r).map(t => t.name)])), results };
}

// ---------------------------------------------------------------- fixtures and target

async function cmdFixture(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const pages = Number(arg('pages', '1000'));
  const seed = Number(arg('seed', '42'));
  const t0 = performance.now();
  const engine = await openPglite(dir, true);
  const { buildHistoryFixture } = await import('./history-fixture.ts');
  const fixture = await buildHistoryFixture(engine, { pages, seed, sources: 3, worktrees: 2, root: join(dir, 'checkouts') });
  await engine.disconnect();
  const seconds = (performance.now() - t0) / 1000;
  const { observations: _o, remotes: _r, ...summary } = fixture;
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ ...summary, seconds }, null, 2));
  return { pages, seed, seconds, counts: fixture.counts };
}

/**
 * Hand-made legacy brain: an unmanaged v200 brain whose rows exercise every
 * target trigger that rewrites or refuses a verbatim insert, plus the column
 * types and key orderings the copy must preserve. Rows a source-side guard
 * would refuse are planted under session_replication_role = replica.
 */
async function cmdLegacy(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const engine = await openPglite(dir, true);
  const vec = (n: number, seed: number) => `[${Array.from({ length: n }, (_, i) => (Math.sin(seed * 7919 + i) / 3).toFixed(6)).join(',')}]`;
  // Text primary keys whose order differs between C and en_US collations.
  for (const id of ['Alpha', 'alpha', 'a-b', 'a_b', 'ärger', 'zeta']) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
  for (const [i, slug] of ['notes/one', 'notes/two', 'notes/three', 'people/alice-example', 'companies/acme-example'].entries()) {
    await engine.putPage(slug, { type: 'note', title: `Legacy ${slug}`, compiled_truth: `Body of ${slug}.`, timeline: i % 2 ? `- 2026-01-0${i}: event ${i}` : '', frontmatter: { n: i } }, { sourceId: i < 3 ? 'default' : 'alpha' });
  }
  const pid = async (slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [slug]))[0].id);
  const one = await pid('notes/one'); const two = await pid('notes/two');
  await engine.db.exec(`
    SET session_replication_role = replica;
    -- timeline row added after the page: pages.search_vector does not include it (stale by design)
    INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES (${one},'2026-02-01','legacy','Signed the lease','with acme-example');
    -- tags: target AFTER trigger rewrites pages.knowledge_revision
    INSERT INTO tags(page_id,tag) VALUES (${one},'legacy'),(${two},'legacy');
    -- page revision attribution, and a legacy unattributed version row the target trigger would fill
    UPDATE pages SET revision_principal_kind='local_cli', revision_principal_id='legacy-cli', revision_write_request_id='00000000-0000-4000-8000-000000000001' WHERE id=${one};
    INSERT INTO page_versions(page_id,compiled_truth,knowledge_revision,title,type) SELECT id,'old body',knowledge_revision,title,type FROM pages WHERE id=${one};
    -- minion jobs: one that ran (claim_generation 3), one pre-protocol job (no submission_authority), parent/child self-FK
    INSERT INTO minion_jobs(id,name,status,submission_authority,claim_generation,data) VALUES
      (10,'embed','completed','{"kind":"local"}',3,'{}'),(11,'legacy-sync','waiting',NULL,0,'{}');
    INSERT INTO minion_jobs(id,name,status,submission_authority,claim_generation,parent_job_id,data) VALUES (12,'child','waiting','{"kind":"local"}',0,10,'{}');
    SELECT setval('minion_jobs_id_seq', 40, true);
    INSERT INTO minion_attachments(job_id,filename,content_type,content,size_bytes,sha256) VALUES (10,'blob.bin','application/octet-stream','\\x00ff10e2'::bytea,4,'x');
    -- facts: withdrawn fact (expired_at/valid_until preserved), superseded chain (self-FK), halfvec embedding
    INSERT INTO facts(id,source_id,entity_slug,fact,source,embedding,valid_until,expired_at) VALUES
      (1,'default','people/alice-example','Lives in a city','legacy','${vec(1024, 1)}',NULL,NULL),
      (2,'default','people/alice-example','Lives in another city','legacy',NULL,'2026-03-01T00:00:00Z','2026-03-02T00:00:00Z');
    UPDATE facts SET superseded_by=2 WHERE id=1;
    SELECT setval('facts_id_seq', 77, false);
    -- embeddings on chunks (vector)
    UPDATE content_chunks SET embedding = ('${vec(1024, 2)}')::vector, model='legacy-model' WHERE page_id=${one};
    -- shared skill publication rows: the target guard refuses them while enabled=false
    INSERT INTO shared_skill_packs(source_id,source_incarnation,pack_id,revision,manifest,manifest_hash)
      SELECT 'alpha', incarnation, 'pack-a', '00000000-0000-4000-8000-0000000000aa', '{"skills":[]}', 'h' FROM sources WHERE id='alpha';
    -- protocol floor raised with publication on: the target activation guard refuses copying it at enabled=false
    UPDATE persistence_brain SET writer_protocol_floor=2, skill_bundles_enabled=true;
    -- floats, numerics, arrays
    INSERT INTO budget_ledger(scope,resolver_id,local_date,cap_usd,reserved_usd,committed_usd) VALUES ('legacy','r1','2026-01-01',1.2345,0.0001,0.1);
    SET session_replication_role = origin;
  `);
  await engine.disconnect();
  return { built: dir };
}

/** Give a brain copy realistic vectors: every chunk, fact and take gets a deterministic pseudo-random embedding. */
async function cmdEmbed(dir: string) {
  const engine = await openPglite(dir);
  const t0 = performance.now();
  await engine.db.exec(`SET session_replication_role = replica; SELECT setseed(0.42);
    UPDATE content_chunks SET embedding = (SELECT array_agg(random()::real - 0.5) FROM generate_series(1, 1024 + 0 * id))::vector, model = 'spike-random-1024', embedded_at = now();
    UPDATE facts SET embedding = (SELECT array_agg(random()::real - 0.5) FROM generate_series(1, 1024 + 0 * id))::halfvec;
    UPDATE takes SET embedding = (SELECT array_agg(random()::real - 0.5) FROM generate_series(1, 1024 + 0 * id))::vector;
    SET session_replication_role = origin;`);
  const [n] = await engine.db.query<{ chunks: number; facts: number; takes: number }>(`SELECT (SELECT count(*) FROM content_chunks WHERE embedding IS NOT NULL)::int AS chunks,
    (SELECT count(*) FROM facts WHERE embedding IS NOT NULL)::int AS facts, (SELECT count(*) FROM takes WHERE embedding IS NOT NULL)::int AS takes`).then(r => r.rows);
  await engine.disconnect();
  return { embedded: n, ms: ms(t0) };
}

/** Time-to-value phases on one brain: target initSchema, copy (indexes deferred or not), index build, digest verify, both doctors. */
async function cmdTtv(dir: string, url: string) {
  const phases: Record<string, number> = {};
  const doctor = (env: Record<string, string>) => {
    const t = performance.now();
    const r = Bun.spawnSync(['bun', 'src/cli.ts', 'doctor', '--no-migrate', '--json'], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    let failing: string[] = [];
    try { failing = (JSON.parse(r.stdout.toString()).checks as { name: string; status: string }[]).filter(c => c.status === 'fail').map(c => c.name); } catch { failing = ['<unparseable>']; }
    return { ms: ms(t), failing };
  };
  const home = join(dir, 'home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'brain') }));
  const sourceDoctor = doctor({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: '', DATABASE_URL: '' });
  phases.sourceDoctor = sourceDoctor.ms;
  phases.initSchema = (await cmdTargetInit(url)).totalMs;
  const copy = await cmdRouteB(dir, url);
  Object.assign(phases, { copy: copy.timings.copy, sequences: copy.timings.sequences, dropIndexes: copy.timings.dropIndexes ?? 0, buildIndexes: copy.timings.buildIndexes ?? 0 });
  const t = performance.now(); const v = await cmdVerify(dir, url); phases.verify = ms(t);
  const dochome = join(dir, 'ttv-target-home'); mkdirSync(dochome, { recursive: true });
  const targetDoctor = doctor({ GBRAIN_HOME: dochome, GBRAIN_DATABASE_URL: url });
  phases.targetDoctor = targetDoctor.ms;
  phases.total = Object.entries(phases).filter(([k]) => k !== 'total').reduce((a, [, b]) => a + b, 0);
  return { deferIndexes: flag('defer-indexes'), rows: copy.rows, verifyOk: v.ok, deferred: copy.deferredIndexes, phases,
    sourceDoctorFailing: sourceDoctor.failing, targetDoctorFailing: targetDoctor.failing };
}

async function cmdTargetInit(url: string) {
  const sql = target(url);
  const t0 = performance.now();
  if (!flag('no-drop')) await sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public`);
  await sql.end();
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url, poolSize: 2 });
  const t1 = performance.now();
  await engine.initSchema();
  const initMs = ms(t1);
  await engine.disconnect();
  return { initSchemaMs: initMs, totalMs: ms(t0) };
}

const [cmd, a1, a2] = process.argv.slice(2);
const commands: Record<string, () => Promise<unknown>> = {
  fixture: () => cmdFixture(resolve(a1)),
  legacy: () => cmdLegacy(resolve(a1)),
  embed: () => cmdEmbed(resolve(a1)),
  ttv: () => cmdTtv(resolve(a1), a2),
  'target-init': () => cmdTargetInit(a1),
  'route-a': () => cmdRouteA(resolve(a1), a2),
  'route-b': () => cmdRouteB(resolve(a1), a2),
  verify: () => cmdVerify(resolve(a1), a2),
  triggers: () => cmdTriggers(resolve(a1), a2),
};
if (import.meta.main) {
  if (!commands[cmd]) { console.error(`usage: graduation-spike.ts ${Object.keys(commands).join('|')} ...`); process.exit(2); }
  console.log(JSON.stringify(await commands[cmd](), null, 2));
  process.exit(0);
}
