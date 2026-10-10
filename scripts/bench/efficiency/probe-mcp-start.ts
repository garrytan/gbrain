#!/usr/bin/env bun
/**
 * MCP stdio cold-start probe (GBRA-73). Opt-in, never run in CI.
 *
 *   bun scripts/bench/efficiency/probe-mcp-start.ts --home <GBRAIN_HOME> \
 *     --cli <before>/src/cli.ts --cli <after>/src/cli.ts [--n 20] \
 *     [--slug <existing-slug>] [--label <brain-label>] [--engine pglite|postgres] \
 *     [--idle-ms 0,1000] [--json <out.jsonl>]
 *
 * Each sample is a fresh `gbrain serve` process (GBRAIN_SWEEP=0). Per sample:
 *   init   spawn -> initialize response
 *   list   spawn -> tools/list response (sent right after initialize)
 *   call1  first tools/call latency, from send to response
 *   total  spawn -> first tools/call response (includes the idle gap)
 * The first call is sent after an idle gap following tools/list (each
 * --idle-ms value is its own row; 0 = back-to-back), and is either get_page
 * on --slug or list_pages {limit:10}. With several --cli values the samples
 * interleave (A, B, A, B ...) after one discarded warm-up each, so machine
 * drift hits every side equally. Percentiles are nearest-rank at fractions
 * 0.5 / 0.95. Prints a markdown table plus the tools/list payload size and
 * hash per CLI (equal hashes = byte-identical list).
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { machine as machineLabel, pct } from './lib.ts';

const argv = process.argv.slice(2);
const flags = (name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const flag = (name: string, dflt?: string): string | undefined => flags(name)[0] ?? dflt;

const home = flag('home');
const clis = flags('cli');
if (!home || clis.length === 0) throw new Error('usage: --home <GBRAIN_HOME> --cli <src/cli.ts> [--cli ...]');
const N = Number(flag('n', '20'));
const slug = flag('slug', 'bench/missing')!;
const label = flag('label', 'unlabeled')!;
const engine = flag('engine', 'pglite')!;
const idles = flag('idle-ms', '0,1000')!.split(',').map(Number);
const jsonOut = flag('json');

interface Sample { init: number; list: number; call1: number; total: number; listHash: string; listBytes: number }

async function sample(cli: string, call: { name: string; arguments: Record<string, unknown> }, idleMs: number): Promise<Sample> {
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, cli, 'serve'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    env: { ...process.env, GBRAIN_HOME: home!, GBRAIN_SWEEP: '0' },
  });
  const send = (msg: unknown) => { proc.stdin.write(JSON.stringify(msg) + '\n'); proc.stdin.flush(); };
  const waiters = new Map<number, (msg: any) => void>();
  const reader = (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
      }
    }
  })();
  const request = (id: number, method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    waiters.set(id, msg => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  try {
    await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe-mcp-start', version: '0' } });
    const tInit = performance.now();
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await request(2, 'tools/list', {});
    const tList = performance.now();
    if (idleMs > 0) await Bun.sleep(idleMs);
    const tSend = performance.now();
    const res = await request(3, 'tools/call', call);
    const tCall = performance.now();
    if (res.error || res.result?.isError) throw new Error(`tools/call failed: ${JSON.stringify(res.error ?? res.result).slice(0, 400)}`);
    const listJson = JSON.stringify(list.result);
    return {
      init: tInit - t0, list: tList - t0, call1: tCall - tSend, total: tCall - t0,
      listHash: createHash('sha256').update(listJson).digest('hex').slice(0, 12), listBytes: listJson.length,
    };
  } finally {
    proc.stdin.end();
    proc.kill();
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    await reader.catch(() => {});
  }
}

const calls = [
  { label: 'get_page', call: { name: 'get_page', arguments: { slug } } },
  { label: 'list_pages', call: { name: 'list_pages', arguments: { limit: 10 } } },
];

const machine = machineLabel();
console.log(`machine: ${machine}`);
console.log(`engine: ${engine}  brain: ${label}  command: gbrain serve (stdio)  mode: cold (fresh process per sample)  N: ${N} per row, interleaved  percentiles: nearest-rank 0.5/0.95\n`);
console.log('| cli | first call | idle after list ms | N | init p50 | init p95 | list p50 | list p95 | call1 p50 | call1 p95 | total p50 | total p95 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
const hashes = new Map<string, Set<string>>();
for (const idleMs of idles) {
  for (const { label: callLabel, call } of calls) {
    const results = new Map<string, Sample[]>(clis.map(c => [c, []]));
    for (const cli of clis) await sample(cli, call, idleMs);
    for (let i = 0; i < N; i++) {
      for (const cli of clis) {
        const s = await sample(cli, call, idleMs);
        results.get(cli)!.push(s);
        const h = hashes.get(cli) ?? new Set();
        h.add(`${s.listHash} (${s.listBytes} bytes)`);
        hashes.set(cli, h);
      }
    }
    for (const cli of clis) {
      const rows = results.get(cli)!;
      const f = (k: 'init' | 'list' | 'call1' | 'total', p: number) => pct(rows.map(r => r[k]), p).toFixed(0);
      console.log(`| ${cli} | ${callLabel} | ${idleMs} | ${rows.length} | ${f('init', 0.5)} | ${f('init', 0.95)} | ${f('list', 0.5)} | ${f('list', 0.95)} | ${f('call1', 0.5)} | ${f('call1', 0.95)} | ${f('total', 0.5)} | ${f('total', 0.95)} |`);
      if (jsonOut) {
        appendFileSync(jsonOut, JSON.stringify({
          machine, engine, brain: label, command: `gbrain serve stdio, first call ${callLabel}`, cli, idle_ms: idleMs, mode: 'cold', n: rows.length,
          ...Object.fromEntries((['init', 'list', 'call1', 'total'] as const).flatMap(k => [[`${k}_p50`, pct(rows.map(r => r[k]), 0.5)], [`${k}_p95`, pct(rows.map(r => r[k]), 0.95)]])),
        }) + '\n');
      }
    }
  }
}
console.log('');
for (const [cli, h] of hashes) console.log(`tools/list ${cli}: ${[...h].join(', ')}`);
