/**
 * Production-shaped scale soak, step 4: turn a soak's events.jsonl into the
 * scoreboard (GBRA-174). Pure functions: buildScoreboard(events) and
 * renderScoreboard(board); soak.ts writes both at the end of a run, and
 *   bun scripts/bench/production-soak/scoreboard.ts <events.jsonl> [--json]
 * rebuilds them from a saved run.
 *
 * Every gate starts in "record" mode: it is computed and printed, and never
 * fails a run. Moving a gate to "block" is a reviewed edit of GATES, decided
 * by the release owner after two consecutive clean weekly soaks show the threshold is
 * stable.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pct } from './lib.ts';

export type Ev = Record<string, any> & { t: number; kind: string };
export interface Gate { id: string; metric: string; op: '<=' | '>=' | '=='; threshold: number | boolean; mode: 'record' | 'block'; why: string }

/** Initial thresholds come from the stabilization plan and the agent wishlist; all record-only. */
export const GATES: Gate[] = [
  { id: 'freshness_p95', metric: 'freshness.lag_p95_s', op: '<=', threshold: 900, mode: 'record', why: 'commit -> searchable p95 under 15 minutes' },
  { id: 'freshness_unresolved', metric: 'freshness.unresolved', op: '<=', threshold: 0, mode: 'record', why: 'every committed change becomes searchable before the run ends' },
  { id: 'freshness_not_frozen', metric: 'freshness.frozen_by_hold', op: '==', threshold: false, mode: 'record', why: 'a held item never freezes the source watermark' },
  { id: 'search_warm_p95', metric: 'reads.mcp.search.p95_ms', op: '<=', threshold: 2000, mode: 'record', why: 'warm search p95 under 2 s' },
  { id: 'search_cold_p50', metric: 'reads.cli.search.p50_ms', op: '<=', threshold: 3000, mode: 'record', why: 'cold CLI search p50 under 3 s' },
  { id: 'query_warm_p95', metric: 'reads.mcp.query.p95_ms', op: '<=', threshold: 3000, mode: 'record', why: 'warm query p95 under 3 s' },
  { id: 'query_cold_p50', metric: 'reads.cli.query.p50_ms', op: '<=', threshold: 4000, mode: 'record', why: 'cold CLI query p50 under 4 s' },
  { id: 'read_errors', metric: 'reads.error_rate', op: '<=', threshold: 0.01, mode: 'record', why: 'under 1% of reads fail' },
  { id: 'put_p95', metric: 'writes.put.p95_ms', op: '<=', threshold: 10_000, mode: 'record', why: 'put p95 under 10 s' },
  { id: 'remember_p95', metric: 'writes.remember.p95_ms', op: '<=', threshold: 10_000, mode: 'record', why: 'remember p95 under 10 s' },
  { id: 'write_errors', metric: 'writes.error_rate', op: '<=', threshold: 0.01, mode: 'record', why: 'under 1% of writes fail' },
  { id: 'session_pool_headroom', metric: 'pool.session_peak', op: '<=', threshold: 20, mode: 'record', why: 'session lane peak leaves 5 of 25 free' },
  { id: 'session_refusals', metric: 'pool.session_refusals', op: '<=', threshold: 0, mode: 'record', why: 'no EMAXCONNSESSION-shaped refusal' },
  { id: 'doctor_red', metric: 'doctor.red_end', op: '<=', threshold: 0, mode: 'record', why: 'doctor has no red check at the end' },
  { id: 'version_skew', metric: 'version.skew', op: '==', threshold: false, mode: 'record', why: 'every process runs one build' },
  { id: 'serve_rss', metric: 'memory.serve.peak_mb', op: '<=', threshold: 2048, mode: 'record', why: 'resident serve stays under 2 GiB' },
  { id: 'serve_growth', metric: 'memory.serve.growth_mb_per_h', op: '<=', threshold: 100, mode: 'record', why: 'resident serve grows under 100 MiB per hour' },
  { id: 'sync_jobs_progress', metric: 'sync_jobs.zero_progress', op: '<=', threshold: 0, mode: 'record', why: 'no managed sync job ends having applied nothing while the source is behind' },
  { id: 'residents_alive', metric: 'residents.exits', op: '<=', threshold: 0, mode: 'record', why: 'serve and the worker never exit' },
  { id: 'privacy_leaks', metric: 'privacy.leaks', op: '<=', threshold: 0, mode: 'record', why: 'no private or alias-private canary is readable by a remote caller' },
];

const stat = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : null });
const latency = (rows: Ev[]) => { const ok = rows.filter(r => r.ok); const s = stat(ok.map(r => r.ms)); const pending = rows.filter(r => r.outcome === 'pending').length; return { n: rows.length, errors: rows.length - ok.length - pending, pending, p50_ms: s.p50, p95_ms: s.p95, max_ms: s.max }; };
const r1 = (x: number | null) => x === null ? null : Math.round(x * 10) / 10;

export function buildScoreboard(events: Ev[]) {
  const start = events.find(e => e.kind === 'start');
  const end = events.find(e => e.kind === 'end');
  const of = (k: string) => events.filter(e => e.kind === k);
  const fresh = of('freshness'), unresolved = of('freshness_unresolved'), commits = of('commit'), status = of('status');
  const lags = fresh.map(e => e.lag_ms / 1000);
  // Watermark stall: the longest run of status samples where HEAD moved past sources.last_commit and last_commit did not change.
  let stall = 0, stallStart: number | null = null, stallCommit: string | null = null, holdsDuringStall = 0, maxStallHolds = 0;
  for (const s of status) {
    const behind = s.head && s.last_commit && s.head !== s.last_commit;
    if (behind && s.last_commit === stallCommit && stallStart !== null) { holdsDuringStall = Math.max(holdsDuringStall, s.holds ?? 0); if (s.at_s - stallStart > stall) { stall = s.at_s - stallStart; maxStallHolds = holdsDuringStall; } }
    else if (behind) { stallStart = s.at_s; stallCommit = s.last_commit; holdsDuringStall = s.holds ?? 0; }
    else { stallStart = null; stallCommit = null; holdsDuringStall = 0; }
  }
  const commitEvery = start?.config?.commit_every_s ?? 180;
  const frozen = stall > Math.max(1800, 4 * commitEvery) && maxStallHolds > 0;
  const firstProblem = commits.find(c => c.problem);
  const afterProblem = firstProblem ? commits.filter(c => c.n > firstProblem.n && !c.problem) : [];
  const resolvedAfter = afterProblem.filter(c => fresh.some(f => f.n === c.n)).length;
  const reads = of('read');
  const readsBy: Record<string, Record<string, ReturnType<typeof latency>>> = {};
  for (const surface of ['cli', 'mcp']) { readsBy[surface] = {}; for (const op of [...new Set(reads.filter(r => r.surface === surface).map(r => r.op))]) readsBy[surface]![op === 'get_page' ? 'get' : op] = latency(reads.filter(r => r.surface === surface && r.op === op)); }
  const writes = of('write');
  const writesBy: Record<string, ReturnType<typeof latency> & { by_surface: Record<string, ReturnType<typeof latency>> }> = {};
  for (const op of ['put', 'remember']) writesBy[op] = { ...latency(writes.filter(w => w.op === op)), by_surface: Object.fromEntries(['cli', 'mcp'].map(s => [s, latency(writes.filter(w => w.op === op && w.surface === s))])) };
  const samples = of('sample');
  const memFor = (name: string) => {
    const xs = samples.filter(s => s.mem?.[name]).map(s => ({ at: s.at_s, mb: s.mem[name].rss_mb, hwm: s.mem[name].hwm_mb }));
    if (!xs.length) return { peak_mb: null, end_mb: null, growth_mb_per_h: null };
    const warm = xs.filter(x => x.at >= 600), a = warm[0] ?? xs[0]!, b = xs[xs.length - 1]!;
    return { peak_mb: Math.max(...xs.map(x => Math.max(x.mb, x.hwm))), end_mb: b.mb, growth_mb_per_h: b.at > a.at ? Math.round(((b.mb - a.mb) / ((b.at - a.at) / 3600)) * 10) / 10 : null };
  };
  const doctors = of('doctor');
  const docEnd = doctors.find(d => d.at === 'end') ?? doctors[doctors.length - 1];
  const priv = of('privacy'), passive = of('privacy_passive');
  const leaks: Ev[] = [...priv.filter(p => p.leaked), ...passive.map(p => ({ ...p, class: 'passive' }))];
  const holds = status.map(s => s.holds ?? 0);
  const skewChecks = doctors.flatMap(d => [...(d.red ?? []).map((r: { name: string }) => r.name), ...(d.warn ?? [])]).filter((n: string) => /skew|build_drift|version/.test(n));
  const maint = of('maintenance');
  const board = {
    schema: 'gbrain-production-soak-scoreboard/1',
    label: start?.config?.label || null, gbrain_rev: start?.gbrain_rev ?? null, gbrain_version: start?.version ?? null, rtt_ms: start?.config?.rtt_ms ?? null,
    hours: start?.config?.hours ?? null, elapsed_s: end?.elapsed_s ?? null, config: start?.config ?? null, brain: start?.ready ?? null,
    freshness: {
      commits: commits.length, resolved: fresh.length, unresolved: unresolved.length, unresolved_max_age_s: unresolved.length ? Math.round(Math.max(...unresolved.map(u => u.age_ms)) / 1000) : 0,
      lag_p50_s: r1(pct(lags, 50)), lag_p95_s: r1(pct(lags, 95)), lag_max_s: r1(lags.length ? Math.max(...lags) : null), first_hit_p50_s: r1(pct(fresh.map(e => e.first_ms / 1000), 50)),
      writer_errors: of('writer_error').length, watermark_stall_max_s: stall, holds_during_stall: maxStallHolds, frozen_by_hold: frozen,
      after_first_hold_commit: firstProblem ? { commits: afterProblem.length, resolved: resolvedAfter } : null,
      gbrain_reported: status.length ? { c2s_p50_s: status[status.length - 1]!.gbrain_c2s_p50_s, c2s_p95_s: status[status.length - 1]!.gbrain_c2s_p95_s, behind_commits_end: status[status.length - 1]!.behind_commits } : null,
    },
    reads: { ...readsBy, error_rate: reads.length ? Math.round((reads.filter(r => !r.ok).length / reads.length) * 10_000) / 10_000 : null, errors_top: topErrors(reads) },
    writes: { ...writesBy, pending: writes.filter(w => w.outcome === 'pending').length, error_rate: writes.length ? Math.round((writes.filter(w => w.outcome === 'error' || (w.outcome === undefined && !w.ok)).length / writes.length) * 10_000) / 10_000 : null, errors_top: topErrors(writes) },
    pool: { session_peak: samples.length ? Math.max(...samples.map(s => s.session)) : null, session_active_peak: samples.length ? Math.max(...samples.map(s => s.session_active)) : null,
      txn_peak: samples.length ? Math.max(...samples.map(s => s.txn)) : null, backends_peak: samples.length ? Math.max(...samples.map(s => s.backends)) : null,
      session_refusals: end?.refused?.session ?? null, txn_refusals: end?.refused?.txn ?? null, log_hits: end?.log_hits ?? null },
    holds: { start: holds[0] ?? null, max: holds.length ? Math.max(...holds) : null, end: holds[holds.length - 1] ?? null, codes_end: status[status.length - 1]?.hold_codes ?? null,
      states: [...new Set(status.map(s => s.state + '/' + s.reason))], status_p50_ms: pct(status.map(s => s.ms), 50), status_max_ms: status.length ? Math.max(...status.map(s => s.ms)) : null },
    version: { versions: [start?.version].filter(Boolean), skew: skewChecks.length > 0, doctor_flags: [...new Set(skewChecks)] },
    doctor: { runs: doctors.map(d => ({ at: d.at, ms: d.ms, code: d.code, health_score: d.health_score, red: d.red, warn: d.warn?.length ?? 0, unfinished: Array.isArray(d.unfinished) ? d.unfinished.length : d.unfinished, total: d.total })), red_end: docEnd ? (docEnd.red ?? []).length : null },
    memory: { serve: memFor('serve'), worker: memFor('worker') },
    residents: { exits: of('resident_exit').length, detail: of('resident_exit'), serve_owned_notifier: of('notifier_owner')[0]?.owned ?? null },
    sync_jobs: of('sync_jobs')[0] ?? null,
    import_records: { start: status[0]?.import_records ?? null, end: status[status.length - 1]?.import_records ?? null },
    maintenance: Object.fromEntries([...new Set(maint.map(m => m.op))].map(op => { const xs = maint.filter(m => m.op === op); return [op, { runs: xs.length, failures: xs.filter(m => m.code !== 0).length, p50_ms: pct(xs.map(m => m.ms), 50), max_ms: xs.length ? Math.max(...xs.map(m => m.ms)) : null }]; })),
    privacy: { probes: priv.length, passive_scanned: end?.privacy_passive_scanned ?? null, leaks: leaks.length, examples: leaks.slice(0, 3).map(l => ({ op: l.op, class: l.class, tokens: l.tokens, snippet: l.snippet })), by_class: count(leaks.map(l => l.class)), by_op: count(leaks.map(l => l.op)), probe_errors: priv.filter(p => p.error).length },
    gates: [] as Array<Gate & { value: unknown; pass: boolean | null }>,
  };
  board.gates = GATES.map(g => { const value = g.metric.split('.').reduce<any>((o, k) => o?.[k], board); return { ...g, value, pass: value === null || value === undefined ? null : g.op === '<=' ? value <= g.threshold : g.op === '>=' ? value >= g.threshold : value === g.threshold }; });
  return board;
}

function count(xs: string[]): Record<string, number> { const o: Record<string, number> = {}; for (const x of xs) o[x] = (o[x] ?? 0) + 1; return o; }
function topErrors(rows: Ev[]): Array<{ err: string; n: number }> {
  return Object.entries(count(rows.filter(r => !r.ok).map(r => String(r.err ?? 'exit ' + r.code).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\d+/g, 'N').slice(0, 140)))).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([err, n]) => ({ err, n }));
}

export function renderScoreboard(b: ReturnType<typeof buildScoreboard>): string {
  const f = b.freshness, cell = (x: unknown) => x === null || x === undefined ? '-' : typeof x === 'object' ? JSON.stringify(x) : String(x);
  const lines = ['# Production soak scoreboard' + (b.label ? ' (' + b.label + ')' : ''), '',
    cell(b.gbrain_version) + ' at ' + cell(b.gbrain_rev).slice(0, 12) + ', ' + cell(b.rtt_ms) + ' ms RTT, ' + cell(b.elapsed_s) + ' s, ' + cell((b.brain as any)?.counts?.pages) + ' pages / ' + cell((b.brain as any)?.counts?.chunks) + ' chunks, ' + cell((b.brain as any)?.backlog_commits) + ' backlog commits at start.', '',
    '| gate | value | threshold | result (record only) |', '|---|---|---|---|',
    ...b.gates.map(g => '| ' + g.id + ' | ' + cell(g.value) + ' | ' + g.op + ' ' + cell(g.threshold) + ' | ' + (g.pass === null ? 'no data' : g.pass ? 'pass' : 'FAIL') + ' |'), '',
    '**Freshness** (commit -> keyword-searchable): ' + f.resolved + '/' + f.commits + ' resolved, p50 ' + cell(f.lag_p50_s) + ' s, p95 ' + cell(f.lag_p95_s) + ' s, max ' + cell(f.lag_max_s) + ' s; ' + f.unresolved + ' unresolved (oldest ' + f.unresolved_max_age_s + ' s); longest watermark stall ' + f.watermark_stall_max_s + ' s with ' + f.holds_during_stall + ' holds.', '',
    '| reads | op | n | errors | p50 ms | p95 ms |', '|---|---|---|---|---|---|'];
  for (const surface of ['cli', 'mcp'] as const) for (const [op, s] of Object.entries((b.reads as any)[surface] ?? {})) { const x = s as any; lines.push('| ' + (surface === 'cli' ? 'cold CLI' : 'warm MCP') + ' | ' + op + ' | ' + x.n + ' | ' + x.errors + ' | ' + cell(x.p50_ms) + ' | ' + cell(x.p95_ms) + ' |'); }
  lines.push('', '| writes | n | errors | p50 ms | p95 ms |', '|---|---|---|---|---|');
  for (const op of ['put', 'remember'] as const) { const x = (b.writes as any)[op]; lines.push('| ' + op + ' | ' + x.n + ' | ' + x.errors + ' | ' + cell(x.p50_ms) + ' | ' + cell(x.p95_ms) + ' |'); }
  lines.push('', '**Pool**: session peak ' + cell(b.pool.session_peak) + '/25 (active ' + cell(b.pool.session_active_peak) + '), transaction-lane server peak ' + cell(b.pool.txn_peak) + ', refusals ' + cell(b.pool.session_refusals) + ' session / ' + cell(b.pool.txn_refusals) + ' transaction, log hits ' + cell(b.pool.log_hits) + '.',
    '**Holds**: start ' + cell(b.holds.start) + ', max ' + cell(b.holds.max) + ', end ' + cell(b.holds.end) + ' ' + cell(b.holds.codes_end) + '; states ' + b.holds.states.join(', ') + '.',
    '**Doctor**: ' + b.doctor.runs.map(d => d.at + ' ' + Math.round((d.ms ?? 0) / 1000) + ' s, ' + (d.red ?? []).length + ' red' + ((d.red ?? []).length ? ' (' + (d.red as Array<{ name: string }>).map(r => r.name).join(', ') + ')' : '')).join('; ') + '.',
    '**Memory**: serve peak ' + cell(b.memory.serve.peak_mb) + ' MiB (growth ' + cell(b.memory.serve.growth_mb_per_h) + ' MiB/h), worker peak ' + cell(b.memory.worker.peak_mb) + ' MiB.',
    '**Sync jobs**: ' + cell((b.sync_jobs as any)?.jobs) + ' jobs ' + cell((b.sync_jobs as any)?.by_status) + ', ' + cell((b.sync_jobs as any)?.zero_progress) + ' stopped without applying anything, longest ' + cell((b.sync_jobs as any)?.max_s) + ' s; notifier owners ' + cell(((b.sync_jobs as any)?.notifier_owners ?? []).map((o: { log: string }) => o.log)) + '; serve owned the notifier at start: ' + cell(b.residents.serve_owned_notifier) + '.',
    '**Import records** (managed provenance, pages with a record / live pages): start ' + cell(b.import_records.start) + ', end ' + cell(b.import_records.end) + '.',
    '**Privacy**: ' + b.privacy.probes + ' remote probes, ' + b.privacy.leaks + ' leaks ' + cell(b.privacy.by_class) + '.',
    '**Maintenance**: ' + Object.entries(b.maintenance).map(([op, m]) => op + ' ' + (m as any).runs + ' runs, ' + (m as any).failures + ' failed, p50 ' + Math.round(((m as any).p50_ms ?? 0) / 1000) + ' s').join('; ') + '.');
  if (b.reads.errors_top.length) lines.push('', 'Top read errors: ' + b.reads.errors_top.map(e => e.n + 'x ' + e.err).join('; '));
  if (b.writes.errors_top.length) lines.push('', 'Top write errors: ' + b.writes.errors_top.map(e => e.n + 'x ' + e.err).join('; '));
  return lines.join('\n') + '\n';
}

/** One JSON document holding every cell's scoreboard (ubicloud.sh and the workflow write one cell per latency). */
export function combineScoreboards(dir: string): { schema: string; cells: Array<ReturnType<typeof buildScoreboard>> } {
  const cells: Array<ReturnType<typeof buildScoreboard>> = [];
  for (const sub of readdirSync(dir).sort()) for (const rel of ['scoreboard.json', 'out/scoreboard.json']) {
    const file = join(dir, sub, rel);
    if (existsSync(file)) { cells.push(JSON.parse(readFileSync(file, 'utf8'))); break; }
  }
  return { schema: 'gbrain-production-soak-scoreboards/1', cells };
}

if (import.meta.main) {
  if (process.argv[2] === '--combine') {
    const dir = process.argv[3]!;
    const all = combineScoreboards(dir);
    writeFileSync(join(dir, 'scoreboard.json'), JSON.stringify(all, null, 2));
    console.log(all.cells.map(renderScoreboard).join('\n'));
    process.exit(0);
  }
  const file = process.argv[2];
  if (!file) { console.error('usage: scoreboard.ts <events.jsonl> [--json] | --combine <dir>'); process.exit(2); }
  const board = buildScoreboard(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  console.log(process.argv.includes('--json') ? JSON.stringify(board, null, 2) : renderScoreboard(board));
}
