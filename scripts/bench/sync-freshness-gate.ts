#!/usr/bin/env bun
/**
 * GBRA-133 PR 2b.6: regression gate over the stable sync-freshness cells. Opt-in; never part of the PR tier.
 *
 *   bun scripts/bench/sync-freshness-gate.ts [--cells a,b] [--baseline scripts/bench/sync-freshness-baseline.json]
 *     [--work-dir DIR] [--out run.json] [--write-baseline FILE --machine-class NAME]
 *   bun scripts/bench/sync-freshness-gate.ts --oracle [--work-dir DIR]
 *
 * Procedure per cell: one sync-freshness.ts run of 11 reps with a 50 ms probe; rep 0 is a discarded warm-up and the
 * gate value is the p50 of commit -> keyword-visible over reps 1..10. A cell fails when that p50 exceeds the committed
 * baseline p50 by more than 25%, or when any counted rep never became visible. A baseline is valid only on the machine
 * class it names (machine_class); --write-baseline records this run as the baseline instead of comparing.
 *
 * Only cells measured stable are gated: 25 runs on 5 fresh Ubicloud standard-4 VMs (the CI runner class) put every
 * serve-watch cell's p50 within a max/min ratio of 1.18, with no false failure in any of 600 baseline/candidate run
 * pairs at +25%. A manual managed sync was left out: its p50 moves with the VM (852 to 1254 ms, 52 of 600 pairs failed).
 * Re-baselined 2026-10-23 on the PR 4b level pass with level reuse (GBRA-133), 5 fresh runners x 5 runs (dispatch with
 * runs=5): the baseline is runner 1's first run and the other 24 pass against it. PGLite managed is the widest cell
 * there (446.7 to 912.8 ms; a fresh runner's first run, the one the nightly makes, is the slow end: 659.5 to 912.8).
 * So that cell (MEASUREMENTS) is measured 3 times in a row, each exactly as above, and gated on the median of the three
 * p50s against the same baseline and limit: in the sample, the median of each runner's first three runs spans 507.6 to
 * 698.9 ms (every 3 consecutive runs: 491.9 to 698.9) against the 916.9 ms limit, where one first run came within 4.1 ms.
 * A slow first run on a fresh runner no longer decides the cell alone; a regression that moves every run still does.
 *
 * --oracle (GBRA-133 wave 4, untimed): the two managed cells once more with GBRAIN_SYNC_LEVEL_REUSE_VERIFY=1, so the
 * serve compares every level read it reused across passes with a whole read (persistence/sync-tree-reuse.ts) and logs
 * one `[level_reuse]` line per check. A cell fails when a rep never became visible, the serve logged a mismatch, or it
 * verified no reuse at all (the oracle checked nothing).
 */
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { machineInfo, pct } from './sync-freshness-lib.ts';

const REPO = resolve(import.meta.dir, '../..');
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };

const MARGIN = 1.25;
const REPS = 11;
const CELLS: Record<string, string[]> = {
  'postgres-managed-serve-watch': ['--engine', 'postgres', '--mode', 'managed', '--commit', 'single', '--trigger', 'serve', '--detection', 'watch'],
  'pglite-managed-serve-watch': ['--engine', 'pglite', '--mode', 'managed', '--commit', 'single', '--trigger', 'serve', '--detection', 'watch'],
  'postgres-classic-serve-watch': ['--engine', 'postgres', '--mode', 'classic', '--commit', 'single', '--trigger', 'serve', '--detection', 'watch'],
};
const MEASUREMENTS: Record<string, number> = { 'pglite-managed-serve-watch': 3 };
const names = flag('cells', Object.keys(CELLS).join(',')).split(',').filter(Boolean);
for (const n of names) if (!CELLS[n]) { console.error('unknown cell ' + n + '; known: ' + Object.keys(CELLS).join(', ')); process.exit(2); }
const WORK = resolve(flag('work-dir', join(REPO, '.context/bench/sync-freshness-gate')));
const BASELINE = resolve(flag('baseline', join(REPO, 'scripts/bench/sync-freshness-baseline.json')));
const WRITE = argv.includes('--write-baseline') ? resolve(flag('write-baseline', BASELINE)) : null;
mkdirSync(WORK, { recursive: true });

interface CellResult { cell: string; p50_ms: number | null; p50s?: number[]; counted: Array<number | null>; warmup_ms: number | null; limit_ms?: number; baseline_ms?: number; pass?: boolean; reason?: string }
if (argv.includes('--oracle')) process.exit(await levelReuseOracle());

/** --oracle: see the header. 6 reps per managed cell, 120 s each at most; the verdict comes from the serve logs. */
async function levelReuseOracle(): Promise<number> {
  const rows: string[] = [];
  let ok = true;
  for (const engine of ['pglite', 'postgres']) {
    const started = Date.now();
    const p = Bun.spawn([process.execPath, join(REPO, 'scripts/bench/sync-freshness.ts'), '--engine', engine, '--mode', 'managed', '--commit', 'single', '--trigger', 'serve',
      '--detection', 'watch', '--pages', '10000', '--reps', '6', '--probe-ms', '50', '--timeout', '120', '--work-dir', WORK, '--label', 'oracle', '--json'],
      { cwd: REPO, stdout: 'pipe', stderr: 'inherit', env: { ...process.env, GBRAIN_SYNC_LEVEL_REUSE_VERIFY: '1' } });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    const line = out.trim().split('\n').reverse().find(l => l.startsWith('{'));
    const reps = line ? (JSON.parse(line).reps as Array<{ search_ms: number | null }>).map(r => r.search_ms) : [];
    const logs = join(WORK, 'results', 'logs');
    const text = existsSync(logs) ? readdirSync(logs).filter(f => f.startsWith(`${engine}-managed-10000-single-serve-oracle-`) && statSync(join(logs, f)).mtimeMs >= started)
      .map(f => readFileSync(join(logs, f), 'utf8')).join('\n') : '';
    const verified = text.match(/level_reuse_verified/g)?.length ?? 0, mismatches = text.match(/level_reuse_mismatch/g)?.length ?? 0;
    const reason = code !== 0 || !line ? 'bench exited ' + code : reps.some(r => r === null) ? 'a rep never became visible'
      : mismatches ? mismatches + ' mismatch(es) in the serve log' : verified === 0 ? 'no reused level read was verified' : null;
    if (reason) ok = false;
    rows.push('| ' + [engine + '-managed', reps.length, verified, mismatches, reason ? 'FAIL: ' + reason : 'pass'].join(' | ') + ' |');
  }
  console.log('| oracle cell | reps | reused reads verified | mismatches | verdict |\n|---|---|---|---|---|\n' + rows.join('\n'));
  return ok ? 0 : 1;
}

/** One sync-freshness.ts run of the cell: the p50 of reps 1..10, or why it has none. */
async function measure(name: string): Promise<CellResult> {
  const p = Bun.spawn([process.execPath, join(REPO, 'scripts/bench/sync-freshness.ts'), ...CELLS[name]!, '--pages', '10000', '--reps', String(REPS), '--probe-ms', '50',
    '--work-dir', WORK, '--label', 'gate', '--json'], { cwd: REPO, stdout: 'pipe', stderr: 'inherit' });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const line = out.trim().split('\n').reverse().find(l => l.startsWith('{'));
  if (code !== 0 || !line) return { cell: name, p50_ms: null, counted: [], warmup_ms: null, pass: false, reason: 'bench exited ' + code };
  const reps = (JSON.parse(line).reps as Array<{ search_ms: number | null }>).map(r => r.search_ms);
  const counted = reps.slice(1);
  const missing = counted.length < REPS - 1 || counted.some(x => x === null);
  return { cell: name, p50_ms: missing ? null : pct(counted as number[], 50), counted, warmup_ms: reps[0] ?? null, ...(missing ? { pass: false, reason: 'a counted rep never became visible' } : {}) };
}

const results: CellResult[] = [];
for (const name of names) {
  const runs: CellResult[] = [];
  for (let i = 0; i < (MEASUREMENTS[name] ?? 1); i++) runs.push(await measure(name));
  const failed = runs.find(r => r.p50_ms === null);
  if (failed || runs.length === 1) { results.push(failed ?? runs[0]!); continue; }
  const p50s = runs.map(r => r.p50_ms!), median = [...p50s].sort((a, b) => a - b)[Math.floor(p50s.length / 2)]!;
  results.push({ ...runs[p50s.indexOf(median)]!, p50_ms: median, p50s });
}

const run = { schema: 'gbrain-sync-freshness-gate/1', at: new Date().toISOString(), machine: machineInfo(), procedure: 'p50 of reps 1..10 of 11 (rep 0 discarded), 50 ms probe, 10k pages; median of 3 such p50s for ' + Object.keys(MEASUREMENTS).join(', '), cells: results };
const out = flag('out', '');
if (out) writeFileSync(resolve(out), JSON.stringify(run, null, 2) + '\n');
if (WRITE) {
  if (results.some(r => r.p50_ms === null)) { console.error('not writing a baseline: ' + results.filter(r => r.p50_ms === null).map(r => r.cell + ' (' + r.reason + ')').join(', ')); process.exit(1); }
  writeFileSync(WRITE, JSON.stringify({ schema: 'gbrain-sync-freshness-baseline/1', machine_class: flag('machine-class', 'unspecified'), measured_at: run.at, machine: run.machine,
    margin: MARGIN, cells: Object.fromEntries(results.map(r => [r.cell, { p50_ms: r.p50_ms }])) }, null, 2) + '\n');
  console.log('wrote baseline ' + WRITE);
} else {
  if (!existsSync(BASELINE)) { console.error('no baseline at ' + BASELINE); process.exit(2); }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as { machine_class: string; cells: Record<string, { p50_ms: number }> };
  for (const r of results) {
    const b = base.cells[r.cell];
    if (!b) { r.pass = false; r.reason = 'no baseline for this cell'; continue; }
    r.baseline_ms = b.p50_ms;
    r.limit_ms = Math.round(b.p50_ms * MARGIN * 10) / 10;
    if (r.pass === undefined) { r.pass = r.p50_ms! <= r.limit_ms; if (!r.pass) r.reason = 'p50 ' + r.p50_ms + ' ms > ' + r.limit_ms + ' ms (baseline ' + b.p50_ms + ' ms + 25%)'; }
  }
  console.log('Baseline machine class: ' + base.machine_class + '\n');
  console.log('| cell | p50 of 10 (ms) | baseline (ms) | limit (ms) | warm-up (ms) | verdict |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) console.log('| ' + [r.cell, r.p50s ? r.p50_ms + ' (median of ' + r.p50s.join(', ') + ')' : r.p50_ms ?? '-', r.baseline_ms ?? '-', r.limit_ms ?? '-', r.warmup_ms ?? '-', r.pass ? 'pass' : 'FAIL: ' + r.reason].join(' | ') + ' |');
}
process.exit(results.every(r => r.pass !== false) ? 0 : 1);
