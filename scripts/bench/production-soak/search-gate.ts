#!/usr/bin/env bun
/**
 * Production soak, search speed gate: on a loaded soak brain (--work with
 * ready.json), after the soak, measure warm search the way a remote caller sees
 * it and decide whether the release may reach stable.
 *
 *   bun scripts/bench/production-soak/search-gate.ts --fixture ~/soak/fixture --work ~/soak/work --out ~/soak/out \
 *     [--rtt-ms 2] [--n 60] [--warmup 5] [--embed-ms 200] [--rerank-ms 300] [--parked 9400] [--mode block|record]
 *     [--baseline <search-gate.json> | --baseline-repo owner/name] [--override "<reason>"] [--repo <gbrain checkout>]
 *
 * 1. Leaves the brain in the state an upgraded brain carries: --parked pages
 *    become image pages whose v153 activation rebuild sits queued for an
 *    operator (reason protocol_activation, projection unsealed), the rows the
 *    resident drain never clears. A fresh soak load never has them, which is
 *    why the soak missed the warm-search regression of v0.60.723 to 759.
 *    The step writes the database directly and mutates the brain: run it last.
 * 2. For Postgres JIT on and then off (ALTER SYSTEM, reloaded and confirmed
 *    with SHOW jit over the transaction lane), a fresh stdio gbrain serve runs
 *    --warmup then --n searches from a fixed query list at --rtt-ms.
 * 3. Judges each arm: p50 under 2 s and p95 under 3 s (BAR_MS), no failed call, and no
 *    regression against the last release that passed this gate (REGRESSION).
 *    An arm that fails is measured once more on a fresh server and keeps the
 *    better of its two readings, so one noisy reading cannot fail a release.
 *
 * Writes <out>/search-gate.json, search-gate.md and search-gate-calls.jsonl,
 * and adds search_gate_jit_on / search_gate_jit_off to <out>/scoreboard.json,
 * which the daily stable check requires to pass in the 2 ms cell. Exits 1 when
 * --mode block and the gate fails without --override; 2 when the harness breaks.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres from '#postgres';
import { startMockProviders } from '../retrieval-scale/mock-providers.ts';
import { McpClient, spawnChild } from '../sync-freshness-lib.ts';
import { childEnv, gb, pct, REPO, startTopology, writeConfig } from './lib.ts';

/** Fixed bars: warm search p50 under 2 s and p95 under 3 s (on good builds the p95 tail sits near 2 s, from the title arm on four-word queries). */
export const BAR_MS = { p50: 2000, p95: 3000 } as const;
/** A metric regresses only when it is both REGRESSION.ratio times the baseline and min_ms above it. */
export const REGRESSION = { ratio: 1.5, p50_min_ms: 250, p95_min_ms: 400 } as const;
export const GATE_IDS = { on: 'search_gate_jit_on', off: 'search_gate_jit_off' } as const;
export const DOCS = 'docs/RELEASING.md#search-speed-gate';
/** The fixture size a release soak runs (SOAK_SHAPE.pages in scripts/stable-daily.ts); the regression check compares only soaks of this size. */
export const RELEASE_PAGES = 600_000;

export type Jit = 'on' | 'off';
export interface Call { ms: number; error?: string; timings?: { stages_ms?: Record<string, number>; parts_ms?: Record<string, Record<string, number>> } }
export interface Reading { n: number; errors: number; p50_ms: number | null; p95_ms: number | null; slowest: { part: string; p50_ms: number } | null; server_jit: string }
export interface Arm extends Reading { jit: Jit; readings: Reading[] }
export interface Config { fixture_pages: number; rtt_ms: number; n: number; warmup: number; embed_ms: number; rerank_ms: number; parked: number }
export interface Baseline { version: string; run_url: string | null; arms: Array<Pick<Arm, 'jit' | 'p50_ms' | 'p95_ms'>> }
export interface Check { arm: Jit; id: string; value: number | null; limit: number | null; pass: boolean; why: string }

/** p50, p95 and the slowest timed part (by its median) of one reading. */
export function summarize(calls: Call[], serverJit: string): Reading {
  const ok = calls.filter(c => !c.error).map(c => c.ms);
  const parts = new Map<string, number[]>();
  for (const c of calls) {
    for (const [stage, byPart] of Object.entries(c.timings?.parts_ms ?? {})) for (const [part, ms] of Object.entries(byPart ?? {})) if (typeof ms === 'number') parts.set(stage + '.' + part, [...(parts.get(stage + '.' + part) ?? []), ms]);
    for (const [stage, ms] of Object.entries(c.timings?.stages_ms ?? {})) if (typeof ms === 'number' && !c.timings?.parts_ms?.[stage]) parts.set(stage, [...(parts.get(stage) ?? []), ms]);
  }
  let slowest: Reading['slowest'] = null;
  for (const [part, xs] of parts) { const p50 = pct(xs, 50)!; if (!slowest || p50 > slowest.p50_ms) slowest = { part, p50_ms: p50 }; }
  return { n: calls.length, errors: calls.length - ok.length, p50_ms: pct(ok, 50), p95_ms: pct(ok, 95), slowest, server_jit: serverJit };
}

/** The better of an arm's readings, kept whole: the first that passes every check, else the one with the fewest failing checks. */
export function combine(jit: Jit, readings: Reading[], baseline: Baseline | null): Arm {
  const failing = (r: Reading) => checkArm({ jit, ...r }, baseline).filter(c => !c.pass).length;
  const best = readings.reduce((a, b) => (failing(b) < failing(a) ? b : a));
  return { jit, ...best, readings };
}

/** The arm's checks; unreadable names why the last release's result could not be read, which fails the arm until the check runs or is overridden. */
export function checkArm(arm: Pick<Arm, 'jit' | 'n' | 'errors' | 'p50_ms' | 'p95_ms' | 'server_jit'>, baseline: Baseline | null, unreadable?: string): Check[] {
  const checks: Check[] = [
    { arm: arm.jit, id: 'server_jit', value: null, limit: null, pass: arm.server_jit === arm.jit, why: 'Postgres reported jit = ' + arm.server_jit + ' for the JIT ' + arm.jit + ' arm' },
    { arm: arm.jit, id: 'errors', value: arm.errors, limit: 0, pass: arm.n > 0 && arm.errors === 0, why: arm.errors + ' of ' + arm.n + ' searches failed' },
    { arm: arm.jit, id: 'p50', value: arm.p50_ms, limit: BAR_MS.p50, pass: arm.p50_ms !== null && arm.p50_ms < BAR_MS.p50, why: 'p50 ' + ms(arm.p50_ms) + ', bar under ' + ms(BAR_MS.p50) },
    { arm: arm.jit, id: 'p95', value: arm.p95_ms, limit: BAR_MS.p95, pass: arm.p95_ms !== null && arm.p95_ms < BAR_MS.p95, why: 'p95 ' + ms(arm.p95_ms) + ', bar under ' + ms(BAR_MS.p95) },
  ];
  const base = baseline?.arms.find(a => a.jit === arm.jit);
  for (const [id, value, prior, floor] of [['p50_vs_last_release', arm.p50_ms, base?.p50_ms, REGRESSION.p50_min_ms], ['p95_vs_last_release', arm.p95_ms, base?.p95_ms, REGRESSION.p95_min_ms]] as const) {
    if (prior === null || prior === undefined || value === null) continue;
    const limit = Math.round(Math.max(prior * REGRESSION.ratio, prior + floor));
    checks.push({ arm: arm.jit, id, value, limit, pass: value <= limit, why: id.slice(0, 3) + ' ' + ms(value) + ' against ' + ms(prior) + ' on v' + baseline!.version + ' (limit ' + ms(limit) + ')' });
  }
  if (unreadable) checks.push({ arm: arm.jit, id: 'baseline', value: null, limit: null, pass: false, why: 'no regression check: ' + unreadable });
  return checks;
}

export function ms(x: number | null | undefined): string { return x === null || x === undefined ? 'no data' : Math.round(x).toLocaleString('en-US') + ' ms'; }

/** One plain failure message per failing arm, naming the numbers, the slowest part and what to do. */
export function failureMessage(arm: Arm, checks: Check[], rtt: number, pages: number | null, baseline: Baseline | null, held = true): string {
  const failed = checks.filter(c => c.arm === arm.jit && !c.pass);
  const slow = failed.filter(c => c.id !== 'baseline');
  const unread = failed.find(c => c.id === 'baseline');
  const where = 'the ' + (pages ? Math.round(pages / 1000) + 'k-page' : 'soak') + ' brain at ' + rtt + ' ms RTT with Postgres JIT ' + arm.jit;
  const prior = baseline?.arms.find(a => a.jit === arm.jit);
  return (slow.length ? 'Warm search is too slow on ' + where + ': ' + slow.map(c => c.why).join('; ') + '.' : 'Warm search on ' + where + ' could not be compared with the last release.')
    + (unread ? ' The regression check could not run: ' + unread.why.replace(/^no regression check: /, '') + '.' : '')
    + (prior && !failed.some(c => c.id.endsWith('_vs_last_release')) ? ' Last passing release v' + baseline!.version + ': p50 ' + ms(prior.p50_ms) + ', p95 ' + ms(prior.p95_ms) + '.' : '')
    + (arm.slowest ? ' Slowest timed part: ' + arm.slowest.part + ' at ' + ms(arm.slowest.p50_ms) + ' p50.' : '')
    + (!held ? ' Not blocking this run (record-only cell or overridden); details in search-gate.md.'
      : unread && !slow.length ? ' This release is held from stable until the check runs. If GitHub was down or rate-limited, re-dispatch the soak on this tag once it recovers; to release on the fixed bars alone, re-dispatch it with search_gate_override set to the reason (' + DOCS + ').'
      : ' This release is held from stable. Measured twice on fresh servers; details in search-gate.md. Known-noisy run: re-dispatch the soak on this tag with search_gate_override (' + DOCS + ').');
}

const cmpVersion = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; };

/** A release's search-gate.json serves as a baseline only when it passed without an override, on the same fixture size and probe shape. */
export function acceptBaseline(g: { pass?: unknown; override?: unknown; config?: unknown; arms?: Baseline['arms'] }, tag: string, url: string | null, config: Config): Baseline | null {
  if (g.pass !== true || g.override || JSON.stringify(g.config) !== JSON.stringify(config) || !Array.isArray(g.arms)) return null;
  return { version: tag.replace(/^v/, ''), run_url: url, arms: g.arms };
}

export type BaselineLookup = { baseline: Baseline | null; lookup: 'given' | 'found' | 'none' | 'failed'; detail?: string };

/** The newest earlier release whose soak passed this gate with the same probe shape, from its run's artifact. */
function findBaseline(repo: string, version: string, config: Config): BaselineLookup {
  const gh = (args: string[]) => spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const list = gh(['api', 'repos/' + repo + '/actions/workflows/production-soak.yml/runs?status=success&per_page=100', '--jq', '.workflow_runs[] | [.id, .head_branch, .html_url] | @tsv']);
  if (list.status !== 0) return { baseline: null, lookup: 'failed', detail: 'GitHub could not list earlier soak runs (' + list.stderr.trim().split('\n').at(-1) + ')' };
  const runs = list.stdout.trim().split('\n').map(l => l.split('\t')).filter(r => /^v\d+(\.\d+){3}$/.test(r[1] ?? '') && cmpVersion(r[1]!.slice(1), version) < 0)
    .sort((a, b) => cmpVersion(b[1]!.slice(1), a[1]!.slice(1)));
  const unreadable: string[] = [];
  for (const [id, tag, url] of runs.slice(0, 6)) {
    const dir = mkdtempSync(join(tmpdir(), 'search-gate-'));
    try {
      const dl = gh(['run', 'download', id!, '-R', repo, '-n', 'production-soak-rtt' + config.rtt_ms, '-D', dir]);
      if (dl.status !== 0) { if (!/no (valid )?artifacts? (found|match)/i.test(dl.stderr)) unreadable.push(tag + ' download failed (' + dl.stderr.trim().split('\n').at(-1) + ')'); continue; }
      const file = join(dir, 'search-gate.json');
      if (!existsSync(file)) continue;
      let g: Parameters<typeof acceptBaseline>[0];
      try { g = JSON.parse(readFileSync(file, 'utf8')); } catch { unreadable.push(tag + ' search-gate.json is not valid JSON'); continue; }
      const baseline = acceptBaseline(g, tag!, url ?? null, config);
      if (baseline) return { baseline, lookup: 'found' };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return missingBaseline(unreadable, config);
}

/** No baseline found: 'failed' when an earlier release's result could not be read or this soak is not release-size, so the check cannot be skipped silently; else 'none'. */
export function missingBaseline(unreadable: string[], config: Config): BaselineLookup {
  if (unreadable.length) return { baseline: null, lookup: 'failed', detail: 'the result of ' + unreadable.length + ' earlier release(s) could not be read: ' + unreadable.join('; ') };
  if (config.fixture_pages !== RELEASE_PAGES) return { baseline: null, lookup: 'failed', detail: 'no earlier release passed this gate on a ' + config.fixture_pages.toLocaleString('en-US') + '-page fixture, and releases are compared on ' + RELEASE_PAGES.toLocaleString('en-US') + ' pages' };
  return { baseline: null, lookup: 'none' };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback = '') => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1]! : fallback; };
  const FIXTURE = resolve(flag('fixture')), WORK = resolve(flag('work')), OUT = resolve(flag('out')), CHECKOUT = resolve(flag('repo', REPO));
  const mode = flag('mode', 'block') as 'block' | 'record', override = flag('override').trim();
  if (!['block', 'record'].includes(mode)) throw new Error('--mode must be block or record');
  const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
  const config: Config = { fixture_pages: Number(manifest.options?.pages ?? manifest.pages), rtt_ms: Number(flag('rtt-ms', '2')), n: Number(flag('n', '60')), warmup: Number(flag('warmup', '5')), embed_ms: Number(flag('embed-ms', '200')), rerank_ms: Number(flag('rerank-ms', '300')), parked: Number(flag('parked', '9400')) };
  const ready = JSON.parse(readFileSync(join(WORK, 'ready.json'), 'utf8'));
  const HOME = join(WORK, 'home'), CLI = join(CHECKOUT, 'src', 'cli.ts');
  const version = readFileSync(join(CHECKOUT, 'VERSION'), 'utf8').trim();

  const topo = await startTopology(WORK, undefined, undefined, true);
  await topo.setRtt(0);
  const admin = postgres(topo.direct(ready.db), { max: 1, onnotice: () => {} });
  const rows = await admin.unsafe("SELECT p.id, p.title, left(c.chunk_text, 600) AS text FROM pages p JOIN content_chunks c ON c.page_id = p.id AND c.chunk_index = 0 WHERE p.deleted_at IS NULL AND p.page_kind = 'markdown' AND p.frontmatter->>'visibility' IS NULL AND p.frontmatter->>'access' IS NULL AND p.frontmatter->>'confidentiality' IS NULL AND p.type <> 'chat' ORDER BY md5(p.source_id || ':' || p.slug) LIMIT 200") as Array<{ id: number; title: string; text: string }>;
  const queries = rows.map((r, i) => {
    const words = r.text.replace(/[^a-z\s]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
    const k = 2 + (i % 3), at = (i * 7919) % Math.max(1, words.length - k);
    return [i % 3 === 0 ? r.title.split(/\s+/).slice(0, 2).join(' ') : '', ...words.slice(at, at + k)].filter(Boolean).join(' ') || r.title;
  });
  // The residue a brain upgraded across v153 keeps (page-state/projection-schema.ts PAGE_PROJECTION_ACTIVATION_SQL): an image page's projection unsealed and its rebuild queued, which only an operator clears.
  const parked = await admin.begin(async sql => {
    await sql.unsafe('SET LOCAL session_replication_role = replica');
    const [have] = await sql.unsafe("SELECT count(*)::int AS n FROM page_projection_jobs j JOIN sources s ON s.incarnation = j.source_incarnation JOIN pages p ON p.source_id = s.id AND p.slug = j.slug WHERE j.reason = 'protocol_activation' AND p.page_kind = 'image'") as Array<{ n: number }>;
    const want = Math.max(0, config.parked - have!.n);
    if (want > 0) {
      await sql.unsafe("UPDATE pages p SET page_kind = 'image', knowledge_revision = COALESCE(p.knowledge_revision, gen_random_uuid()), text_projection_revision = NULL, embedding_signature = NULL FROM (SELECT p.id FROM pages p JOIN sources s ON s.id = p.source_id WHERE p.deleted_at IS NULL AND NOT s.archived AND p.page_kind = 'markdown' AND p.body_storage IS DISTINCT FROM 'segmented' AND p.frontmatter->>'visibility' IS NULL AND p.id <> ALL($1::int[]) ORDER BY md5('parked:' || p.source_id || ':' || p.slug) LIMIT $2) x WHERE p.id = x.id", [rows.map(r => r.id), want]);
      await sql.unsafe("INSERT INTO page_projection_jobs(source_incarnation, slug, revision, reason) SELECT s.incarnation, p.slug, p.knowledge_revision, 'protocol_activation' FROM pages p JOIN sources s ON s.id = p.source_id WHERE p.deleted_at IS NULL AND p.page_kind = 'image' AND p.text_projection_revision IS NULL ON CONFLICT (source_incarnation, slug) DO UPDATE SET revision = EXCLUDED.revision, reason = EXCLUDED.reason, updated_at = now()");
    }
    const [n] = await sql.unsafe("SELECT count(*)::int AS n FROM page_projection_jobs j JOIN sources s ON s.incarnation = j.source_incarnation JOIN pages p ON p.source_id = s.id AND p.slug = j.slug WHERE j.reason = 'protocol_activation' AND p.page_kind = 'image'") as Array<{ n: number }>;
    return n!.n;
  });
  await admin.unsafe('ANALYZE pages, page_projection_jobs');
  console.error('[search-gate] ' + parked + ' activation rows parked on image pages; ' + queries.length + ' queries');

  await topo.setRtt(config.rtt_ms);
  const mock = startMockProviders({ manifest: { seed: manifest.options.seed, chunks: manifest.pages * 4, pages: manifest.pages, dims: 1536 }, embedMs: config.embed_ms, rerankMs: config.rerank_ms });
  writeConfig(HOME, topo.txn(ready.db), mock.url);
  const env = childEnv(HOME, mock.url, { GBRAIN_DIRECT_DATABASE_URL: topo.session(ready.db) });
  const gbrainVersion = (await gb(CLI, HOME, env, ['--version'], { allowFail: true })).stdout.trim();
  const txn = postgres(topo.txn(ready.db), { max: 1, onnotice: () => {}, prepare: false });
  const callsFile = join(OUT, 'search-gate-calls.jsonl');
  rmSync(callsFile, { force: true });

  const measure = async (jit: Jit, attempt: number): Promise<Reading> => {
    await admin.unsafe('ALTER SYSTEM SET jit = ' + jit);
    await admin.unsafe('SELECT pg_reload_conf()');
    await new Promise(r => setTimeout(r, 1500));
    const [{ jit: serverJit }] = await txn.unsafe('SHOW jit') as Array<{ jit: string }>;
    const child = spawnChild([process.execPath, CLI, 'serve'], { cwd: HOME, env, logFile: join(OUT, 'search-gate-serve.log'), stdin: true });
    const client = new McpClient(child);
    const calls: Call[] = [];
    try {
      await client.init();
      for (let i = 0; i < config.warmup + config.n; i++) {
        const query = queries[i % queries.length]!;
        const t0 = performance.now();
        const r = await client.request('tools/call', { name: 'search', arguments: { query } }, 120_000).catch(e => ({ error: String(e) } as { result?: any; error?: any }));
        const call: Call = { ms: Math.round(performance.now() - t0), error: r.error || r.result?.isError ? String(JSON.stringify(r.error ?? r.result?.content)).slice(0, 300) : undefined, timings: r.result?._meta?.retrieval?.timings };
        if (i < config.warmup) continue;
        calls.push(call);
        appendFileSync(callsFile, JSON.stringify({ jit, attempt, i, query_words: query.split(' ').length, ...call }) + '\n');
      }
    } finally { child.kill(); }
    return summarize(calls, serverJit);
  };

  const lookup: BaselineLookup = flag('baseline') ? (() => { const g = JSON.parse(readFileSync(resolve(flag('baseline')), 'utf8')); return { baseline: { version: String(g.version), run_url: g.run_url ?? null, arms: g.arms }, lookup: 'given' as const }; })()
    : flag('baseline-repo') ? findBaseline(flag('baseline-repo'), version, config) : { baseline: null, lookup: 'none' };
  const baseline = lookup.baseline;
  const arms: Arm[] = [];
  const checks: Check[] = [];
  try {
    for (const jit of ['on', 'off'] as const) {
      const first = await measure(jit, 1);
      const readings = checkArm({ jit, ...first }, baseline).every(c => c.pass) ? [first] : [first, await measure(jit, 2)];
      const arm = combine(jit, readings, baseline);
      arms.push(arm);
      checks.push(...checkArm(arm, baseline, lookup.lookup === 'failed' ? lookup.detail : undefined));
      console.error('[search-gate] JIT ' + jit + ': p50 ' + ms(arm.p50_ms) + ', p95 ' + ms(arm.p95_ms) + ', errors ' + arm.errors + ' over ' + readings.length + ' reading(s)');
    }
  } finally {
    await admin.unsafe('ALTER SYSTEM RESET jit');
    await admin.unsafe('SELECT pg_reload_conf()');
    await txn.end();
    await admin.end();
    mock.stop();
  }

  const pass = checks.every(c => c.pass);
  const pages = ready.counts?.pages ?? null;
  const result = { schema: 'gbrain-production-soak-search-gate/1', version, gbrain_version: gbrainVersion, rev: spawnSync('git', ['-C', CHECKOUT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null,
    pages, config, parked_rows: parked, bar_ms: BAR_MS, regression: REGRESSION, baseline, baseline_lookup: lookup.lookup, arms, checks, mode, override: override ? { reason: override, actor: process.env.GITHUB_ACTOR ?? null } : null, pass };
  writeFileSync(join(OUT, 'search-gate.json'), JSON.stringify(result, null, 2) + '\n');
  const md = ['## Search speed gate (' + config.rtt_ms + ' ms RTT, ' + mode + ')', '',
    'v' + version + ' on ' + (pages ?? '?') + ' pages with ' + parked + ' upgrade rows parked on image pages; ' + config.n + ' warm MCP searches per reading (mock embed ' + config.embed_ms + ' ms, rerank ' + config.rerank_ms + ' ms). Bars: p50 under ' + ms(BAR_MS.p50) + ', p95 under ' + ms(BAR_MS.p95) + (baseline ? '; against v' + baseline.version : (lookup.lookup === 'failed' ? '; the last release\'s result could not be read (' + lookup.detail + '), so no regression check' : '; no earlier release passed this gate with this fixture and probe, so no regression check')) + '.', '',
    '| JIT | p50 | p95 | errors | readings | slowest part |', '|---|---|---|---|---|---|',
    ...arms.map(a => '| ' + a.jit + ' | ' + ms(a.p50_ms) + ' | ' + ms(a.p95_ms) + ' | ' + a.errors + ' | ' + a.readings.length + ' | ' + (a.slowest ? a.slowest.part + ' ' + ms(a.slowest.p50_ms) : '-') + ' |'), '',
    pass ? '**Pass.**' : '**Fail**: ' + checks.filter(c => !c.pass).map(c => 'JIT ' + c.arm + ' ' + c.why).join('; ') + '.', ...(override ? ['', 'Overridden by ' + (process.env.GITHUB_ACTOR ?? 'an operator') + ': ' + override] : []), ''].join('\n');
  writeFileSync(join(OUT, 'search-gate.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  const boardFile = join(OUT, 'scoreboard.json');
  if (existsSync(boardFile)) {
    const board = JSON.parse(readFileSync(boardFile, 'utf8'));
    board.gates = [...(board.gates ?? []).filter((g: { id: string }) => !Object.values(GATE_IDS).includes(g.id as never)),
      ...arms.map(a => { const ok = checks.filter(c => c.arm === a.jit).every(c => c.pass); return { id: GATE_IDS[a.jit], metric: 'search_gate.jit_' + a.jit, op: '==', threshold: true, mode, why: 'warm search p50 under 2 s and p95 under 3 s with JIT ' + a.jit + ', and no regression against the last release', value: ok, pass: ok || !!override, ...(override && !ok ? { overridden: override } : {}) }; })];
    board.search_gate = result;
    writeFileSync(boardFile, JSON.stringify(board, null, 2));
  }
  console.log(md);
  if (pass) return 0;
  for (const a of arms) if (checks.some(c => c.arm === a.jit && !c.pass)) console.log((mode === 'block' && !override ? '::error title=Search speed gate::' : '::warning title=Search speed gate (' + (override ? 'overridden' : 'record only') + ')::') + failureMessage(a, checks, config.rtt_ms, pages, baseline, mode === 'block' && !override));
  if (override) console.log('::warning title=Search speed gate overridden::' + (process.env.GITHUB_ACTOR ?? 'An operator') + ' overrode a failing gate: ' + override);
  return mode === 'block' && !override ? 1 : 0;
}

if (import.meta.main) {
  try { process.exit(await main()); } catch (e) { console.error('[search-gate] harness error: ' + (e instanceof Error ? e.stack : String(e))); process.exit(2); }
}
