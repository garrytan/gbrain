#!/usr/bin/env bun
/**
 * Turn the latencies a hosted-brain pull recorded into bench rows (GBRA-66).
 *
 *   bun scripts/bench/efficiency/remote-rows.ts --source default [--channel "capy codemode MCP relay"]
 *
 * The pull itself runs outside this repo (an MCP client paging list_pages
 * with sort=updated_asc and calling get_page per slug); it writes
 * $BENCH_WORK/pull/manifest-<source>.json with per-call ms. Latencies include
 * whatever relay sits between the client and the hosted server, named by
 * --channel. Counts and timings only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK, appendRows, flag, machine, summarize, type Row } from './lib.ts';

const source = flag('source', 'default')!;
const channel = flag('channel', 'capy codemode -> hosted MCP')!;
const m = JSON.parse(readFileSync(join(WORK, 'pull', `manifest-${source}.json`), 'utf8'));
const pages = m.pages as any[];
const base = { suite: 'remote' as const, machine: machine(), engine: 'hosted' as const, brain: `hosted:${source}`, pages: pages.length, chunks: 0, mode: 'warm' as const };
const full = pages.filter((p) => !p.needs_reconstruct && !p.oversize && p.get_page_ms);
const rows: Row[] = [
  { ...base, command: 'list_pages limit=100', ...summarize(m.list_ms), extra: { note: channel } },
  { ...base, command: 'get_page include_content+timeline_entries', ...summarize(full.map((p) => p.get_page_ms)), extra: { note: `${channel}; pages whose response fit the relay cap`, mean_response_kb: Math.round(full.reduce((a, p) => a + (p.response_bytes ?? 0), 0) / full.length / 102.4) / 10 } },
  { ...base, command: 'get_page (all pages, any payload)', ...summarize(pages.filter((p) => p.get_page_ms).map((p) => p.get_page_ms)), extra: { note: channel } },
];
appendRows(join(WORK, 'results', 'remote.jsonl'), rows);
console.log(JSON.stringify(rows.map((r) => ({ command: r.command, n: r.n, p50: r.p50_ms, p95: r.p95_ms }))));
