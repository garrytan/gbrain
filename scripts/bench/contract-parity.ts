#!/usr/bin/env bun
/**
 * Contract-parity and latency harness (LHF wave 2, item G). A bench, not a test.
 *
 * It answers one question for a performance change: does the remote caller see
 * exactly what it saw before, and how much faster does it see it. Two trees are
 * compared through receipts, never in one process:
 *
 *   bun scripts/bench/contract-parity.ts template --out <dir> [--engine pglite|postgres] [--admin-url <url>] [--pages 400]
 *   bun scripts/bench/contract-parity.ts capture  --template <dir> --out <receipt.json> [--perturb]
 *   bun scripts/bench/contract-parity.ts compare  <base.json> <branch.json> [--json]
 *   bun scripts/bench/contract-parity.ts latency  --template <dir> --out <receipt.json> [--rtt-ms 30] [--iterations 5]
 *   bun scripts/bench/contract-parity.ts contention --template <dir> --out <receipt.json> [--pools 2,6] [--searches 8]
 *
 * scripts/bench/contract-parity.sh <base-ref> runs the whole master-vs-branch
 * sequence (template from the base tree, interleaved captures, compare).
 *
 * template: one fixture brain, built once by the base tree. A directory holds
 * a PGLite data dir, or for Postgres a template database name on --admin-url.
 * Every pass of every arm restores a clone of it, so both arms start from the
 * same rows and each tree applies its own migrations on open (an upgraded brain).
 *
 * capture: each pass runs in its own child process (module caches and
 * once-per-process notices start fresh), opens a clone, applies the pass's
 * config, and sends a fixed call sequence through dispatchToolCall with the
 * stdio MCP server's options (remote: true). It records every content block,
 * `_meta`, and afterwards the write side effects: row counts of every table
 * and the rows of the log tables the calls write.
 *
 * Every pass stamps the sources' created_at to a fixed date, so the one-time
 * behavior-change disclosure (which keys off brain age) is the same on every run.
 *
 * Normalizations, and only these: timings (keys ending `_ms`, `timings`,
 * `took`, and "<n> ms" in text), `answer_id` (replaced by its order of
 * appearance within the pass, everywhere it occurs), the `how_to_rate` cadence
 * field, and the one-time behavior-change disclosure (moved to its own field
 * and reported, not failed). Write-side rows drop surrogate ids and
 * timestamps. Anything else that differs is a parity failure.
 *
 * compare: deep equality with numeric tolerance on score-like keys (cosine
 * 5e-6, other scores 2e-6). Rows may change order only among rows whose scores
 * are within tolerance. Statement counts per call are reported as deltas.
 *
 * Isolation: temporary GBRAIN_HOME, provider keys removed, the stub embedder
 * and reranker from bench-refactor-wave-1, fetch disabled, TZ=UTC.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import type { BrainEngine } from '../../src/core/engine.ts';
import { corpusPage, PgFrontendCounter, stubVector, summarize, vocabulary, type WireCounts } from '../bench-refactor-wave-1.ts';

const REPO = resolve(import.meta.dir, '../..');
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY', 'TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY',
  'DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'MINIMAX_API_KEY', 'TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY'];
export const COSINE_TOLERANCE = 5e-6;
export const SCORE_TOLERANCE = 2e-6;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

// ---------------------------------------------------------------------------
// Template manifest
// ---------------------------------------------------------------------------

interface TemplateManifest { engine: 'pglite' | 'postgres'; data_dir?: string; admin_url?: string; database?: string; pages: number; dims: number; built_by: string }

function readManifest(dir: string): TemplateManifest {
  return JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8')) as TemplateManifest;
}

function gitHead(): string {
  const r = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return (r.stdout ?? '').trim() || 'unknown';
}

function dbUrl(admin: string, database: string): string {
  const u = new URL(admin);
  u.pathname = `/${database}`;
  return u.toString();
}

async function adminSql(admin: string) {
  const { default: postgres } = await import('#postgres');
  return postgres(admin, { max: 1, onnotice: () => {} });
}

/** A private copy of the template for one pass; returns where to open it and how to drop it. */
async function restoreClone(m: TemplateManifest): Promise<{ target: string; drop: () => Promise<void> }> {
  if (m.engine === 'pglite') {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parity-clone-'));
    cpSync(m.data_dir!, join(dir, 'brain.pglite'), { recursive: true });
    return { target: join(dir, 'brain.pglite'), drop: async () => rmSync(dir, { recursive: true, force: true }) };
  }
  const name = `gbrain_parity_clone_${randomBytes(4).toString('hex')}`;
  const sql = await adminSql(m.admin_url!);
  try { await sql.unsafe(`CREATE DATABASE ${name} TEMPLATE ${m.database}`); } finally { await sql.end(); }
  return {
    target: dbUrl(m.admin_url!, name),
    drop: async () => {
      const s = await adminSql(m.admin_url!);
      try { await s.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await s.end(); }
    },
  };
}

// ---------------------------------------------------------------------------
// Process isolation (shared by every child)
// ---------------------------------------------------------------------------

const providerCalls = { embed: 0, rerank: 0, fetch: 0 };
const realFetch = globalThis.fetch;

/** Runs a harness call with the real fetch (the toxiproxy API is loopback, not a provider). */
async function withRealFetch<T>(fn: () => Promise<T> | T): Promise<T> {
  const stub = globalThis.fetch;
  globalThis.fetch = realFetch;
  try { return await fn(); } finally { globalThis.fetch = stub; }
}

function isolateProcess(home: string): void {
  for (const key of [...PROVIDER_KEYS, 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_PGLITE_SNAPSHOT', 'GBRAIN_PREPARE', 'GBRAIN_SOURCE']) delete process.env[key];
  Object.assign(process.env, {
    HOME: home, GBRAIN_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_UPDATE_CHECK: '1', GBRAIN_MODEL_DISCOVERY: 'off', TZ: 'UTC',
  });
}

async function installStubs(): Promise<number> {
  const { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } = await import('../../src/core/ai/defaults.ts');
  mkdirSync(join(process.env.GBRAIN_HOME!, '.gbrain'), { recursive: true });
  writeFileSync(join(process.env.GBRAIN_HOME!, '.gbrain', 'config.json'),
    JSON.stringify({ embedding_model: DEFAULT_EMBEDDING_MODEL, embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS }));
  const gw = await import('../../src/core/ai/gateway.ts');
  gw.configureGateway({ embedding_model: DEFAULT_EMBEDDING_MODEL, embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS, env: { VOYAGE_API_KEY: 'bench-stub-not-a-key' } });
  const dims = DEFAULT_EMBEDDING_DIMENSIONS;
  gw.__setEmbedTransportForTests((async (input: { values: string[] }) => {
    providerCalls.embed++;
    return { embeddings: input.values.map(text => stubVector(text, dims)) };
  }) as never);
  gw.__setRerankTransportForTests(async (_url: string, init: RequestInit) => {
    providerCalls.rerank++;
    const documents = (JSON.parse(String(init.body)) as { documents?: unknown[] }).documents ?? [];
    const results = documents.map((_, index) => ({ index, relevance_score: 1 - index / (documents.length + 1) }));
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  globalThis.fetch = (async (input: unknown) => {
    providerCalls.fetch++;
    throw new Error(`parity: network disabled (${String(input)})`);
  }) as unknown as typeof fetch;
  return dims;
}

async function openEngine(m: TemplateManifest, target: string, poolSize?: number): Promise<BrainEngine> {
  const { createEngine } = await import('../../src/core/engine-factory.ts');
  const { resolvePoolSize } = await import('../../src/core/db.ts');
  const config = m.engine === 'pglite'
    ? { engine: 'pglite' as const, database_path: target }
    : { engine: 'postgres' as const, database_url: target, poolSize: poolSize ?? resolvePoolSize() };
  const engine = await createEngine(config);
  await engine.connect(config);
  await engine.initSchema();
  return engine;
}

// ---------------------------------------------------------------------------
// Fixture brain
// ---------------------------------------------------------------------------

const FIXED_DAY = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset, 12, 0, 0));

/** Saved facts that exercise every matching edge of matchingSavedFacts (synthetic names only). */
export function savedFactFixtures(): Array<{ fact: string; entity_slug?: string; visibility?: 'world' | 'private'; source_id?: string; expired?: boolean; day: number }> {
  const out: Array<{ fact: string; entity_slug?: string; visibility?: 'world' | 'private'; source_id?: string; expired?: boolean; day: number }> = [
    { fact: 'The board approved the budget for the harbor project', day: 1 },
    { fact: 'Renewal contract signed after a long negotiation', entity_slug: 'companies/zorblax-example', day: 2 },
    { fact: 'Billing questions go to ops@acme-example.com and pricing lives at https://acme-example.com/pricing', day: 3 },
    { fact: 'Renewals were delayed until the security review finished', day: 4 },
    { fact: 'The urban banana co-op moved its warehouse', day: 5 },
    { fact: 'Private note: the quillfeather deal terms are confidential', visibility: 'private', day: 6 },
    { fact: 'Old address for quillfeather was retired', expired: true, day: 7 },
    { fact: 'Quillfeather fact saved in the other source', source_id: 'other', day: 8 },
    { fact: "alice-example's preferred meeting slot is tuesday morning", entity_slug: 'people/alice-example', day: 9 },
  ];
  for (let i = 0; i < 260; i++) out.push({ fact: `Kestrel sighting log entry ${i} near the north ridge`, day: 10 + (i % 200) });
  const words = vocabulary();
  for (let i = 0; i < 1500; i++) out.push({ fact: `Filler memory ${i}: ${words[i % 256]} ${words[(i * 7) % 256]} ${words[(i * 13) % 256]}`, day: i % 300 });
  return out;
}

interface FixturePage { slug: string; source: string; content: string; noEmbed?: boolean }

function fixturePages(): FixturePage[] {
  const pages: FixturePage[] = [];
  const fm = (type: string, title: string, extra = '') => `---\ntype: ${type}\ntitle: ${title}\n${extra}---\n\n`;
  for (let i = 0; i < 12; i++) pages.push({ slug: `emails/thread-${i}`, source: 'default',
    content: `${fm('email', `Quarterly invoice thread ${i}`)}# Quarterly invoice thread ${i}\n\nThe quarterly invoice for the harbor project was sent on day ${i}. Kestrel ridge logistics and the budget review are attached.\n` });
  for (let i = 0; i < 6; i++) pages.push({ slug: `meetings/harbor-sync-${i}`, source: 'default',
    content: `${fm('meeting', `Harbor sync ${i}`)}# Harbor sync ${i}\n\nAttendees: [[people/alice-example]], [[people/bob-example]].\n\nWe reviewed the quarterly invoice and the renewal timeline.\n` });
  for (const name of ['alice-example', 'bob-example', 'carol-example']) pages.push({ slug: `people/${name}`, source: 'default',
    content: `${fm('person', name)}# ${name}\n\n${name} works on the harbor project and joins the harbor sync.\n` });
  pages.push({ slug: 'notes/private-marker', source: 'default',
    content: `${fm('note', 'Private marker', 'visibility: private\n')}# Private marker\n\nThe vellichor ledger lives here.\n` });
  pages.push({ slug: 'notes/quarantined-marker', source: 'default',
    content: `${fm('note', 'Quarantined marker', 'quarantine:\n  reason: fixture\n')}# Quarantined marker\n\nThe vellichor archive was quarantined.\n` });
  pages.push({ slug: 'notes/zero-vector', source: 'default',
    content: `${fm('note', 'Zero vector page')}# Zero vector page\n\nThe petrichor harbor note has a zero embedding.\n` });
  pages.push({ slug: 'notes/missing-vector', source: 'default', noEmbed: true,
    content: `${fm('note', 'Missing vector page')}# Missing vector page\n\nThe petrichor harbor memo has no embedding yet.\n` });
  for (let i = 0; i < 4; i++) pages.push({ slug: `companies/org-${i}`, source: 'other',
    content: `${fm('company', `Org ${i} example`)}# Org ${i} example\n\nOrg ${i} example is a harbor logistics company. Quarterly invoice disputes are handled here.\n` });
  for (let i = 0; i < 40; i++) {
    const page = corpusPage(5000 + i, 3, 'other/topic');
    pages.push({ slug: page.slug, source: 'other', content: page.content });
  }
  return pages;
}

async function buildTemplate(): Promise<void> {
  const out = resolve(arg('--out') ?? join(tmpdir(), `gbrain-parity-template-${randomBytes(3).toString('hex')}`));
  const kind = (arg('--engine') ?? 'pglite') as 'pglite' | 'postgres';
  const pages = Number(arg('--pages') ?? 400);
  if (existsSync(join(out, 'template.json'))) throw new Error(`parity: ${out} already holds a template`);
  mkdirSync(out, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-home-'));
  isolateProcess(home);
  const dims = await installStubs();
  const m: TemplateManifest = { engine: kind, pages, dims, built_by: gitHead() };
  let target: string;
  if (kind === 'pglite') { m.data_dir = join(out, 'brain.pglite'); target = m.data_dir; }
  else {
    m.admin_url = arg('--admin-url') ?? process.env.GBRAIN_PARITY_ADMIN_URL;
    if (!m.admin_url) throw new Error('parity: --admin-url is required for postgres');
    m.database = `gbrain_parity_tmpl_${randomBytes(4).toString('hex')}`;
    const sql = await adminSql(m.admin_url);
    try { await sql.unsafe(`CREATE DATABASE ${m.database}`); } finally { await sql.end(); }
    target = dbUrl(m.admin_url, m.database);
  }
  const engine = await openEngine(m, target, 2);
  const { importFromContent } = await import('../../src/core/import-file.ts');
  try {
    await engine.executeRaw(`INSERT INTO sources(id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
    const { DEFAULT_EMBEDDING_MODEL } = await import('../../src/core/ai/defaults.ts');
    await engine.setConfig('embedding_model', DEFAULT_EMBEDDING_MODEL);
    await engine.setConfig('embedding_dimensions', String(dims));
    await engine.setConfig('schema_pack.source.other', 'company-brain');
    await engine.setConfig('feedback.implicit', 'false');
    for (let i = 0; i < pages; i++) {
      const page = corpusPage(i, 4);
      const r = await importFromContent(engine, page.slug, page.content);
      if (r.status !== 'imported') throw new Error(`parity: import ${page.slug}: ${r.status} ${r.error ?? ''}`);
    }
    for (const page of fixturePages()) {
      const r = await importFromContent(engine, page.slug, page.content, { sourceId: page.source, noEmbed: page.noEmbed });
      if (r.status !== 'imported') throw new Error(`parity: import ${page.slug}: ${r.status} ${r.error ?? ''}`);
    }
    await engine.executeRaw(`UPDATE content_chunks SET embedding = $1::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/zero-vector' AND source_id = 'default')`, [`[${new Array(dims).fill(0).join(',')}]`]);
    await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_hv halfvec(${dims})`);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_hv = embedding::halfvec WHERE embedding IS NOT NULL`);
    await engine.setConfig('embedding_columns', JSON.stringify({ embedding_hv: { provider: DEFAULT_EMBEDDING_MODEL, dimensions: dims, type: 'halfvec' } }));
    const { segmentPage } = await import('../../test/helpers/segmented-chunks-fixture.ts');
    const segmented = await segmentPage(engine, 'logs/segmented-harbor', {
      generation: 2,
      occurrences: [
        { id: 10, byteStart: 0, genFrom: 1, chunks: [{ text: 'live heron passage about the harbor ledger' }, { text: 'second live heron passage' }] },
        { id: 30, byteStart: 4096, genFrom: 1, genTo: 2, chunks: [{ text: 'retired quokka passage about the harbor ledger' }] },
        { id: 40, byteStart: 8192, genFrom: 3, chunks: [{ text: 'staged wombat passage about the harbor ledger' }] },
      ],
    });
    for (const [text, id] of segmented.chunkIds) {
      await engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector, embedding_hv = $1::halfvec, model = $2 WHERE id = $3',
        [`[${stubVector(text, dims).join(',')}]`, DEFAULT_EMBEDDING_MODEL, id]);
    }
    for (const f of savedFactFixtures()) {
      await engine.insertFact({ // gbrain-allow-direct-insert: bench fixture brain, built once and cloned per pass
        fact: f.fact, entity_slug: f.entity_slug ?? null, kind: 'fact', visibility: f.visibility ?? 'world', source: 'mcp:extract_facts',
        valid_from: FIXED_DAY(f.day), expired_at: f.expired ? FIXED_DAY(f.day + 1) : null,
        embedding: Float32Array.from(stubVector(f.fact, dims)), embedding_model: DEFAULT_EMBEDDING_MODEL,
      }, { source_id: f.source_id ?? 'default' });
    }
    await engine.executeRaw('ANALYZE');
  } finally {
    await engine.disconnect();
  }
  writeFileSync(join(out, 'template.json'), JSON.stringify(m, null, 2));
  rmSync(home, { recursive: true, force: true });
  console.log(`template: ${out} (${kind}, ${pages} corpus pages, built by ${m.built_by})`);
}

// ---------------------------------------------------------------------------
// Call sequence
// ---------------------------------------------------------------------------

export interface Call { op: string; params: Record<string, unknown>; federated?: boolean; sourceId?: string }
export interface Pass { name: string; config?: Record<string, string>; calls: Call[] }

export function passes(): Pass[] {
  const words = vocabulary();
  const plain = Array.from({ length: 8 }, (_, i) => `${words[(i * 37) % 256]} ${words[(i * 91 + 5) % 256]}`);
  const both = (query: string, extra: Record<string, unknown> = {}): Call[] => [
    { op: 'search', params: { query, ...extra } }, { op: 'query', params: { query, ...extra } }];
  const main: Call[] = [
    ...plain.flatMap(q => both(q)),
    ...both('quarterly invoice', { types: ['email'] }),
    ...both('harbor sync renewal', { types: ['meeting', 'email'] }),
    ...both('quarterly invoice', { types: ['ghosttype'] }),
    ...both('quarterly invoice', { types: ['email', 'ghosttype'] }),
    ...both('harbor logistics', { types: ['organization'] }).map(c => ({ ...c, sourceId: 'other' })),
    ...both('harbor logistics', { types: ['company', 'ghosttype'] }).map(c => ({ ...c, sourceId: 'other' })),
    ...both('the budget'),
    ...both('zorblax'),
    ...both('ops@acme-example.com'),
    ...both('acme-example.com/pricing'),
    ...both('renewal delay'),
    ...both('ban'),
    ...both('kestrel sighting'),
    ...both('quillfeather'),
    ...both("alice-example's meeting slot"),
    ...both('vellichor ledger'),
    ...both('petrichor harbor'),
    ...both('heron harbor ledger'),
    ...both('quokka wombat harbor ledger'),
    { op: 'search', params: { query: 'quarterly invoice', limit: 50 } },
    { op: 'search', params: { query: 'quarterly invoice', limit: 5, offset: 5 } },
    { op: 'query', params: { query: 'harbor project budget', limit: 30 } },
  ];
  const federated: Call[] = [
    ...both('harbor logistics').map(c => ({ ...c, federated: true })),
    ...both('quarterly invoice').map(c => ({ ...c, federated: true })),
    ...both(plain[0]!).map(c => ({ ...c, federated: true })),
    ...both('quillfeather').map(c => ({ ...c, federated: true })),
  ];
  return [
    { name: 'main', calls: main },
    { name: 'federated', calls: federated },
    { name: 'halfvec', config: { search_embedding_column: 'embedding_hv' }, calls: [...plain.slice(0, 3).flatMap(q => both(q)), ...both('petrichor harbor')] },
    { name: 'feedback', config: { 'feedback.enabled': 'true', 'feedback.learn': 'false' }, calls: [...both('quarterly invoice'), ...both(plain[1]!), ...both('kestrel sighting')] },
  ];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const TIMING_KEY = /(^|_)(ms|timings|took|elapsed|latency|duration)$|_ms$|^timings$/;
const DISCLOSURE = /behavior[ _-]change/i;

export interface NormalizedResponse { blocks: unknown[]; meta: unknown; disclosures: string[]; is_error: boolean }

function parseMaybeJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return text;
  try { return JSON.parse(t); } catch { return text; }
}

function normalizeValue(value: unknown, answerIds: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let s = value.replace(/\b\d+(?:\.\d+)? ?ms\b/g, '<n> ms');
    for (const [id, label] of answerIds) s = s.split(id).join(label);
    return s;
  }
  if (Array.isArray(value)) return value.map(v => normalizeValue(v, answerIds));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TIMING_KEY.test(k)) { out[k] = '<timing>'; continue; }
      if (k === 'how_to_rate') { out[k] = '<how_to_rate>'; continue; }
      out[k] = normalizeValue(v, answerIds);
    }
    return out;
  }
  return value;
}

function collectAnswerIds(value: unknown, into: Map<string, string>): void {
  if (Array.isArray(value)) { for (const v of value) collectAnswerIds(v, into); return; }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'answer_id' && typeof v === 'string' && !into.has(v)) into.set(v, `<answer_id:${into.size}>`);
    else collectAnswerIds(v, into);
  }
}

export function normalizeResponse(result: { content: Array<{ text: string }>; _meta?: unknown; isError?: boolean }, answerIds: Map<string, string>): NormalizedResponse {
  const parsed = result.content.map(c => parseMaybeJson(c.text));
  collectAnswerIds(parsed, answerIds);
  collectAnswerIds(result._meta, answerIds);
  for (const p of parsed) if (typeof p === 'string') for (const m of p.matchAll(/answer_id: "([^"]+)"/g)) if (!answerIds.has(m[1]!)) answerIds.set(m[1]!, `<answer_id:${answerIds.size}>`);
  const disclosures: string[] = [];
  const blocks: unknown[] = [];
  for (const p of parsed) {
    if (typeof p === 'string' && DISCLOSURE.test(p)) { disclosures.push(normalizeValue(p, answerIds) as string); continue; }
    blocks.push(normalizeValue(p, answerIds));
  }
  let meta = result._meta ? normalizeValue(result._meta, answerIds) as Record<string, unknown> : null;
  if (meta && Array.isArray(meta.gbrain_notices)) {
    const notices = meta.gbrain_notices as unknown[];
    const keep = notices.filter(n => !DISCLOSURE.test(JSON.stringify(n)));
    for (const n of notices) if (!keep.includes(n)) disclosures.push(JSON.stringify(n));
    const { gbrain_notices: _all, ...rest } = meta;
    meta = keep.length || notices.length === 0 ? { ...rest, gbrain_notices: keep } : rest;
  }
  return { blocks, meta, disclosures, is_error: result.isError === true };
}

// ---------------------------------------------------------------------------
// Write side effects
// ---------------------------------------------------------------------------

const LOG_TABLE = /feedback|retrieval|request_log|answer|query_log|search_log|verb_usage|usage_events/;
const VOLATILE_COLUMN = /^(.*_at|ts|.*_ms|latency.*|duration.*|request_id|session.*)$/;

/** Log rows without timestamps; ids the pass minted become their answer_id label, other minted ids are dropped. */
function normalizeLogRow(row: Record<string, unknown>, answerIds: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (VOLATILE_COLUMN.test(k)) continue;
    const mapped = typeof v === 'string' ? answerIds.get(v) : undefined;
    if (mapped) { out[k] = mapped; continue; }
    if (k === 'id' || /_uuid$/.test(k)) continue;
    out[k] = v instanceof Date ? '<date>' : v instanceof Uint8Array ? '<bytes>' : v;
  }
  return out;
}

async function writeSideEffects(engine: BrainEngine, answerIds: Map<string, string>): Promise<{ counts: Record<string, number>; logs: Record<string, unknown[]> }> {
  const tables = await engine.executeRaw<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const counts: Record<string, number> = {};
  const logs: Record<string, unknown[]> = {};
  for (const { table_name: t } of tables) {
    const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`);
    counts[t] = Number(row?.n ?? 0);
    if (!LOG_TABLE.test(t) || counts[t] === 0 || counts[t] > 500) continue;
    const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT * FROM "${t}"`);
    logs[t] = rows.map(r => JSON.stringify(normalizeLogRow(r, answerIds))).sort().map(s => JSON.parse(s));
  }
  return { counts, logs };
}

// ---------------------------------------------------------------------------
// Statement counting
// ---------------------------------------------------------------------------

interface Counter { read(): WireCounts; close(): Promise<void>; url?: string }

function pgliteCounter(engine: BrainEngine): Counter {
  const raw = (engine as unknown as { _statements: { db: Record<string, unknown> } | null })._statements?.db
    ?? (engine as unknown as { db?: Record<string, unknown> }).db;
  if (!raw || typeof raw.execProtocolRawSync !== 'function') return { read: () => ({ roundTrips: 0, parses: 0, messages: 0 }), close: async () => {} };
  const original = (raw.execProtocolRawSync as (message: Uint8Array, ...rest: unknown[]) => unknown).bind(raw);
  const counts: WireCounts = { roundTrips: 0, parses: 0, messages: 0 };
  raw.execProtocolRawSync = (message: Uint8Array, ...rest: unknown[]) => {
    counts.roundTrips++;
    const parser = new PgFrontendCounter(false);
    parser.feed(message);
    counts.parses += parser.counts.parses;
    counts.messages += parser.counts.messages;
    return original(message, ...rest);
  };
  return { read: () => ({ ...counts }), close: async () => { delete raw.execProtocolRawSync; } };
}

/** Loopback counting proxy in front of a Postgres URL (round trips = Sync + simple Query messages). */
async function pgCountingProxy(target: string): Promise<Counter & { url: string }> {
  const upstream = new URL(target);
  const counters: PgFrontendCounter[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(client => {
    const counter = new PgFrontendCounter();
    counters.push(counter);
    const up = net.connect(Number(upstream.port || 5432), upstream.hostname);
    sockets.add(client); sockets.add(up);
    client.on('data', (chunk: Buffer) => { counter.feed(chunk); up.write(chunk); });
    up.on('data', chunk => client.write(chunk));
    const end = () => { client.destroy(); up.destroy(); sockets.delete(client); sockets.delete(up); };
    client.on('close', end); up.on('close', end); client.on('error', end); up.on('error', end);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const proxied = new URL(target);
  proxied.hostname = '127.0.0.1';
  proxied.port = String((server.address() as net.AddressInfo).port);
  return {
    url: proxied.toString(),
    read: () => counters.reduce<WireCounts>((s, c) => ({ roundTrips: s.roundTrips + c.counts.roundTrips, parses: s.parses + c.counts.parses, messages: s.messages + c.counts.messages }), { roundTrips: 0, parses: 0, messages: 0 }),
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>(done => server.close(() => done())); },
  };
}

// ---------------------------------------------------------------------------
// Child: one pass
// ---------------------------------------------------------------------------

interface CallRecord { op: string; params: Record<string, unknown>; federated: boolean; source_id?: string; response: NormalizedResponse; round_trips: number; ms: number }
interface PassRecord { name: string; calls: CallRecord[]; side_effects: { counts: Record<string, number>; logs: Record<string, unknown[]> }; provider_calls: typeof providerCalls }

async function dispatchOpts(federated: boolean, sourceId = 'default') {
  const { getBrainHotMemoryMeta } = await import('../../src/core/facts/meta-hook.ts');
  return {
    remote: true, admissionOrigin: 'interactive' as const, transport: 'stdio' as const, takesHoldersAllowList: ['world'],
    sourceId, ...(federated ? { localFederatedSourceIds: ['default', 'other'] } : {}),
    metaHook: getBrainHotMemoryMeta, surface: 'full' as const,
  };
}

/** Rewrites rtt into the target URL: a toxiproxy in front of the clone when --rtt-ms > 0. */
async function maybeDelay(m: TemplateManifest, target: string, rttMs: number): Promise<{ url: string; stop: () => void }> {
  if (m.engine !== 'postgres' || rttMs <= 0) return { url: target, stop: () => {} };
  const { startHarness } = await import('./managed-sync-catchup-lib.ts');
  const proxyPort = 20000 + Math.floor(Math.random() * 20000);
  const harness = await withRealFetch(async () => {
    const h = await startHarness({ pgPort: 0, proxyPort, apiPort: Number(process.env.GBRAIN_PARITY_TOXI_API ?? 8474), adminUrl: m.admin_url, keep: true });
    await h.setRtt(rttMs);
    return h;
  });
  return { url: harness.proxyUrl(new URL(target).pathname.slice(1)), stop: () => { void withRealFetch(() => harness.stop()); } };
}

async function runPassChild(): Promise<void> {
  const m = readManifest(arg('--template')!);
  const pass = passes().find(p => p.name === arg('--pass'))!;
  const iterations = Number(arg('--iterations') ?? 1);
  const rttMs = Number(arg('--rtt-ms') ?? 0);
  await installStubs();
  const clone = await restoreClone(m);
  const delayed = await maybeDelay(m, clone.target, rttMs);
  const counting = m.engine === 'postgres' ? await pgCountingProxy(delayed.url) : null;
  let engine: BrainEngine | null = null;
  try {
    engine = await openEngine(m, counting?.url ?? clone.target);
    await engine.executeRaw(`UPDATE sources SET created_at = '2026-01-01T00:00:00Z'`);
    for (const [k, v] of Object.entries(pass.config ?? {})) await engine.setConfig(k, v);
    if (flag('--perturb')) await engine.executeRaw(`DELETE FROM facts WHERE id = (SELECT min(id) FROM facts WHERE fact LIKE 'Renewals were delayed%')`);
    const counter: Counter = counting ?? pgliteCounter(engine);
    const { dispatchToolCall } = await import('../../src/mcp/dispatch.ts');
    const answerIds = new Map<string, string>();
    const records: CallRecord[] = [];
    const timings: number[][] = pass.calls.map(() => []);
    for (let it = 0; it < iterations; it++) {
      for (const [i, call] of pass.calls.entries()) {
        const opts = await dispatchOpts(call.federated === true, call.sourceId);
        const c0 = counter.read();
        const t0 = performance.now();
        const result = await dispatchToolCall(engine, call.op, { ...call.params }, opts as never);
        const ms = performance.now() - t0;
        const trips = counter.read().roundTrips - c0.roundTrips;
        timings[i]!.push(ms);
        if (it === 0) records.push({ op: call.op, params: call.params, federated: call.federated === true, ...(call.sourceId ? { source_id: call.sourceId } : {}), response: normalizeResponse(result as never, answerIds), round_trips: trips, ms });
      }
    }
    if (iterations > 1) for (const [i, r] of records.entries()) r.ms = summarize(timings[i]!.slice(1)).median;
    const side = await writeSideEffects(engine, answerIds);
    const out: PassRecord = { name: pass.name, calls: records, side_effects: side, provider_calls: { ...providerCalls } };
    writeFileSync(arg('--result')!, JSON.stringify(out));
  } finally {
    await engine?.disconnect().catch(() => undefined);
    await counting?.close();
    delayed.stop();
    await clone.drop();
  }
}

/** Runs one child (a fresh process) and reads its result file. */
function runChild(args: string[]): unknown {
  const result = join(mkdtempSync(join(tmpdir(), 'gbrain-parity-result-')), 'result.json');
  const r = spawnSync(process.execPath, [import.meta.path, ...args, '--result', result], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env,
  });
  if (r.status !== 0 || !existsSync(result)) throw new Error(`parity: child ${args.join(' ')} failed (exit ${r.status})\n${(r.stderr ?? '').slice(-4000)}`);
  const out = JSON.parse(readFileSync(result, 'utf8'));
  rmSync(resolve(result, '..'), { recursive: true, force: true });
  return out;
}

function spawnPass(template: string, pass: string, extra: string[]): PassRecord {
  return runChild(['child', '--template', template, '--pass', pass, ...extra]) as PassRecord;
}

async function capture(latency: boolean): Promise<void> {
  const template = resolve(arg('--template')!);
  const out = resolve(arg('--out')!);
  const m = readManifest(template);
  const extra = [
    ...(flag('--perturb') ? ['--perturb'] : []),
    ...(latency ? ['--iterations', String(Number(arg('--iterations') ?? 5) + 1), '--rtt-ms', arg('--rtt-ms') ?? '0'] : []),
  ];
  const only = arg('--passes')?.split(',');
  const receipt = {
    kind: latency ? 'latency' : 'parity', tree: gitHead(), engine: m.engine, template_built_by: m.built_by,
    rtt_ms: latency ? Number(arg('--rtt-ms') ?? 0) : 0,
    passes: passes().filter(p => !only || only.includes(p.name)).map(p => spawnPass(template, p.name, extra)),
  };
  writeFileSync(out, JSON.stringify(receipt, null, 1));
  const calls = receipt.passes.reduce((n, p) => n + p.calls.length, 0);
  console.log(`${receipt.kind}: ${out} (${receipt.passes.length} passes, ${calls} calls, tree ${receipt.tree})`);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface Difference { path: string; base: unknown; branch: unknown; note?: string }

const isScoreKey = (k: string) => /(^|_)(score|cosine|similarity|relevance)$|^score_/.test(k);
const tolFor = (k: string) => (/cosine|similarity/.test(k) ? COSINE_TOLERANCE : SCORE_TOLERANCE);

function rowKey(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.slug !== 'string') return null;
  return JSON.stringify([r.source_id ?? null, r.slug, r.chunk_index ?? r.chunk_id ?? null, r.id ?? null]);
}
const rowScore = (v: unknown) => { const s = (v as Record<string, unknown>)?.score; return typeof s === 'number' ? s : null; };

/** Base rows grouped into runs whose consecutive scores are within tolerance (the only order that may change). */
function tieGroups(rows: unknown[]): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    const a = rowScore(rows[i - 1]); const b = i < rows.length ? rowScore(rows[i]) : null;
    if (i === rows.length || a === null || b === null || Math.abs(a - b) > SCORE_TOLERANCE) { groups.push([start, i]); start = i; }
  }
  return groups;
}

/** A printed score that moved by one unit in its last printed digit: a raw value near a rounding boundary, reported and listed rather than failed. */
export const ROUNDING_FLIP = 'rounding flip in the last printed digit';
const decimals = (n: number) => { const t = String(n); const at = t.indexOf('.'); return at < 0 || t.includes('e') ? 0 : t.length - at - 1; };

export function diff(base: unknown, branch: unknown, path = '$', out: Difference[] = [], key = ''): Difference[] {
  if (typeof base === 'number' && typeof branch === 'number' && isScoreKey(key)) {
    if (Math.abs(base - branch) <= tolFor(key) || (Number.isNaN(base) && Number.isNaN(branch))) return out;
    const places = Math.max(decimals(base), decimals(branch));
    const roundingFlip = places > 0 && places <= 4 && Math.abs(Math.abs(base - branch) - 10 ** -places) < 1e-12;
    out.push({ path, base, branch, note: roundingFlip ? ROUNDING_FLIP : `|Δ| ${Math.abs(base - branch)} > ${tolFor(key)}` });
    return out;
  }
  if (Array.isArray(base) && Array.isArray(branch)) {
    if (base.length !== branch.length) { out.push({ path: `${path}.length`, base: base.length, branch: branch.length }); return out; }
    if (base.length > 1 && base.every(r => rowKey(r) !== null) && branch.every(r => rowKey(r) !== null)) {
      const byKey = new Map(branch.map(r => [rowKey(r)!, r]));
      for (const [s, e] of tieGroups(base)) {
        const want = new Set(base.slice(s, e).map(r => rowKey(r)!));
        const got = new Set(branch.slice(s, e).map(r => rowKey(r)!));
        const same = want.size === got.size && [...want].every(k => got.has(k));
        if (!same) { out.push({ path: `${path}[${s}..${e - 1}]`, base: [...want], branch: [...got], note: 'rows moved outside a tolerance-equal score run' }); continue; }
        for (let i = s; i < e; i++) diff(base[i], byKey.get(rowKey(base[i])!), `${path}[${i}]`, out);
      }
      return out;
    }
    base.forEach((v, i) => diff(v, branch[i], `${path}[${i}]`, out));
    return out;
  }
  if (base && branch && typeof base === 'object' && typeof branch === 'object') {
    const keys = new Set([...Object.keys(base as object), ...Object.keys(branch as object)]);
    for (const k of keys) {
      const a = (base as Record<string, unknown>)[k]; const b = (branch as Record<string, unknown>)[k];
      if (!(k in (base as object))) out.push({ path: `${path}.${k}`, base: undefined, branch: b, note: 'added' });
      else if (!(k in (branch as object))) out.push({ path: `${path}.${k}`, base: a, branch: undefined, note: 'removed' });
      else diff(a, b, `${path}.${k}`, out, k);
    }
    return out;
  }
  if (typeof base === 'string' && typeof branch === 'string' && base !== branch) {
    const parsedA = parseMaybeJson(base); const parsedB = parseMaybeJson(branch);
    if (typeof parsedA !== 'string' && typeof parsedB !== 'string') return diff(parsedA, parsedB, path, out, key);
  }
  if (!Object.is(base, branch) && JSON.stringify(base) !== JSON.stringify(branch)) out.push({ path, base, branch });
  return out;
}

type Receipt = { kind: string; tree: string; engine: string; template_built_by: string; rtt_ms: number; passes: PassRecord[] };

export function compareReceipts(a: Receipt, b: Receipt) {
  const failures: Difference[] = [];
  const roundingFlips: Difference[] = [];
  const disclosures: Array<{ pass: string; call: number; base: string[]; branch: string[] }> = [];
  const statements: Array<{ pass: string; call: number; op: string; query: unknown; base: number; branch: number }> = [];
  const latency: Array<{ pass: string; call: number; op: string; query: unknown; base_ms: number; branch_ms: number }> = [];
  const sideEffects: Difference[] = [];
  for (const pa of a.passes) {
    const pb = b.passes.find(p => p.name === pa.name);
    if (!pb) { failures.push({ path: `pass ${pa.name}`, base: 'present', branch: 'missing' }); continue; }
    if (pa.calls.length !== pb.calls.length) { failures.push({ path: `pass ${pa.name}.calls`, base: pa.calls.length, branch: pb.calls.length }); continue; }
    pa.calls.forEach((ca, i) => {
      const cb = pb.calls[i]!;
      const where = `${pa.name}[${i}] ${ca.op} ${JSON.stringify(ca.params)}${ca.federated ? ' federated' : ''}${ca.source_id ? ` source ${ca.source_id}` : ''}`;
      for (const d of diff({ blocks: ca.response.blocks, meta: ca.response.meta, is_error: ca.response.is_error },
        { blocks: cb.response.blocks, meta: cb.response.meta, is_error: cb.response.is_error })) (d.note === ROUNDING_FLIP ? roundingFlips : failures).push({ ...d, path: `${where} ${d.path}` });
      if (JSON.stringify(ca.response.disclosures) !== JSON.stringify(cb.response.disclosures)) disclosures.push({ pass: pa.name, call: i, base: ca.response.disclosures, branch: cb.response.disclosures });
      if (ca.round_trips !== cb.round_trips) statements.push({ pass: pa.name, call: i, op: ca.op, query: ca.params.query, base: ca.round_trips, branch: cb.round_trips });
      latency.push({ pass: pa.name, call: i, op: ca.op, query: ca.params.query, base_ms: ca.ms, branch_ms: cb.ms });
    });
    sideEffects.push(...diff(pa.side_effects.counts, pb.side_effects.counts, `${pa.name}.counts`));
    for (const t of new Set([...Object.keys(pa.side_effects.logs), ...Object.keys(pb.side_effects.logs)])) {
      const ra = (pa.side_effects.logs[t] ?? []).map(r => JSON.stringify(r));
      const rb = (pb.side_effects.logs[t] ?? []).map(r => JSON.stringify(r));
      const onlyA = ra.filter(r => !rb.includes(r)); const onlyB = rb.filter(r => !ra.includes(r));
      if (onlyA.length || onlyB.length || ra.length !== rb.length) sideEffects.push({ path: `${pa.name}.logs.${t}`, base: onlyA.slice(0, 5), branch: onlyB.slice(0, 5), note: `${ra.length} vs ${rb.length} rows, ${onlyA.length}/${onlyB.length} unmatched` });
    }
  }
  const trips = (r: Receipt) => r.passes.reduce((n, p) => n + p.calls.reduce((m, c) => m + c.round_trips, 0), 0);
  return { ok: failures.length === 0 && sideEffects.length === 0, failures, rounding_flips: roundingFlips, side_effects: sideEffects, disclosures, statements, latency,
    totals: { base_round_trips: trips(a), branch_round_trips: trips(b) } };
}

function compareCommand(): void {
  const [aPath, bPath] = process.argv.slice(3).filter(x => !x.startsWith('--'));
  const a = JSON.parse(readFileSync(aPath!, 'utf8')) as Receipt;
  const b = JSON.parse(readFileSync(bPath!, 'utf8')) as Receipt;
  const r = compareReceipts(a, b);
  if (flag('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 1); }
  console.log(`base ${a.tree} vs branch ${b.tree} (${a.engine}, template ${a.template_built_by})`);
  console.log(`parity: ${r.ok ? 'CLEAN' : `${r.failures.length} response differences, ${r.side_effects.length} side-effect differences`}`);
  for (const d of r.failures.slice(0, 40)) console.log(`  DIFF ${d.path}${d.note ? ` (${d.note})` : ''}\n    base:   ${JSON.stringify(d.base)?.slice(0, 400)}\n    branch: ${JSON.stringify(d.branch)?.slice(0, 400)}`);
  for (const d of r.side_effects.slice(0, 20)) console.log(`  SIDE ${d.path}: ${JSON.stringify(d.base)?.slice(0, 200)} -> ${JSON.stringify(d.branch)?.slice(0, 200)}`);
  if (r.rounding_flips.length) console.log(`rounding flips (listed, not failed; the item must show raw values within tolerance): ${r.rounding_flips.length}\n${r.rounding_flips.slice(0, 20).map(d => `  FLIP ${d.path}: ${d.base} -> ${d.branch}`).join('\n')}`);
  if (r.disclosures.length) console.log(`disclosures differ on ${r.disclosures.length} calls (reported, not failed); first: ${JSON.stringify(r.disclosures[0]).slice(0, 600)}`);
  console.log(`statement round trips: base ${r.totals.base_round_trips}, branch ${r.totals.branch_round_trips}; ${r.statements.length} calls changed`);
  for (const s of r.statements.slice(0, 20)) console.log(`  ${s.pass}[${s.call}] ${s.op} ${JSON.stringify(s.query)}: ${s.base} -> ${s.branch}`);
  if (a.kind === 'latency' && b.kind === 'latency') {
    const sum = (k: 'base_ms' | 'branch_ms') => r.latency.reduce((n, l) => n + l[k], 0);
    console.log(`latency (median per call, rtt ${a.rtt_ms} ms): base total ${sum('base_ms').toFixed(1)} ms, branch total ${sum('branch_ms').toFixed(1)} ms`);
  }
  process.exit(r.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Pool contention (Postgres)
// ---------------------------------------------------------------------------

async function contentionChild(): Promise<void> {
  const m = readManifest(arg('--template')!);
  if (m.engine !== 'postgres') throw new Error('parity: contention needs a postgres template');
  const pool = Number(arg('--pool'));
  const searches = Number(arg('--searches') ?? 8);
  const rounds = Number(arg('--rounds') ?? 5);
  await installStubs();
  const clone = await restoreClone(m);
  const delayed = await maybeDelay(m, clone.target, Number(arg('--rtt-ms') ?? 0));
  let engine: BrainEngine | null = null;
  try {
    engine = await openEngine(m, delayed.url, pool);
    const { dispatchToolCall } = await import('../../src/mcp/dispatch.ts');
    const opts = await dispatchOpts(false);
    const queries = passes()[0]!.calls.filter(c => c.op === 'search').map(c => c.params);
    const samples: number[] = []; let errors = 0; let writes = 0;
    const t0 = performance.now();
    for (let round = 0; round < rounds; round++) {
      const writer = (async () => {
        await engine!.putPage('bench/contention-write', { type: 'note', title: 'Contention write', compiled_truth: `round ${round}` });
        writes++;
      })().catch(() => { errors++; });
      await Promise.all([writer, ...Array.from({ length: searches }, async (_, i) => {
        const s = performance.now();
        const r = await dispatchToolCall(engine!, 'search', { ...queries[(round * searches + i) % queries.length]! }, opts as never).catch(() => null);
        if (!r || r.isError) errors++;
        samples.push(performance.now() - s);
      })]);
    }
    const wall = (performance.now() - t0) / 1000;
    const sorted = [...samples].sort((x, y) => x - y);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    writeFileSync(arg('--result')!, JSON.stringify({ pool, searches, rounds, p50_ms: q(0.5), p95_ms: q(0.95), errors, writes, throughput_per_s: samples.length / wall }));
  } finally {
    await engine?.disconnect().catch(() => undefined);
    delayed.stop();
    await clone.drop();
  }
}

function contention(): void {
  const template = resolve(arg('--template')!);
  const pools = (arg('--pools') ?? '2,6').split(',').map(Number);
  const rows = pools.map(pool => runChild(['contention-child', '--template', template, '--pool', String(pool),
    '--searches', arg('--searches') ?? '8', '--rounds', arg('--rounds') ?? '5', '--rtt-ms', arg('--rtt-ms') ?? '0']) as {
    pool: number; p50_ms: number; p95_ms: number; errors: number; throughput_per_s: number });
  const receipt = { kind: 'contention', tree: gitHead(), rows };
  writeFileSync(resolve(arg('--out')!), JSON.stringify(receipt, null, 1));
  for (const row of rows) console.log(`pool ${row.pool}: p50 ${row.p50_ms.toFixed(1)} ms, p95 ${row.p95_ms.toFixed(1)} ms, errors ${row.errors}, ${row.throughput_per_s.toFixed(1)} searches/s`);
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'child' || cmd === 'contention-child') {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-child-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    isolateProcess(home);
    try { await (cmd === 'child' ? runPassChild() : contentionChild()); } finally { rmSync(home, { recursive: true, force: true }); }
    process.exit(0);
  }
  if (cmd === 'template') await buildTemplate();
  else if (cmd === 'capture') await capture(false);
  else if (cmd === 'latency') await capture(true);
  else if (cmd === 'compare') compareCommand();
  else if (cmd === 'contention') contention();
  else { console.error('usage: contract-parity.ts template|capture|latency|compare|contention (see header)'); process.exit(2); }
  process.exit(0);
}
