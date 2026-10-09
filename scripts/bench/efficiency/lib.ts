/**
 * Shared helpers for the efficiency bench harness (GBRA-66). Opt-in, never run in CI.
 *
 * Every result row carries the fields the Efficiency crew requires for a speed
 * claim: machine, engine, brain size (pages/chunks), command, warm or cold, N,
 * p50 and p95. Rows never carry page text, titles or slugs.
 */
import { cpus, totalmem, hostname, platform, release } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const REPO = resolve(import.meta.dir, '../../..');
export const CLI = join(REPO, 'src/cli.ts');
export const PRELOAD = join(import.meta.dir, 'preload-instrument.ts');
export const WORK = process.env.BENCH_WORK ?? join(homedir(), '.capy/work/brain');

export interface Row {
  suite: 'import' | 'hot' | 'remote';
  machine: string;
  engine: 'pglite' | 'postgres' | 'hosted';
  brain: string;
  pages: number;
  chunks: number;
  command: string;
  mode: 'cold' | 'warm' | 'once';
  n: number;
  p50_ms: number;
  p95_ms: number;
  mean_ms?: number;
  min_ms?: number;
  max_ms?: number;
  errors?: number;
  extra?: Record<string, unknown>;
}

export function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) return process.argv[i + 1];
  return fallback;
}
export const has = (name: string) => process.argv.includes(`--${name}`);

export function pct(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return round(s[idx]!);
}
export const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

export function summarize(samples: number[]): Pick<Row, 'n' | 'p50_ms' | 'p95_ms' | 'mean_ms' | 'min_ms' | 'max_ms'> {
  return {
    n: samples.length,
    p50_ms: pct(samples, 0.5),
    p95_ms: pct(samples, 0.95),
    mean_ms: round(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)),
    min_ms: round(Math.min(...samples)),
    max_ms: round(Math.max(...samples)),
  };
}

export function machine(): string {
  const c = cpus();
  return `${process.env.BENCH_MACHINE ?? hostname().slice(0, 12)} ${platform()}-${release().split('-')[0]} ${c.length}x${(c[0]?.model ?? 'cpu').replace(/\s+/g, ' ').slice(0, 40)} ${Math.round(totalmem() / 2 ** 30)}GiB bun-${Bun.version}`;
}

export const log = (m: string) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${m}`);

export function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function appendRows(file: string, rows: Row[]) {
  ensureDir(dirname(file));
  for (const r of rows) appendFileSync(file, JSON.stringify(r) + '\n');
}

export function readRows(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
}

export interface RunResult { ms: number; code: number; stdout: string; stderr: string }

/** Run the gbrain CLI as a fresh process. `preload` adds the bench instrumentation. */
export async function runCli(args: string[], env: Record<string, string>, opts: { preload?: boolean; cpuProf?: string; stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const bunArgs = [process.execPath];
  if (opts.cpuProf) bunArgs.push('--cpu-prof', `--cpu-prof-dir=${opts.cpuProf}`);
  if (opts.preload) bunArgs.push('--preload', PRELOAD);
  bunArgs.push(CLI, ...args);
  const t0 = performance.now();
  const proc = Bun.spawn(bunArgs, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
  });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { ms: performance.now() - t0, code, stdout, stderr };
}

/** Last JSON object printed on stdout (gbrain --json prints one document). */
export function lastJson(stdout: string): any {
  const start = stdout.lastIndexOf('\n{');
  const text = start >= 0 ? stdout.slice(start + 1) : stdout.trim().startsWith('{') ? stdout.trim() : '';
  try { return JSON.parse(text); } catch { /* fall through */ }
  for (let i = stdout.indexOf('{'); i >= 0; i = stdout.indexOf('{', i + 1)) {
    try { return JSON.parse(stdout.slice(i)); } catch { /* keep scanning */ }
  }
  return null;
}

/** Embedding / LLM price table for the providers the bench may hit ($ per 1M tokens). */
export const PRICE_PER_MTOK: Record<string, { in: number; out?: number }> = {
  'voyage-4': { in: 0.06 },
  'voyage-4-large': { in: 0.12 },
  'voyage-4-lite': { in: 0.02 },
  'rerank-2.5': { in: 0.05 },
  'rerank-2.5-lite': { in: 0.02 },
  'text-embedding-3-large': { in: 0.13 },
  'text-embedding-3-small': { in: 0.02 },
};

export interface UsageRecord { host: string; path: string; model?: string; status: number; ms: number; input_tokens?: number; output_tokens?: number; total_tokens?: number }

/** Sum provider usage captured by preload-instrument.ts. Unknown models price at null. */
export function usageCost(records: UsageRecord[]) {
  const byModel: Record<string, { calls: number; input_tokens: number; output_tokens: number; usd: number | null; ms: number }> = {};
  for (const r of records) {
    const key = `${r.host}:${r.model ?? r.path}`;
    const m = (byModel[key] ??= { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, ms: 0 });
    m.calls++;
    m.ms += r.ms;
    const inTok = r.input_tokens ?? r.total_tokens ?? 0;
    m.input_tokens += inTok;
    m.output_tokens += r.output_tokens ?? 0;
    const price = r.model ? PRICE_PER_MTOK[r.model.replace(/^.*\//, '')] : undefined;
    if (r.host.includes('anthropic') && r.model) {
      const p = r.model.includes('haiku') ? { in: 1, out: 5 } : r.model.includes('sonnet') ? { in: 3, out: 15 } : null;
      m.usd = p && m.usd !== null ? m.usd + (inTok * p.in + (r.output_tokens ?? 0) * p.out) / 1e6 : null;
    } else if (price && m.usd !== null) m.usd += (inTok * price.in + (r.output_tokens ?? 0) * (price.out ?? 0)) / 1e6;
    else if (inTok > 0) m.usd = null;
  }
  const total = Object.values(byModel).reduce((a, m) => a + (m.usd ?? 0), 0);
  return { byModel, usd: round(total, 4) };
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}

export function writeJson(file: string, data: unknown) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Mulberry32: tiny deterministic PRNG for the synthetic generator and query picks. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
