#!/usr/bin/env bun
/**
 * GBRA-438 PR 2: how much tool-call latency idle upkeep adds inside a stdio `gbrain serve` on a keyless, repo-less
 * PGLite brain (the default install).
 *
 * Builds a brain of --pages pages, each linking to --links others and carrying one timeline line, imported with
 * --no-embed so its links and timeline are stale. Then, per arm, it starts a stdio serve on a fresh copy of that brain
 * with a --interval-ms idle tick and sends MCP `search` calls after random quiet gaps (--gap-ms min-max). Arm `upkeep`
 * leaves upkeep on; arm `baseline` sets maintenance.auto false, so only the existing idle sweep runs. Each call is
 * tagged by what the serve was doing when it was sent (read from its stderr): `upkeep`, `sweep` or `idle`. A copy
 * whose upkeep round has finished is replaced by a fresh one until --calls calls landed during upkeep (or --max-copies).
 * Copies are restored into the same path (the brain's config and owner files record it), from a snapshot of .gbrain.
 *
 *   bun scripts/bench/serve-upkeep-latency.ts --pages 1401 --out ~/upkeep-latency [--calls 150] [--links 3]
 *     [--interval-ms 1000] [--gap-ms 1200-3200] [--baseline-calls 150] [--max-copies 8]
 *     [--small-source-pages 0] [--quiet-ms 0]
 *
 * --small-source-pages adds a second source (zz-small, after default in item order) so a default source too big for
 * the slice budget shows the give-up rule: it parks and zz-small still finishes. --quiet-ms adds a quiet arm: a fresh
 * copy served with no tool calls for that long, then served again after a restart (its first idle run retries parked
 * items), reporting the upkeep slices per serve process, when the last one ended, and the parked record.
 *
 * Writes calls.jsonl and summary.json under --out and prints p50/p95/p99/max per arm and tag.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1]! : fallback; };
const PAGES = Number(flag('pages', '1401')), LINKS = Number(flag('links', '3'));
const CALLS = Number(flag('calls', '150')), BASELINE_CALLS = Number(flag('baseline-calls', flag('calls', '150')));
const INTERVAL_MS = Number(flag('interval-ms', '1000')), MAX_COPIES = Number(flag('max-copies', '8'));
const [GAP_MIN, GAP_MAX] = flag('gap-ms', '1200-3200').split('-').map(Number) as [number, number];
const OUT = resolve(flag('out', join(process.cwd(), 'upkeep-latency')));
const SMALL_PAGES = Number(flag('small-source-pages', '0')), QUIET_MS = Number(flag('quiet-ms', '0'));
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');
const WORDS = ['alpha', 'harbor', 'ledger', 'orbit', 'meadow', 'signal', 'copper', 'lantern', 'summit', 'river', 'quartz', 'falcon'];

function keylessEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'JEV_TYPESAFE_API_KEY']) delete env[k];
  return { ...env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', ...extra };
}

async function gbrain(home: string, args: string[]): Promise<string> {
  const p = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], { cwd: home, env: keylessEnv(home), stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${code}: ${err.slice(-2000)}`);
  return out;
}

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! : NaN; };
const stats = (xs: number[]) => ({ n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99), max: xs.length ? Math.max(...xs) : NaN });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buildPristine(): Promise<string> {
  const home = join(OUT, 'brain');
  if (existsSync(join(OUT, 'snapshot', 'built'))) return home;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'notes'), { recursive: true });
  const started = Date.now();
  await gbrain(home, ['init', '--pglite', '--no-embedding', '--non-interactive']);
  const name = (i: number) => `p${String(i).padStart(5, '0')}`;
  for (let i = 0; i < PAGES; i++) {
    const links = Array.from({ length: LINKS }, (_, k) => `[[${name((i * 7919 + k * 104729 + 1) % PAGES)}]]`).join(', ');
    const words = Array.from({ length: 6 }, (_, k) => WORDS[(i + k * 5) % WORDS.length]).join(' ');
    const day = String(1 + (i % 28)).padStart(2, '0'), month = String(1 + (i % 12)).padStart(2, '0');
    writeFileSync(join(home, 'notes', `${name(i)}.md`), `---\ntitle: Page ${i}\ntype: concept\n---\n# Page ${i}\n\nPage ${i} is about ${words}. It relates to ${links}.\n\n## Timeline\n\n- **2026-${month}-${day}** | Notes — Page ${i} was reviewed.\n`);
  }
  await gbrain(home, ['import', join(home, 'notes'), '--no-embed']);
  if (SMALL_PAGES > 0) {
    mkdirSync(join(home, 'small'), { recursive: true });
    for (let i = 0; i < SMALL_PAGES; i++) writeFileSync(join(home, 'small', `s${i}.md`), `---
title: Small ${i}
type: concept
---
# Small ${i}

Small ${i} relates to [[s${(i + 1) % SMALL_PAGES}]].
`);
    await gbrain(home, ['sources', 'add', 'zz-small', '--path', join(home, 'small'), '--force']);
    await gbrain(home, ['import', join(home, 'small'), '--source', 'zz-small', '--no-embed']);
  }
  cpSync(join(home, '.gbrain'), join(OUT, 'snapshot', '.gbrain'), { recursive: true });
  writeFileSync(join(OUT, 'snapshot', 'built'), `${Date.now() - started}\n`);
  console.log(`built ${PAGES} pages in ${Math.round((Date.now() - started) / 1000)} s`);
  return home;
}

interface Call { arm: string; copy: number; tag: 'upkeep' | 'sweep' | 'idle'; ms: number; ok: boolean }

async function runCopy(arm: 'upkeep' | 'baseline' | 'quiet', copy: number, home: string, want: () => boolean, record: (c: Call) => void,
  opts: { restore?: boolean; quietMs?: number } = {}): Promise<{ upkeepFinished: number[]; roundDone: boolean; lastUpkeepAt: number | null; servedMs: number; parked: unknown }> {
  if (opts.restore !== false) {
    rmSync(join(home, '.gbrain'), { recursive: true, force: true });
    cpSync(join(OUT, 'snapshot', '.gbrain'), join(home, '.gbrain'), { recursive: true });
  }
  const servedAt = Date.now();
  if (arm === 'baseline') await gbrain(home, ['config', 'set', 'maintenance.auto', 'false']);
  const serve = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve'], { cwd: home, env: keylessEnv(home, { GBRAIN_SWEEP_IDLE_INTERVAL_MS: String(INTERVAL_MS) }), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let log = '';
  const pending = new Map<number, (ok: boolean) => void>();
  const upkeepEnds: number[] = [];
  const errReader = (async () => { for await (const chunk of serve.stderr) { const text = new TextDecoder().decode(chunk); log += text; for (const _ of text.matchAll(/idle upkeep: finished/g)) upkeepEnds.push(Date.now() - servedAt); appendFileSync(join(OUT, `${arm}-${copy}.serve.log`), text); } })();
  const outReader = (async () => {
    let buf = '';
    for await (const chunk of serve.stdout) {
      buf += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { const msg = JSON.parse(line); if (typeof msg.id === 'number') { pending.get(msg.id)?.(!msg.error && !msg.result?.isError); pending.delete(msg.id); } } catch { /* not a JSON-RPC line */ }
      }
    }
  })();
  let nextId = 1;
  const send = (method: string, params: unknown) => new Promise<boolean>((res) => {
    const id = nextId++;
    pending.set(id, res);
    serve.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    serve.stdin.flush();
  });
  const count = (re: RegExp) => (log.match(re) ?? []).length;
  const tagNow = (): Call['tag'] => count(/idle upkeep: started/g) > count(/idle upkeep: finished/g) ? 'upkeep' : count(/idle sweep: started/g) > count(/idle sweep: finished/g) ? 'sweep' : 'idle';
  let roundDone = false;
  try {
    await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'upkeep-latency', version: '1' } });
    serve.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    for (let w = 0; w < 5; w++) await send('tools/call', { name: 'search', arguments: { query: WORDS[w]! } });
    if (opts.quietMs) await sleep(opts.quietMs);
    let quietSince = Date.now(), lastStarts = count(/idle upkeep: started/g), i = 0;
    while (want()) {
      await sleep(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
      const tag = tagNow();
      const t0 = performance.now();
      const ok = await send('tools/call', { name: 'search', arguments: { query: WORDS[i++ % WORDS.length]! } });
      record({ arm, copy, tag, ms: Math.round((performance.now() - t0) * 10) / 10, ok });
      const starts = count(/idle upkeep: started/g);
      if (starts !== lastStarts) { lastStarts = starts; quietSince = Date.now(); }
      if (arm === 'upkeep' && Date.now() - quietSince > Math.max(20_000, 8 * GAP_MAX)) { roundDone = true; break; }
    }
  } finally {
    serve.stdin.end();
    const killer = setTimeout(() => serve.kill(9), 20_000);
    await serve.exited;
    clearTimeout(killer);
    await Promise.allSettled([errReader, outReader]);
  }
  const upkeepFinished = [...log.matchAll(/idle upkeep: finished in (\d+) ms/g)].map((m) => Number(m[1]));
  const status = JSON.parse(await gbrain(home, ['maintain', '--status', '--json'])) as { state: string; parked: unknown };
  return { upkeepFinished, roundDone, lastUpkeepAt: upkeepEnds.length ? upkeepEnds[upkeepEnds.length - 1]! : null, servedMs: Date.now() - servedAt, parked: { state: status.state, parked: status.parked } };
}

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, 'calls.jsonl'), { force: true });
const home = await buildPristine();
const calls: Call[] = [];
const record = (c: Call) => { calls.push(c); appendFileSync(join(OUT, 'calls.jsonl'), JSON.stringify(c) + '\n'); };
const duringUpkeep = () => calls.filter((c) => c.arm === 'upkeep' && c.tag === 'upkeep').length;
const runs: Record<string, unknown>[] = [];

let baselineCalls = 0;
await runCopy('baseline', 0, home, () => baselineCalls++ < BASELINE_CALLS, record);
for (let copy = 0; copy < MAX_COPIES && duringUpkeep() < CALLS; copy++) {
  const r = await runCopy('upkeep', copy, home, () => duringUpkeep() < CALLS, record);
  runs.push({ copy, round_done: r.roundDone, upkeep_slices: r.upkeepFinished.length, slice_ms: stats(r.upkeepFinished), status: r.parked });
}
const quiet: Record<string, unknown>[] = [];
if (QUIET_MS > 0) {
  for (const restart of [false, true]) {
    const r = await runCopy('quiet', 0, home, () => false, record, { restore: !restart, quietMs: QUIET_MS });
    quiet.push({ restart, served_ms: r.servedMs, upkeep_slices: r.upkeepFinished.length, slice_ms: stats(r.upkeepFinished),
      last_upkeep_ended_ms: r.lastUpkeepAt, quiet_tail_ms: r.servedMs - (r.lastUpkeepAt ?? 0), status: r.parked });
  }
}

const pick = (arm: string, tag?: string) => calls.filter((c) => c.arm === arm && (!tag || c.tag === tag)).map((c) => c.ms);
const base = stats(pick('baseline'));
const during = stats(pick('upkeep', 'upkeep'));
const summary = {
  pages: PAGES, links: LINKS, interval_ms: INTERVAL_MS, gap_ms: [GAP_MIN, GAP_MAX],
  baseline_all: base, upkeep_arm_all: stats(pick('upkeep')),
  upkeep_arm_by_tag: { upkeep: during, sweep: stats(pick('upkeep', 'sweep')), idle: stats(pick('upkeep', 'idle')) },
  added_vs_baseline_ms: { p95: during.p95 - base.p95, p99: during.p99 - base.p99, max: during.max - base.max },
  failed_calls: calls.filter((c) => !c.ok).length,
  copies: runs,
  ...(quiet.length ? { quiet } : {}),
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
