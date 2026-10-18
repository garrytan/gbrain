#!/usr/bin/env bun
/**
 * Render bench JSONL rows as markdown tables (GBRA-66). Opt-in, never run in CI.
 *
 *   bun scripts/bench/efficiency/report.ts [--results $BENCH_WORK/results] [--out report.md]
 *
 * Reads import.jsonl, hot.jsonl and remote.jsonl. Rows hold counts, sizes and
 * timings only, so the rendered report is safe to share.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK, flag, readRows, type Row } from './lib.ts';

const dir = flag('results', join(WORK, 'results'))!;
const outFile = flag('out', join(dir, 'report.md'))!;
const fmt = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? '-' : x >= 100 ? String(Math.round(x)) : String(x));

function table(rows: Row[], extraCols: [string, (r: Row) => string][] = []): string {
  const head = ['engine', 'brain', 'pages', 'chunks', 'command', 'mode', 'N', 'p50 ms', 'p95 ms', ...extraCols.map((c) => c[0])];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) lines.push(`| ${[r.engine, r.brain, r.pages, r.chunks, r.command, r.mode, r.n, fmt(r.p50_ms), fmt(r.p95_ms), ...extraCols.map((c) => c[1](r))].join(' | ')} |`);
  return lines.join('\n');
}

/** Keep the newest row per (engine, brain, command, mode). */
function latest(rows: Row[]): Row[] {
  const m = new Map<string, Row>();
  for (const r of rows) m.set(`${r.engine}|${r.brain}|${r.command}|${r.mode}`, r);
  return [...m.values()];
}

const imp = latest(readRows(join(dir, 'import.jsonl')));
const hot = latest(readRows(join(dir, 'hot.jsonl')));
const remote = latest(readRows(join(dir, 'remote.jsonl')));
const machines = [...new Set([...imp, ...hot, ...remote].map((r) => r.machine))];
const parts: string[] = [`# gbrain efficiency bench`, '', `Machine(s): ${machines.map((m) => '`' + m + '`').join(', ')}`, ''];

if (remote.length) parts.push('## Hosted brain remote reads', '', table(remote, [['note', (r) => String(r.extra?.note ?? '')]]), '');
if (imp.length) {
  const totals = imp.filter((r) => r.command.startsWith('import pipeline total'));
  parts.push('## Import pipeline totals', '', table(totals, [
    ['files', (r) => fmt(r.extra?.files as number)],
    ['MB', (r) => fmt(Math.round(Number(r.extra?.bytes ?? 0) / 1e5) / 10)],
    ['ms/page', (r) => fmt(r.extra?.ms_per_page as number)],
    ['engine ms', (r) => fmt(r.extra?.engine_ms as number)],
    ['cpu ms', (r) => fmt(r.extra?.cpu_user_ms as number)],
    ['parse ms', (r) => fmt(r.extra?.probe_parse_ms as number)],
    ['chunk ms', (r) => fmt(r.extra?.probe_chunk_ms as number)],
    ['extract ms', (r) => fmt(r.extra?.extract_ms as number)],
    ['embed ms', (r) => fmt(r.extra?.embed_ms as number)],
    ['embed $', (r) => fmt(r.extra?.embed_usd as number)],
  ]), '');
  parts.push('## Import phases', '', table(imp.filter((r) => !r.command.startsWith('import pipeline total')), [
    ['engine ms', (r) => fmt(r.extra?.engine_ms as number)],
    ['http ms', (r) => fmt(r.extra?.http_ms as number)],
    ['http calls', (r) => fmt(r.extra?.http_calls as number)],
    ['$', (r) => fmt(r.extra?.usd as number)],
  ]), '');
}
if (hot.length) {
  const order = (r: Row) => `${r.command}|${r.mode}|${r.engine}|${String(r.pages).padStart(8, '0')}`;
  parts.push('## Hot paths', '', table([...hot].sort((a, b) => order(a).localeCompare(order(b))), [['err', (r) => fmt(r.errors)]]), '');
}
const spendFile = join(dir, 'spend.json');
if (existsSync(spendFile)) parts.push('## Spend', '', '```json', readFileSync(spendFile, 'utf8').trim(), '```', '');
writeFileSync(outFile, parts.join('\n'));
console.log(outFile);
