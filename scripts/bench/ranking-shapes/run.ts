#!/usr/bin/env bun
/**
 * Ranking-shape bench runner (GBRA-154 retrieval ranking wave).
 *
 * Builds a fresh PGLite brain in a temp GBRAIN_HOME (never ~/.gbrain) from the
 * synthetic fixture at test/fixtures/ranking-shapes, then runs every question
 * through search, query and query --expand via the CLI of the checkout given by
 * --repo, scores the results and writes results.json + summary.md.
 *
 * Usage:
 *   bun scripts/bench/ranking-shapes/run.ts --out /tmp/rs-master [--repo /path/to/checkout]
 *     [--fixtures dir] [--cache-dir ~/.cache/gbrain-ranking-shapes] [--limit 20]
 *     [--variants search,query,query-expand] [--max-questions N] [--home dir] [--keep-home]
 *     [--fast] [--embedding-model openai:text-embedding-3-large] [--config key=value,key=value]
 *
 * Network calls (embeddings, query expansion LLM, reranker) go through a local
 * caching proxy so reruns are free and deterministic: embeddings are cached per
 * input text (keyed by sha256 of model + dimensions + text), other provider calls
 * per request body. Cached entries remember the upstream latency and the proxy
 * replays it, so wall times stay realistic; --fast skips the replay.
 *
 * --config applies 'foresights config set key value' after init (for example search.reranker.enabled=false to score without the reranker).
 *
 * --home reuses an already-built brain (skips init/sync/embed) so scoring changes
 * can be iterated without a rebuild. The brain schema belongs to the checkout that
 * built it: use a separate home per checkout.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCRIPT_ROOT = resolve(import.meta.dir, '../../..');

// ---------------------------------------------------------------- CLI args

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true;
    else { o[key] = next; i++; }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const REPO = resolve(String(args.repo ?? SCRIPT_ROOT));
const FIXTURES = resolve(String(args.fixtures ?? join(SCRIPT_ROOT, 'test/fixtures/ranking-shapes')));
const OUT = resolve(String(args.out ?? 'ranking-shapes-out'));
const CACHE = resolve(String(args['cache-dir'] ?? join(homedir(), '.cache/gbrain-ranking-shapes')));
const LIMIT = Number(args.limit ?? 20);
const EMBEDDING_MODEL = String(args['embedding-model'] ?? 'openai:text-embedding-3-large');
const VARIANTS = String(args.variants ?? 'search,query,query-expand').split(',') as Variant[];
const MAX_Q = Number(args['max-questions'] ?? 0);
const FAST = args.fast === true;
const KEEP_HOME = args['keep-home'] === true;
const CONFIG_SETS = typeof args.config === 'string' ? String(args.config).split(',').filter(Boolean) : [];

type Variant = 'search' | 'query' | 'query-expand';
const VARIANT_ARGS: Record<Variant, string[]> = { search: ['search'], query: ['query'], 'query-expand': ['query', '--expand'] };

interface Ref { source_id: string; slug: string }
interface Q { id: string; shape: string; question: string; target: Ref; also_ok: Ref[]; related?: Array<Ref & { role: string }>; notes?: string }

const log = (m: string) => process.stderr.write('[ranking-shapes] ' + m + '\n');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- caching proxy

const UPSTREAM: Record<string, string> = { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com', voyage: 'https://api.voyageai.com' };
const PRICE = { embedPerTok: 0.13 / 1e6, voyagePerTok: 0.02 / 1e6, anthropicIn: 1 / 1e6, anthropicOut: 5 / 1e6 };

function startProxy(cacheDir: string) {
  mkdirSync(cacheDir, { recursive: true });
  const embFile = join(cacheDir, 'embeddings.jsonl');
  const respFile = join(cacheDir, 'responses.jsonl');
  const emb = new Map<string, { v: number[]; ms: number }>();
  const resp = new Map<string, { status: number; ct: string; body: string; ms: number }>();
  const load = (file: string, fn: (o: any) => void) => {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) { try { fn(JSON.parse(line)); } catch { /* torn line */ } }
  };
  load(embFile, o => emb.set(o.k, { v: o.v, ms: o.ms }));
  load(respFile, o => resp.set(o.k, { status: o.status, ct: o.ct, body: o.body, ms: o.ms }));
  const stats: Record<string, { calls: number; hits: number; misses: number; inTok: number; outTok: number; usd: number }> = {};
  const st = (p: string) => (stats[p] ??= { calls: 0, hits: 0, misses: 0, inTok: 0, outTok: 0, usd: 0 });
  let replay = false;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const forwardHeaders = (req: Request) => {
    const h = new Headers();
    for (const [k, v] of req.headers) if (!['host', 'content-length', 'accept-encoding', 'connection'].includes(k.toLowerCase())) h.set(k, v);
    return h;
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/(openai|anthropic|voyage)(\/.*)$/);
      if (!m) return new Response('unknown route', { status: 404 });
      const provider = m[1]!;
      const path = m[2]!;
      const upstream = UPSTREAM[provider]! + path + url.search;
      const bodyText = req.method === 'GET' ? '' : await req.text();
      const s = st(provider);
      s.calls++;

      if (provider === 'openai' && path.endsWith('/embeddings') && req.method === 'POST') {
        const body = JSON.parse(bodyText);
        const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
        const keys = inputs.map(t => sha(JSON.stringify([body.model, body.dimensions ?? null, t])));
        const missIdx = keys.map((k, i) => (emb.has(k) ? -1 : i)).filter(i => i >= 0);
        let tokens = 0;
        if (missIdx.length) {
          const t0 = Date.now();
          const r = await fetch(upstream, { method: 'POST', headers: forwardHeaders(req), body: JSON.stringify({ ...body, input: missIdx.map(i => inputs[i]), encoding_format: 'float' }) });
          if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
          const j = await r.json() as any;
          const ms = Date.now() - t0;
          tokens = j.usage?.prompt_tokens ?? 0;
          for (const d of j.data) {
            const i = missIdx[d.index]!;
            emb.set(keys[i]!, { v: d.embedding, ms });
            appendFileSync(embFile, JSON.stringify({ k: keys[i], v: d.embedding, ms }) + '\n');
          }
          s.misses++;
          s.inTok += tokens;
          s.usd += tokens * PRICE.embedPerTok;
        } else {
          s.hits++;
          if (replay) await sleep(Math.max(...keys.map(k => emb.get(k)!.ms)));
        }
        const b64 = body.encoding_format === 'base64';
        const data = keys.map((k, i) => {
          const v = emb.get(k)!.v;
          return { object: 'embedding', index: i, embedding: b64 ? Buffer.from(new Float32Array(v).buffer).toString('base64') : v };
        });
        return Response.json({ object: 'list', data, model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens } });
      }

      const key = sha(JSON.stringify([req.method, path, bodyText]));
      const hit = resp.get(key);
      if (hit) {
        s.hits++;
        if (replay) await sleep(hit.ms);
        return new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.ct } });
      }
      const t0 = Date.now();
      const r = await fetch(upstream, { method: req.method, headers: forwardHeaders(req), body: req.method === 'GET' ? undefined : bodyText });
      const text = await r.text();
      const ms = Date.now() - t0;
      const ct = r.headers.get('content-type') ?? 'application/json';
      s.misses++;
      const inTok = Number(text.match(/"(?:input_tokens|prompt_tokens)":\s*(\d+)/)?.[1] ?? 0);
      const outTok = Number(text.match(/"(?:output_tokens|completion_tokens)":\s*(\d+)/)?.[1] ?? 0);
      const totalTok = Number(text.match(/"total_tokens":\s*(\d+)/)?.[1] ?? 0);
      if (provider === 'anthropic') { s.inTok += inTok; s.outTok += outTok; s.usd += inTok * PRICE.anthropicIn + outTok * PRICE.anthropicOut; }
      else if (provider === 'voyage') { s.inTok += totalTok; s.usd += totalTok * PRICE.voyagePerTok; }
      if (r.status === 200) {
        resp.set(key, { status: 200, ct, body: text, ms });
        appendFileSync(respFile, JSON.stringify({ k: key, status: 200, ct, body: text, ms }) + '\n');
      }
      return new Response(text, { status: r.status, headers: { 'content-type': ct } });
    },
  });
  return {
    port: server.port,
    stats,
    setReplay: (v: boolean) => { replay = v; },
    stop: () => server.stop(true),
    totalUsd: () => Object.values(stats).reduce((a, s) => a + s.usd, 0),
  };
}

// ---------------------------------------------------------------- CLI runner

interface Ran { code: number; stdout: string; stderr: string; ms: number }
let HOME = '';
let PROXY_PORT = 0;

async function cli(cliArgs: string[], extraEnv: Record<string, string> = {}, timeoutMs = 600_000): Promise<Ran> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GBRAIN_HOME: HOME,
    OPENAI_BASE_URL: 'http://127.0.0.1:' + PROXY_PORT + '/openai/v1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + PROXY_PORT + '/anthropic/v1',
    NO_COLOR: '1',
    ...extraEnv,
  };
  delete env.GBRAIN_CONTRIBUTOR_MODE;
  const t0 = performance.now();
  const p = Bun.spawn(['bun', 'run', join(REPO, 'src/cli.ts'), ...cliArgs], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, ms: Math.round(performance.now() - t0) };
}

function need(r: Ran, what: string): Ran {
  if (r.code !== 0) throw new Error(what + ' failed (exit ' + r.code + '):\n' + (r.stderr + r.stdout).slice(-2500));
  return r;
}

function git(cwd: string, ...a: string[]) {
  const r = Bun.spawnSync(['git', '-c', 'user.name=ranking-shapes-bench', '-c', 'user.email=bench@example.invalid', ...a], { cwd });
  if (r.exitCode !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr.toString());
}

// ---------------------------------------------------------------- brain build

async function buildBrain(workdir: string, proxy: ReturnType<typeof startProxy>) {
  const info: Record<string, unknown> = {};
  mkdirSync(HOME, { recursive: true });
  need(await cli(['init', '--pglite', '--embedding-model', EMBEDDING_MODEL, '--search-mode', 'balanced', '--non-interactive']), 'init');
  const cfgPath = join(HOME, '.gbrain/config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.provider_base_urls = { ...(cfg.provider_base_urls ?? {}), voyage: 'http://127.0.0.1:' + proxy.port + '/voyage/v1' };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  for (const kv of CONFIG_SETS) {
    const i = kv.indexOf('=');
    need(await cli(['config', 'set', kv.slice(0, i), kv.slice(i + 1)]), 'config set ' + kv);
  }
  const mig = await cli(['apply-migrations', '--yes', '--no-autopilot-install']);
  info.apply_migrations_exit = mig.code;

  for (const s of ['source-a', 'source-b']) {
    const dir = join(workdir, s);
    cpSync(join(FIXTURES, s), dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture');
    need(await cli(['sources', 'add', s, '--path', dir, '--federated']), 'sources add ' + s);
  }
  const t0 = Date.now();
  const sync = await cli(['sync', '--all', '--yes'], {}, 1_800_000);
  info.sync_exit = sync.code;
  info.sync_tail = (sync.stdout + sync.stderr).split('\n').filter(l => /imported|Links|held|Held|error|Error/i.test(l)).slice(-12);
  const emb = await cli(['embed', '--stale', '--yes'], {}, 1_800_000);
  info.embed_exit = emb.code;
  info.embed_tail = (emb.stdout + emb.stderr).split('\n').slice(-6);
  const links = await cli(['extract', 'links', '--source', 'db']);
  info.extract_links_exit = links.code;
  info.extract_links_tail = (links.stdout + links.stderr).split('\n').filter(Boolean).slice(-3);
  const emb2 = await cli(['embed', '--stale', '--yes']);
  info.embed2_exit = emb2.code;
  const list = await cli(['sources', 'list', '--json']);
  try { info.sources = JSON.parse(list.stdout).sources.map((s: any) => ({ id: s.id, pages: s.page_count, federated: s.federated })); } catch { info.sources = list.stdout.slice(0, 400); }
  const status = await cli(['sources', 'status', '--json']);
  info.status_raw = status.stdout.slice(0, 3000);
  info.build_ms = Date.now() - t0;
  return info;
}

// ---------------------------------------------------------------- scoring

interface Row { slug: string; source_id?: string; type?: string; score?: number; rerank_score?: number; chunk_text?: string; collapsed?: Array<{ slug: string; source_id?: string; reason?: string }> }
interface Compact { slug: string; source_id?: string; type?: string; score?: number; rerank_score?: number; chunk_len: number; collapsed: number }

function ranks(q: Q, rows: Row[]) {
  const T = q.target;
  const strict = rows.findIndex(r => r.slug === T.slug && r.source_id === T.source_id);
  const isTwin = (r: { slug: string; source_id?: string }) => r.slug === T.slug || q.also_ok.some(o => o.slug === r.slug && o.source_id === r.source_id);
  const twin = rows.findIndex(isTwin);
  const collapseHit = (r: Row) => (r.collapsed ?? []).some(c => c.slug === T.slug && (c.source_id === undefined || c.source_id === T.source_id || q.also_ok.some(o => o.source_id === c.source_id)));
  const collapse = rows.findIndex(r => isTwin(r) || collapseHit(r));
  return { strict, twin, collapse };
}

const dupSlots = (rows: Row[]) => {
  const top = rows.slice(0, 10);
  const seen = new Set<string>();
  let dups = 0;
  for (const r of top) { if (seen.has(r.slug)) dups++; seen.add(r.slug); }
  return { dups, slots: top.length };
};

function shapeChecks(q: Q, rows: Row[], rk: ReturnType<typeof ranks>) {
  const out: Record<string, boolean | number> = {};
  const top10 = rows.slice(0, 10);
  const d = dupSlots(rows);
  out.no_duplicate_slug_top10 = d.dups === 0;
  const rel = (role: string) => (q.related ?? []).filter(r => r.role === role);
  const idxOf = (slug: string) => rows.findIndex(r => r.slug === slug);
  if (q.shape === 'E2') {
    const stubIdx = Math.min(...rel('stub').map(s => idxOf(s.slug)).map(i => (i < 0 ? Infinity : i)));
    out.e2_target_above_stub = rk.collapse >= 0 && (stubIdx === Infinity || rk.collapse < stubIdx);
    out.e2_stub_rank = stubIdx === Infinity ? 0 : stubIdx + 1;
  }
  if (q.shape === 'E3') {
    const fam = new Set(rel('family').map(f => f.slug));
    const famTop5 = rows.slice(0, 5).filter(r => fam.has(r.slug)).length;
    out.e3_family_in_top5 = famTop5;
    out.e3_target_rank1 = rk.collapse === 0;
    out.e3_pass = rk.collapse === 0 && famTop5 <= 1;
  }
  if (q.shape === 'E4') {
    out.e4_company_rank1 = rk.collapse === 0;
    const f = rel('founder')[0];
    const fi = f ? idxOf(f.slug) : -1;
    out.e4_founder_above_company = fi >= 0 && (rk.collapse < 0 || fi < rk.collapse);
  }
  if (q.shape === 'E9') {
    out.e9_person_rank1 = rk.collapse === 0;
    out.e9_images_in_top5 = rows.slice(0, 5).filter(r => r.type === 'image' || /\.(jpg|png)$/.test(r.slug)).length;
  }
  if (q.shape === 'E11') {
    out.e11_target_rank1 = rk.collapse === 0;
    const s = rel('undated-stub')[0];
    const si = s ? idxOf(s.slug) : -1;
    out.e11_stub_above_target = si >= 0 && (rk.collapse < 0 || si < rk.collapse);
  }
  const maxChunk = Math.max(0, ...top10.map(r => (r.chunk_text ?? '').length));
  out.max_chunk_chars_top10 = maxChunk;
  out.e13_chunk_under_8k = maxChunk < 8000;
  const scores = rows.map(r => r.score).filter((s): s is number => typeof s === 'number');
  let mono = true;
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[i - 1]!) mono = false;
  out.e12_score_monotonic = mono;
  return out;
}

function parseRows(stdout: string): Row[] | null {
  const t = stdout.trim();
  for (const cand of [t, t.slice(Math.max(0, t.indexOf('\n[') + 1))]) {
    try { const v = JSON.parse(cand); if (Array.isArray(v)) return v; } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------- main

const t00 = Date.now();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const questions: Q[] = readFileSync(join(FIXTURES, 'questions.jsonl'), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const qs = MAX_Q ? questions.slice(0, MAX_Q) : questions;

const proxy = startProxy(CACHE);
PROXY_PORT = Number(proxy.port);
const tmpRoot = mkdtempSync(join(tmpdir(), 'ranking-shapes-'));
const reuse = typeof args.home === 'string';
HOME = reuse ? resolve(String(args.home)) : join(tmpRoot, 'home');
if (HOME === join(homedir())) throw new Error('refusing to use the real home as GBRAIN_HOME');

const version = (await cli(['--version'])).stdout.trim();
const commit = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: REPO }).stdout.toString().trim();
log('repo ' + REPO + ' (' + version + ', ' + commit + '); home ' + HOME + '; ' + qs.length + ' questions x ' + VARIANTS.length + ' variants');

let build: Record<string, unknown> = { reused_home: reuse };
if (!reuse) {
  proxy.setReplay(false);
  log('building brain (init, sync, embed)...');
  build = await buildBrain(tmpRoot, proxy);
  log('build done in ' + build.build_ms + 'ms; sources: ' + JSON.stringify(build.sources));
}
const buildUsd = proxy.totalUsd();
proxy.setReplay(!FAST);

interface Result {
  id: string; shape: string; variant: Variant; question: string; wall_ms: number; exit: number; n: number;
  strict_rank: number | null; twin_rank: number | null; collapse_rank: number | null;
  checks: Record<string, boolean | number>; dup_slots: number; slots: number;
  expansion_applied: boolean | null; llm_calls: Array<{ kind: string; operation?: string; model?: string; in?: number; out?: number }>; llm_in: number; llm_out: number; reranker_ran: boolean | null;
  top: Compact[]; error?: string; has_collapsed_field: boolean;
}
const results: Result[] = [];
const logDir = join(tmpRoot, 'calllogs');
mkdirSync(logDir, { recursive: true });

let done = 0;
for (const q of qs) {
  for (const v of VARIANTS) {
    const callLog = join(logDir, q.id + '-' + v + '.jsonl');
    const r = await cli([...VARIANT_ARGS[v], q.question, '--json', '--limit', String(LIMIT)], { GBRAIN_AI_CALL_LOG: callLog });
    const rows = parseRows(r.stdout);
    const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const llm = calls.filter((c: any) => c.kind === 'chat' || c.kind === 'expansion');
    const expCall = llm.length > 0;
    const res: Result = {
      id: q.id, shape: q.shape, variant: v, question: q.question, wall_ms: r.ms, exit: r.code, n: rows?.length ?? 0,
      strict_rank: null, twin_rank: null, collapse_rank: null, checks: {}, dup_slots: 0, slots: 0,
      expansion_applied: calls.length || existsSync(callLog) ? expCall : null,
      llm_calls: calls.map((c: any) => ({ kind: c.kind, operation: c.operation, model: c.model, in: typeof c.input_tokens === 'number' ? c.input_tokens : undefined, out: typeof c.output_tokens === 'number' ? c.output_tokens : undefined })),
      llm_in: llm.reduce((a: number, c: any) => a + (typeof c.input_tokens === 'number' ? c.input_tokens : 0), 0),
      llm_out: llm.reduce((a: number, c: any) => a + (typeof c.output_tokens === 'number' ? c.output_tokens : 0), 0),
      reranker_ran: calls.length ? calls.some((c: any) => c.kind === 'reranker' || c.kind === 'rerank') : null,
      top: [], has_collapsed_field: false,
    };
    if (!rows) {
      res.error = (r.stderr + r.stdout).slice(-600);
    } else {
      const rk = ranks(q, rows);
      res.strict_rank = rk.strict >= 0 ? rk.strict + 1 : null;
      res.twin_rank = rk.twin >= 0 ? rk.twin + 1 : null;
      res.collapse_rank = rk.collapse >= 0 ? rk.collapse + 1 : null;
      res.checks = shapeChecks(q, rows, rk);
      const d = dupSlots(rows);
      res.dup_slots = d.dups; res.slots = d.slots;
      res.has_collapsed_field = rows.some(x => Array.isArray(x.collapsed));
      res.top = rows.map(x => ({ slug: x.slug, source_id: x.source_id, type: x.type, score: x.score, rerank_score: x.rerank_score, chunk_len: (x.chunk_text ?? '').length, collapsed: x.collapsed?.length ?? 0 }));
    }
    results.push(res);
  }
  done++;
  if (done % 5 === 0) log(done + '/' + qs.length + ' questions');
}
proxy.stop();

// ---------------------------------------------------------------- aggregate

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const f1 = (x: number) => x.toFixed(3);
function agg(rs: Result[], key: 'strict_rank' | 'twin_rank' | 'collapse_rank') {
  const n = rs.length;
  const hit = (k: number) => pct(rs.filter(r => r[key] !== null && r[key]! <= k).length, n);
  const mrr = n ? rs.reduce((a, r) => a + (r[key] ? 1 / r[key]! : 0), 0) / n : 0;
  return { n, hit1: hit(1), hit5: hit(5), hit10: hit(10), hit20: hit(20), mrr: +mrr.toFixed(3) };
}
function passRate(rs: Result[], pred: (r: Result) => boolean | undefined) {
  const applicable = rs.filter(r => pred(r) !== undefined);
  return { pass: applicable.filter(r => pred(r) === true).length, n: applicable.length };
}
const SHAPES = ['E1', 'E2', 'E3', 'E4', 'E9', 'E11', 'E13', 'E15'];
const summary: Record<string, any> = {};
for (const v of VARIANTS) {
  const rs = results.filter(r => r.variant === v);
  const by = (s: string) => rs.filter(r => r.shape === s);
  const known = rs.filter(r => r.shape === 'E15' || r.shape === 'E1');
  const s: Record<string, any> = {
    all: { strict: agg(rs, 'strict_rank'), twin: agg(rs, 'twin_rank'), collapse: agg(rs, 'collapse_rank') },
    e15_paraphrased: { strict: agg(known, 'strict_rank'), twin: agg(known, 'twin_rank'), collapse: agg(known, 'collapse_rank') },
    by_shape_hit1_twin: Object.fromEntries(SHAPES.map(sh => [sh, { n: by(sh).length, hit1: agg(by(sh), 'twin_rank').hit1, hit10: agg(by(sh), 'twin_rank').hit10 }])),
    pass: {
      E1_no_dup_slug_top10: passRate(by('E1'), r => r.checks.no_duplicate_slug_top10 as boolean),
      E1_all_questions: passRate(rs, r => r.checks.no_duplicate_slug_top10 as boolean),
      E2_target_above_stub: passRate(by('E2'), r => r.checks.e2_target_above_stub as boolean),
      E3_target1_family_le1: passRate(by('E3'), r => r.checks.e3_pass as boolean),
      E4_company_rank1: passRate(by('E4'), r => r.checks.e4_company_rank1 as boolean),
      E9_person_rank1: passRate(by('E9'), r => r.checks.e9_person_rank1 as boolean),
      E11_dated_rank1: passRate(by('E11'), r => r.checks.e11_target_rank1 as boolean),
      E12_score_monotonic_all: passRate(rs, r => r.checks.e12_score_monotonic as boolean),
      E13_chunk_under_8k: passRate(by('E13'), r => r.checks.e13_chunk_under_8k as boolean),
    },
    e13_max_chunk_chars: Math.max(0, ...by('E13').map(r => Number(r.checks.max_chunk_chars_top10 ?? 0))),
    max_chunk_chars_any: Math.max(0, ...rs.map(r => Number(r.checks.max_chunk_chars_top10 ?? 0))),
    dup_slot_rate: pct(rs.reduce((a, r) => a + r.dup_slots, 0), rs.reduce((a, r) => a + r.slots, 0)),
    wall_ms: { mean: Math.round(rs.reduce((a, r) => a + r.wall_ms, 0) / Math.max(1, rs.length)), p50: [...rs].map(r => r.wall_ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] ?? 0 },
    errors: rs.filter(r => r.error).length,
    collapsed_field_present_rate: pct(rs.filter(r => r.has_collapsed_field).length, rs.length),
    expansion_applied: passRate(rs, r => (r.expansion_applied === null ? undefined : r.expansion_applied)),
    reranker_ran: passRate(rs, r => (r.reranker_ran === null ? undefined : r.reranker_ran)),
    llm_tokens: { in: rs.reduce((a, r) => a + r.llm_in, 0), out: rs.reduce((a, r) => a + r.llm_out, 0) },
  };
  summary[v] = s;
}
// pairwise identity: does the variant return the same ordered slug list as search / query?
const key = (id: string, v: Variant) => results.find(r => r.id === id && r.variant === v);
const identical: Record<string, any> = {};
for (const [a, b] of [['search', 'query'], ['search', 'query-expand'], ['query', 'query-expand']] as Array<[Variant, Variant]>) {
  if (!VARIANTS.includes(a) || !VARIANTS.includes(b)) continue;
  let same10 = 0, same20 = 0, n = 0;
  for (const q of qs) {
    const x = key(q.id, a), y = key(q.id, b);
    if (!x || !y || x.error || y.error) continue;
    n++;
    if (x.top.slice(0, 10).map(t => t.slug + '@' + t.source_id).join('|') === y.top.slice(0, 10).map(t => t.slug + '@' + t.source_id).join('|')) same10++;
    if (x.top.map(t => t.slug + '@' + t.source_id).join('|') === y.top.map(t => t.slug + '@' + t.source_id).join('|')) same20++;
  }
  identical[a + ' vs ' + b] = { n, identical_top10: same10, identical_top20: same20 };
}
const expansion: Record<string, any> = {};
if (VARIANTS.includes('query-expand')) {
  const ex = results.filter(r => r.variant === 'query-expand');
  const deltas = (base: Variant) => ex.map(r => { const b = key(r.id, base); return b ? r.wall_ms - b.wall_ms : null; }).filter((x): x is number => x !== null);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  expansion.applied = passRate(ex, r => (r.expansion_applied === null ? undefined : r.expansion_applied));
  expansion.mean_latency_delta_ms_vs_query = mean(deltas('query'));
  expansion.mean_latency_delta_ms_vs_search = mean(deltas('search'));
  expansion.llm_tokens_in = ex.reduce((a, r) => a + r.llm_in, 0);
  expansion.llm_tokens_out = ex.reduce((a, r) => a + r.llm_out, 0);
  const qv = results.filter(r => r.variant === 'query');
  expansion.query_default_expansion_applied = passRate(qv, r => (r.expansion_applied === null ? undefined : r.expansion_applied));
}

const meta = {
  repo: REPO, version, commit, fixtures: FIXTURES, home: KEEP_HOME || reuse ? HOME : '(temp, deleted)', started: new Date(t00).toISOString(), elapsed_s: Math.round((Date.now() - t00) / 1000),
  questions: qs.length, variants: VARIANTS, limit: LIMIT, embedding_model: EMBEDDING_MODEL, search_mode: 'balanced (init --search-mode)', config_overrides: CONFIG_SETS, build,
  api: { build_usd_est: +buildUsd.toFixed(4), total_usd_est: +proxy.totalUsd().toFixed(4), by_provider: proxy.stats, note: 'estimates: embeddings 0.13 USD/M tokens, voyage rerank 0.02 USD/M, anthropic assumed 1 USD/M in and 5 USD/M out; cache hits cost 0' },
};
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ meta, summary, identical, expansion, results }, null, 1));

// ---------------------------------------------------------------- markdown

const tick = String.fromCharCode(96);
const L: string[] = [];
L.push('# Ranking-shape bench: ' + version + ' @ ' + commit, '');
L.push('Questions: ' + qs.length + ' (' + SHAPES.map(s => s + ' ' + qs.filter(q => q.shape === s).length).join(', ') + '). Fixture pages: see manifest. Search mode: balanced. Limit ' + LIMIT + '. Elapsed ' + meta.elapsed_s + 's. API spend (est): ' + meta.api.total_usd_est + ' USD.', '');
const hdr = (cols: string[]) => '| ' + cols.join(' | ') + ' |\n|' + cols.map((_, i) => (i ? '---:' : '---')).join('|') + '|';
for (const [title, getter] of [
  ['All questions (' + qs.length + ')', (s: any) => s.all],
  ['E15: paraphrased known-item (shapes E15 + E1)', (s: any) => s.e15_paraphrased],
] as Array<[string, (s: any) => any]>) {
  L.push('## ' + title, '', hdr(['variant', 'match', 'n', 'hit@1', 'hit@5', 'hit@10', 'hit@20', 'MRR']));
  for (const v of VARIANTS) for (const m of ['strict', 'twin', 'collapse']) {
    const a = getter(summary[v])[m];
    L.push('| ' + v + ' | ' + m + ' | ' + a.n + ' | ' + a.hit1 + '% | ' + a.hit5 + '% | ' + a.hit10 + '% | ' + a.hit20 + '% | ' + a.mrr + ' |');
  }
  L.push('');
}
L.push('## Per-shape pass rates (target identified collapse-aware)', '');
L.push(hdr(['check', ...VARIANTS]));
const passKeys = Object.keys(summary[VARIANTS[0]!].pass);
const label: Record<string, string> = {
  E1_no_dup_slug_top10: 'E1 no slug twice in top 10 (E1 rows)', E1_all_questions: 'E1 no slug twice in top 10 (all rows)', E2_target_above_stub: 'E2 target above stub', E3_target1_family_le1: 'E3 target rank 1 and family <=1 of top 5',
  E4_company_rank1: 'E4 company rank 1', E9_person_rank1: 'E9 person rank 1', E11_dated_rank1: 'E11 dated page rank 1', E12_score_monotonic_all: 'E12 score non-increasing (all rows)', E13_chunk_under_8k: 'E13 max chunk < 8k chars (E13 rows)',
};
for (const k of passKeys) L.push('| ' + label[k] + ' | ' + VARIANTS.map(v => { const p = summary[v].pass[k]; return p.pass + '/' + p.n + ' (' + pct(p.pass, p.n) + '%)'; }).join(' | ') + ' |');
L.push('');
L.push('## Other metrics', '', hdr(['metric', ...VARIANTS]));
L.push('| duplicate-slot rate (top 10) | ' + VARIANTS.map(v => summary[v].dup_slot_rate + '%').join(' | ') + ' |');
L.push('| max chunk_text chars, E13 rows | ' + VARIANTS.map(v => summary[v].e13_max_chunk_chars).join(' | ') + ' |');
L.push('| max chunk_text chars, any row | ' + VARIANTS.map(v => summary[v].max_chunk_chars_any).join(' | ') + ' |');
L.push('| mean wall ms per call | ' + VARIANTS.map(v => summary[v].wall_ms.mean).join(' | ') + ' |');
L.push('| p50 wall ms | ' + VARIANTS.map(v => summary[v].wall_ms.p50).join(' | ') + ' |');
L.push('| reranker call seen | ' + VARIANTS.map(v => { const p = summary[v].reranker_ran; return p.pass + '/' + p.n; }).join(' | ') + ' |');
L.push('| expansion call seen | ' + VARIANTS.map(v => { const p = summary[v].expansion_applied; return p.pass + '/' + p.n; }).join(' | ') + ' |');
L.push('| rows carrying a ' + tick + 'collapsed' + tick + ' field | ' + VARIANTS.map(v => summary[v].collapsed_field_present_rate + '%').join(' | ') + ' |');
L.push('| CLI errors | ' + VARIANTS.map(v => summary[v].errors).join(' | ') + ' |', '');
L.push('## Hit@1 / hit@10 by shape (twin-aware)', '', hdr(['shape', 'n', ...VARIANTS]));
for (const sh of SHAPES) L.push('| ' + sh + ' | ' + qs.filter(q => q.shape === sh).length + ' | ' + VARIANTS.map(v => { const b = summary[v].by_shape_hit1_twin[sh]; return b.hit1 + '% / ' + b.hit10 + '%'; }).join(' | ') + ' |');
L.push('');
L.push('## Do the variants return the same list?', '');
for (const [k, o] of Object.entries(identical)) L.push('- ' + k + ': identical top 10 on ' + (o as any).identical_top10 + '/' + (o as any).n + ', identical top 20 on ' + (o as any).identical_top20 + '/' + (o as any).n);
L.push('');
if (VARIANTS.includes('query-expand')) {
  L.push('## Expansion cost', '');
  L.push('- expansion LLM call seen on ' + expansion.applied.pass + '/' + expansion.applied.n + ' query --expand calls; on ' + expansion.query_default_expansion_applied.pass + '/' + expansion.query_default_expansion_applied.n + ' plain query calls');
  L.push('- mean latency delta of query --expand vs query: ' + expansion.mean_latency_delta_ms_vs_query + ' ms; vs search: ' + expansion.mean_latency_delta_ms_vs_search + ' ms');
  L.push('- expansion LLM (chat) tokens on query --expand: ' + expansion.llm_tokens_in + ' in / ' + expansion.llm_tokens_out + ' out');
  L.push('');
}
L.push('## Build and spend', '');
L.push('- build: ' + JSON.stringify(build.sources ?? build) + '; build wall ' + (build.build_ms ?? 'n/a') + ' ms');
for (const [p, s] of Object.entries(proxy.stats)) L.push('- ' + p + ': ' + s.calls + ' calls (' + s.hits + ' cache hits, ' + s.misses + ' forwarded), ' + s.inTok + ' in / ' + s.outTok + ' out tokens, ~' + s.usd.toFixed(4) + ' USD');
L.push('- total API spend this run (est): ' + meta.api.total_usd_est + ' USD (' + meta.api.note + ')');
writeFileSync(join(OUT, 'summary.md'), L.join('\n') + '\n');
console.log(L.join('\n'));

if (!KEEP_HOME && !reuse) rmSync(tmpRoot, { recursive: true, force: true });
else log('kept ' + tmpRoot);
process.exit(0);
