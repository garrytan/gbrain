#!/usr/bin/env bun
/**
 * Hot-path bench (GBRA-66). Opt-in, never run in CI.
 *
 *   bun scripts/bench/efficiency/bench-hot.ts --engine pglite|postgres --label <name>
 *       [--n 20] [--warmup 3] [--only search,query_expand,...] [--sync-dir <dir>] [--out results/hot.jsonl]
 *
 * Runs against the brain bench-import.ts built at $BENCH_WORK/engines/<engine>-<label>.
 *   cold  one fresh `gbrain <cmd>` process per sample (what a CLI user or a
 *         shell-out agent pays: bun start, config, engine connect, op, exit)
 *   warm  one long-lived `gbrain serve` stdio MCP process, N tool calls after
 *         --warmup calls (what an MCP-connected agent pays per call)
 * Also: MCP stdio startup + first tool call, HTTP serve startup + first tool
 * call (fresh server per sample, bearer token), doctor, and a one-page sync.
 *
 * Query strings and slugs are sampled from the brain itself (three words of a
 * random page's body) and never printed or written; rows carry counts only.
 */
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, REPO, WORK, appendRows, ensureDir, flag, has, lastJson, log, machine, readJsonl, rng, round, runCli, summarize, usageCost, type Row, type UsageRecord } from './lib.ts';

const engine = flag('engine', 'pglite') as 'pglite' | 'postgres';
const label = flag('label')!;
const N = Number(flag('n', '20'));
const WARMUP = Number(flag('warmup', '3'));
const only = flag('only')?.split(',');
const out = flag('out', join(WORK, 'results', 'hot.jsonl'))!;
const home = join(WORK, 'engines', `${engine}-${label}`);
if (!existsSync(home)) throw new Error(`no brain at ${home}; run bench-import.ts first`);
const env: Record<string, string> = { GBRAIN_HOME: home, GBRAIN_ALLOW_DEFAULT_WRITE: '1' };
const runDir = ensureDir(join(home, 'bench-run'));
const usageFile = join(runDir, 'hot.usage.jsonl');
rmSync(usageFile, { force: true });
const M = machine();
const want = (k: string) => !only || only.includes(k);

/** Minimal newline-delimited JSON-RPC client for `gbrain serve` over stdio. */
class StdioMcp {
  proc: ReturnType<typeof Bun.spawn>;
  private buf = '';
  private waiters = new Map<number, (v: any) => void>();
  private nextId = 1;
  constructor(extraEnv: Record<string, string> = {}) {
    this.proc = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, 'preload-instrument.ts'), CLI, 'serve'], {
      cwd: REPO, env: { ...process.env, ...env, ...extraEnv }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    });
    void this.pump();
  }
  private async pump() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buf += dec.decode(value, { stream: true });
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number' && this.waiters.has(msg.id)) {
            this.waiters.get(msg.id)!(msg);
            this.waiters.delete(msg.id);
          }
        } catch { /* partial or non-JSON line */ }
      }
    }
  }
  request(method: string, params: unknown, timeoutMs = 120_000): Promise<any> {
    const id = this.nextId++;
    const p = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
      this.waiters.set(id, (v) => { clearTimeout(t); resolve(v); });
    });
    (this.proc.stdin as any).write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    (this.proc.stdin as any).flush?.();
    return p;
  }
  notify(method: string, params: unknown = {}) {
    (this.proc.stdin as any).write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbra66-bench', version: '1' } });
    this.notify('notifications/initialized');
  }
  async call(name: string, args: Record<string, unknown>) {
    const r = await this.request('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`rpc error ${r.error.code}`);
    if (r.result?.isError) throw new Error('tool error');
    return r.result;
  }
  async close() {
    try { (this.proc.stdin as any).end(); } catch { /* already closed */ }
    const t = setTimeout(() => this.proc.kill(), 3000);
    await this.proc.exited;
    clearTimeout(t);
  }
}

function toolJson(result: any): any {
  const text = result?.content?.find((c: any) => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return null; }
}

async function sample<T>(n: number, fn: (i: number) => Promise<T>): Promise<{ ms: number[]; errors: number }> {
  const ms: number[] = [];
  let errors = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try { await fn(i); ms.push(performance.now() - t0); } catch { errors++; }
  }
  return { ms, errors };
}

async function main() {
  const stats = lastJson((await runCli(['stats', '--json'], env)).stdout) ?? {};
  const pages = Number(stats.page_count ?? 0);
  const chunks = Number(stats.chunk_count ?? 0);
  const rows: Row[] = [];
  const add = (command: string, mode: Row['mode'], s: { ms: number[]; errors: number }, extra?: Record<string, unknown>) => {
    if (s.ms.length === 0) { log(`${command} [${mode}] all ${s.errors} samples failed`); }
    const row: Row = { suite: 'hot', machine: M, engine, brain: label, pages, chunks, command, mode, ...summarize(s.ms.length ? s.ms : [NaN]), errors: s.errors, extra };
    row.n = s.ms.length;
    rows.push(row);
    log(`${command} [${mode}] n=${row.n} p50=${row.p50_ms} p95=${row.p95_ms} err=${s.errors}`);
  };

  // Sample slugs and queries from the brain through a warm server; never printed.
  const mcp = new StdioMcp({ BENCH_USAGE_LOG: usageFile });
  await mcp.init();
  const listed = toolJson(await mcp.call('list_pages', { limit: 500, sort: 'slug', source_id: '__all__' })) ?? [];
  const all: { slug: string; source_id: string }[] = (Array.isArray(listed) ? listed : listed.pages ?? []).map((p: any) => ({ slug: p.slug, source_id: p.source_id }));
  const r = rng(1234);
  const picks = Array.from({ length: Math.max(N, 20) }, () => all[Math.floor(r() * all.length)]!).filter(Boolean);
  const queries: string[] = [];
  for (const p of picks) {
    if (queries.length >= picks.length) break;
    const page = toolJson(await mcp.call('get_page', { slug: p.slug, source_id: p.source_id }));
    const words = String(page?.compiled_truth ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3);
    if (words.length < 3) continue;
    const at = Math.floor(r() * (words.length - 3));
    queries.push(words.slice(at, at + 3).join(' '));
  }
  log(`sampled ${picks.length} pages, ${queries.length} queries (not printed)`);
  const q = (i: number) => queries[i % queries.length]!;
  const pk = (i: number) => picks[i % picks.length]!;

  const paths: { key: string; tool: string; args: (i: number) => Record<string, unknown>; cli: (i: number) => string[] }[] = [
    { key: 'search', tool: 'search', args: (i) => ({ query: q(i), limit: 10 }), cli: (i) => ['search', q(i)] },
    { key: 'query_expand', tool: 'query', args: (i) => ({ query: q(i), expand: true }), cli: (i) => ['query', q(i)] },
    { key: 'query_noexpand', tool: 'query', args: (i) => ({ query: q(i), expand: false }), cli: (i) => ['query', q(i), '--no-expand'] },
    { key: 'get_page', tool: 'get_page', args: (i) => ({ slug: pk(i).slug, source_id: pk(i).source_id }), cli: (i) => ['call', '--source', pk(i).source_id, 'get_page', JSON.stringify({ slug: pk(i).slug })] },
    { key: 'list_pages', tool: 'list_pages', args: () => ({ limit: 50 }), cli: () => ['list', '--limit', '50'] },
    { key: 'recall', tool: 'recall', args: (i) => ({ query: q(i), budget_tokens: 2000 }), cli: (i) => ['call', 'recall', JSON.stringify({ query: q(i), budget_tokens: 2000 })] },
  ];

  // Warm: the already-running stdio server.
  for (const p of paths) {
    if (!want(p.key)) continue;
    await sample(WARMUP, (i) => mcp.call(p.tool, p.args(i + 1000)));
    add(`mcp ${p.tool}${p.key.startsWith('query_') ? (p.key === 'query_expand' ? ' expand=true' : ' expand=false') : ''}`, 'warm', await sample(N, (i) => mcp.call(p.tool, p.args(i))));
  }
  await mcp.close();

  // Cold: one fresh CLI process per sample.
  for (const p of paths) {
    if (!want(p.key)) continue;
    add(`gbrain ${p.cli(0)[0]}${p.key === 'query_noexpand' ? ' --no-expand' : ''}${p.cli(0)[0] === 'call' ? ' ' + p.tool : ''}`, 'cold', await sample(N, async (i) => {
      const res = await runCli(p.cli(i), { ...env, BENCH_USAGE_LOG: usageFile }, { preload: true, timeoutMs: 120_000 });
      if (res.code !== 0) throw new Error(`exit ${res.code}`);
    }));
  }

  if (want('doctor')) {
    for (const args of [['doctor', '--json'], ['doctor', '--fast', '--json']]) {
      add(`gbrain ${args.join(' ')}`, 'cold', await sample(Math.min(N, Number(flag('doctor-n', String(N)))), async () => {
        const res = await runCli(args, env, { timeoutMs: 300_000 });
        if (res.code !== 0 && res.code !== 1) throw new Error(`exit ${res.code}`);
      }));
    }
  }

  if (want('mcp_startup')) {
    add('mcp stdio startup + get_page', 'cold', await sample(N, async (i) => {
      const c = new StdioMcp();
      try { await c.init(); await c.call('get_page', { slug: pk(i).slug, source_id: pk(i).source_id }); } finally { await c.close(); }
    }));
  }

  if (want('http_startup')) {
    const tokOut = await runCli(['auth', 'create', `bench-${Date.now()}`, '--scopes', 'read'], env);
    const token = tokOut.stdout.match(/gbrain_[A-Za-z0-9_]+/)?.[0];
    const port = 38100 + Math.floor(r() * 800);
    add('http serve startup + get_page', 'cold', await sample(token ? N : 0, async (i) => {
      const proc = Bun.spawn([process.execPath, CLI, 'serve', '--http', '--port', String(port), '--bind', '127.0.0.1'], { cwd: REPO, env: { ...process.env, ...env }, stdout: 'ignore', stderr: 'ignore' });
      try {
        const deadline = performance.now() + 60_000;
        for (;;) {
          try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not listening yet */ }
          if (performance.now() > deadline) throw new Error('http startup timeout');
          await Bun.sleep(20);
        }
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: pk(i).slug, source_id: pk(i).source_id } } }),
        });
        const body = await res.text();
        if (!res.ok || body.includes('"isError":true')) throw new Error(`http ${res.status}`);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }));
  }

  const syncDir = flag('sync-dir');
  if (want('sync') && syncDir) {
    const git = async (...a: string[]) => {
      const p = Bun.spawn(['git', '-C', syncDir, ...a], { stdout: 'ignore', stderr: 'pipe' });
      if ((await p.exited) !== 0) throw new Error(`git ${a[0]} failed`);
    };
    if (!existsSync(join(syncDir, '.git'))) {
      await git('init', '-q');
      await git('add', '-A');
      await git('commit', '-q', '-m', 'bench baseline');
    }
    const syncArgs = ['sync', '--source', 'syncbench', '--no-pull', '--no-embed', '--json'];
    await runCli(['sources', 'add', 'syncbench', '--path', syncDir, '--no-federated'], env);
    const first = await runCli(syncArgs, env, { timeoutMs: 900_000 });
    add('gbrain sync --source (first sync of a git source, --no-embed)', 'once', { ms: first.code === 0 ? [first.ms] : [], errors: first.code === 0 ? 0 : 1 }, { source_pages: (await new Response(Bun.spawn(['git', '-C', syncDir, 'ls-files', '*.md'], { stdout: 'pipe' }).stdout).text()).split('\n').filter(Boolean).length });
    const files = (await new Response(Bun.spawn(['git', '-C', syncDir, 'ls-files', '*.md'], { stdout: 'pipe' }).stdout).text()).split('\n').filter(Boolean);
    add('gbrain sync (1-page change, --no-embed)', 'cold', await sample(N, async (i) => {
      const f = join(syncDir, files[Math.floor(r() * files.length)]!);
      appendFileSync(f, `\nBench edit ${i} ${Date.now()}.\n`);
      await git('commit', '-q', '-am', `bench edit ${i}`);
      const res = await runCli(syncArgs, env, { timeoutMs: 300_000 });
      if (res.code !== 0) throw new Error(`exit ${res.code}`);
    }));
    add('gbrain sync (no change)', 'cold', await sample(Math.min(N, 10), async () => {
      const res = await runCli(syncArgs, env, { timeoutMs: 300_000 });
      if (res.code !== 0) throw new Error(`exit ${res.code}`);
    }));
  }

  const usage = usageCost(readJsonl<UsageRecord>(usageFile));
  for (const row of rows) row.extra = { ...(row.extra ?? {}) };
  appendRows(out, rows);
  writeFileSync(join(WORK, 'results', `hot-${engine}-${label}-usage.json`), JSON.stringify(usage, null, 1));
  log(`done: ${rows.length} rows, provider spend so far for this brain $${usage.usd}`);
}

await main();
