/**
 * Helpers for scripts/bench/sync-freshness.ts (GBRA-133 lane A): the synthetic
 * corpus, commit generators, probes (in-process engine and MCP stdio), child
 * processes with per-line arrival timestamps, and the statistics. Everything
 * binds loopback and runs keyless.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';

export const now = () => performance.timeOrigin + performance.now();
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Linear-interpolated percentile. */
export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return round1(s[lo]! + (s[hi]! - s[lo]!) * (rank - lo));
}
export interface Stats { n: number; p50: number | null; p95: number | null; max: number | null; min: number | null; mean: number | null; cv: number | null }
export function stats(xs: number[]): Stats {
  const n = xs.length;
  if (!n) return { n, p50: null, p95: null, max: null, min: null, mean: null, cv: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, p50: pct(xs, 50), p95: pct(xs, 95), max: round1(Math.max(...xs)), min: round1(Math.min(...xs)), mean: round1(mean), cv: mean ? Math.round((sd / mean) * 1000) / 1000 : null };
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
}
export function commit(root: string, message: string, paths: string[] | 'all'): string {
  if (paths === 'all') git(root, 'add', '-A');
  else for (let i = 0; i < paths.length; i += 500) git(root, 'add', '-A', '--', ...paths.slice(i, i + 500));
  git(root, '-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

export function machineInfo(): Record<string, unknown> {
  let kernel = '';
  try { kernel = execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(); } catch { /* best effort */ }
  return { cores: cpus().length, cpu_model: cpus()[0]?.model ?? 'unknown', ram_gb: Math.round(totalmem() / 2 ** 30), kernel, bun: Bun.version };
}

// Synthetic corpus: deterministic pages, 1000 per directory.
const WORDS = ['ledger', 'harbor', 'quartz', 'meadow', 'signal', 'lantern', 'orbit', 'canvas', 'summit', 'thicket', 'ember', 'falcon',
  'garnet', 'hollow', 'island', 'juniper', 'kestrel', 'linden', 'marble', 'nectar', 'oracle', 'pepper', 'quiver', 'russet'];
export const pagePath = (i: number) => 'notes/d' + String(Math.floor(i / 1000)).padStart(3, '0') + '/n-' + String(i).padStart(6, '0') + '.md';
export const addedPath = (n: number) => 'notes/added/a-' + String(n).padStart(6, '0') + '.md';
export const slugOf = (path: string) => path.replace(/\.md$/, '');
export function pageContent(i: number, status = 'baseline'): string {
  const w = (k: number) => WORDS[(i * 7 + k * 13) % WORDS.length];
  const body = Array.from({ length: 6 }, (_, p) => 'Paragraph ' + p + ' of note ' + i + ' covers the ' + w(p) + ' ' + w(p + 1) + ' plan, the ' + w(p + 2) + ' follow-up and a decision about the ' + w(p + 3) + ' review.').join('\n\n');
  return '---\ntitle: Note ' + i + '\ntype: note\ntags: [bench, ' + w(0) + ']\n---\n# Note ' + i + '\n\nStatus: ' + status + '\n\n' + body + '\n\nSee [[' + slugOf(pagePath((i + 1) % 1000)) + ']].\n';
}
export function writeCorpus(root: string, pages: number): void {
  for (let i = 0; i < pages; i++) {
    const p = join(root, pagePath(i));
    if (i % 1000 === 0) mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, pageContent(i));
  }
  writeFileSync(join(root, 'README.md'), '# Bench brain (synthetic)\n');
}
/** Lowercase letters only, so every tokenizer keeps it as one word. */
export function token(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  let t = 'zq';
  for (let i = 0; i < 10; i++) t += a[Math.floor(Math.random() * 26)];
  return t;
}

// Corpus state between runs: which pages are deleted, how many were added.
export interface CorpusState { pages: number; deleted: number[]; added: number[]; nextAdd: number; cursor: number }
export function readState(dir: string): CorpusState { return JSON.parse(readFileSync(join(dir, 'corpus-state.json'), 'utf8')); }
export function writeState(dir: string, s: CorpusState): void { writeFileSync(join(dir, 'corpus-state.json'), JSON.stringify(s)); }

export type CommitKind = 'single' | 'batch' | 'backlog';
export interface Change { kind: CommitKind; token: string; sha: string; t_commit: number; t_commit_start: number; edited: string[]; added: string[]; deleted: string[]; source: string }

/** Writes and commits one change. single: 1 edit; batch: 50 edits + 5 adds + 5 deletes; backlog: 1000 edits. */
export function makeChange(root: string, dir: string, kind: CommitKind, source = 'bench'): Change {
  const st = readState(dir);
  const dead = new Set(st.deleted);
  const tok = token();
  const nEdit = kind === 'single' ? 1 : kind === 'batch' ? 50 : 1000;
  const nAdd = kind === 'batch' ? 5 : 0;
  const nDel = kind === 'batch' ? 5 : 0;
  const seen = new Set<number>();
  const pick = (): number => {
    for (;;) { const i = st.cursor; st.cursor = (st.cursor + 7919) % st.pages; if (!dead.has(i) && !seen.has(i)) { seen.add(i); return i; } }
  };
  const editIdx = Array.from({ length: nEdit }, pick);
  const delIdx = Array.from({ length: nDel }, pick);
  const edited = editIdx.map(pagePath);
  const added: string[] = [];
  const deleted = delIdx.map(pagePath);
  const t_commit_start = now();
  for (const i of editIdx) writeFileSync(join(root, pagePath(i)), pageContent(i, 'edited ' + tok));
  for (let k = 0; k < nAdd; k++) {
    const n = st.nextAdd++;
    const p = addedPath(n);
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), '---\ntitle: Added ' + n + '\ntype: note\n---\n# Added ' + n + '\n\nStatus: added ' + tok + '\n\nA new bench note.\n');
    added.push(p); st.added.push(n);
  }
  for (const p of deleted) rmSync(join(root, p));
  for (const i of delIdx) st.deleted.push(i);
  const sha = commit(root, 'bench ' + kind + ' ' + tok, [...edited, ...added, ...deleted]);
  const t_commit = now();
  writeState(dir, st);
  return { kind, token: tok, sha, t_commit, t_commit_start, edited, added, deleted, source };
}

// Child processes with per-line arrival timestamps.
export interface Line { t: number; stream: 'out' | 'err'; text: string }
export interface Child { proc: ReturnType<typeof Bun.spawn>; lines: Line[]; exited: Promise<number>; onLine: (fn: (l: Line) => void) => void; exitAt: number | null; startedAt: number; stdoutRaw: () => string; write: (s: string) => void; kill: (sig?: NodeJS.Signals) => void }

export function spawnChild(cmd: string[], opts: { cwd: string; env: Record<string, string | undefined>; logFile?: string; stdin?: boolean }): Child {
  const startedAt = now();
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env as Record<string, string>, stdin: opts.stdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const lines: Line[] = [];
  const listeners: Array<(l: Line) => void> = [];
  let raw = '';
  const emit = (line: Line) => {
    lines.push(line);
    if (opts.logFile) appendFileSync(opts.logFile, new Date(line.t).toISOString() + ' ' + line.stream + ' ' + line.text + '\n');
    for (const fn of listeners) fn(line);
  };
  const pump = async (stream: ReadableStream<Uint8Array>, name: 'out' | 'err') => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of stream) {
      const t = now();
      const text = dec.decode(chunk, { stream: true });
      if (name === 'out') raw += text;
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { emit({ t, stream: name, text: buf.slice(0, nl) }); buf = buf.slice(nl + 1); }
    }
    if (buf) emit({ t: now(), stream: name, text: buf });
  };
  const child: Child = {
    proc, lines, exitAt: null, startedAt,
    exited: Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, 'out'), pump(proc.stderr as ReadableStream<Uint8Array>, 'err'), proc.exited])
      .then(([, , code]) => { child.exitAt = now(); return code as number; }),
    onLine: fn => { listeners.push(fn); },
    stdoutRaw: () => raw,
    write: s => { const w = proc.stdin as unknown as { write: (s: string) => void; flush?: () => void }; w.write(s); w.flush?.(); },
    kill: (sig = 'SIGTERM') => { try { proc.kill(sig); } catch { /* gone */ } },
  };
  return child;
}
export function waitLine(child: Child, re: RegExp, timeoutMs: number, fromT = 0): Promise<Line | null> {
  const hit = child.lines.find(l => l.t >= fromT && re.test(l.text));
  if (hit) return Promise.resolve(hit);
  return new Promise(resolve => {
    let done = false;
    const finish = (v: Line | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.onLine(l => { if (l.t >= fromT && re.test(l.text)) finish(l); });
    void child.exited.then(() => setTimeout(() => finish(null), 50));
  });
}

// MCP stdio client over a foresights serve child.
export class McpClient {
  private id = 0;
  private pending = new Map<number, (v: { result?: any; error?: any }) => void>();
  constructor(private child: Child) {
    child.onLine(l => {
      if (l.stream !== 'out' || !l.text.startsWith('{')) return;
      try {
        const msg = JSON.parse(l.text) as { id?: number; result?: unknown; error?: unknown };
        const cb = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (cb) { this.pending.delete(msg.id!); cb(msg); }
      } catch { /* not a JSON-RPC line */ }
    });
  }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<{ result?: any; error?: any }> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('mcp ' + method + ' timed out')); }, timeoutMs);
      this.pending.set(id, v => { clearTimeout(timer); resolve(v); });
      this.child.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init(): Promise<void> {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sync-freshness-bench', version: '1' } }, 120_000);
    if (r.error) throw new Error('mcp initialize failed: ' + JSON.stringify(r.error));
    this.child.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.request('tools/call', { name, arguments: args });
    if (r.error) return 'ERROR ' + JSON.stringify(r.error);
    return (r.result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');
  }
}

// Probes: has the change become visible?
export interface ProbeResult { getOk: boolean; searchHits: number; searchOk: boolean; partial: boolean; embedded?: boolean; vectorHit?: boolean; embeddedChunks?: number }

/** The vector the bench embedding stub returns for a text (managed-sync-catchup-lib.ts startEmbeddingStub), so a vector search can be aimed at a chunk. */
export function stubVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % dims] += 1;
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map(x => x / norm);
}
export interface Prober { check(c: Change): Promise<ProbeResult>; close(): Promise<void>; kind: string }

export const expectedHits = (c: Change) => c.edited.length + c.added.length;
/** get_page targets: the last edited path in path order, the last added page, and the first deleted page (must be gone). */
export function getTargets(c: Change): { present: string[]; gone: string[] } {
  return { present: [[...c.edited].sort().at(-1)!, ...(c.added.length ? [c.added.at(-1)!] : [])], gone: c.deleted.slice(0, 1) };
}

/**
 * `embeddedText` returns the input the embedding stub embedded for a token (the chunk text plus the context header foresights
 * adds), so the vector check queries searchVector with exactly the vector the provider returned for that chunk.
 */
export async function engineProber(gbrainRoot: string, databaseUrl: string, embed = false, embeddedText?: (token: string) => string | undefined): Promise<Prober> {
  const { PostgresEngine } = await import(join(gbrainRoot, 'src/core/postgres-engine.ts'));
  const engine = new PostgresEngine();
  await engine.connect({ database_url: databaseUrl, poolSize: 2 });
  return {
    kind: 'engine',
    async check(c) {
      const { present, gone } = getTargets(c);
      const want = expectedHits(c);
      let getOk = true;
      const src = c.source;
      for (const path of present) {
        const p = await engine.getPage(slugOf(path), { sourceId: src }).catch(() => null);
        if (!p || !String(p.compiled_truth ?? '').includes(c.token)) { getOk = false; break; }
      }
      if (getOk) for (const path of gone) if (await engine.getPage(slugOf(path), { sourceId: src }).catch(() => null)) { getOk = false; break; }
      const hits = await engine.searchKeyword(c.token, { limit: 100, sourceId: src }).catch(() => []);
      const slugs = new Set((hits as Array<{ slug: string }>).map(h => h.slug));
      let embedded: boolean | undefined;
      let vectorHit: boolean | undefined;
      let embeddedChunks: number | undefined;
      if (embed) {
        const [{ total, done }] = await engine.executeRaw("SELECT count(*)::int AS total, count(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS done FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$2 AND p.deleted_at IS NULL AND c.chunk_text LIKE $1", ['%' + c.token + '%', src]);
        embedded = total >= Math.min(want, 1) && done === total && total > 0 && (want <= 100 || total >= want);
        embeddedChunks = done;
        const text = embeddedText?.(c.token);
        if (embedded && want <= 100 && text) {
          const target = slugOf([...c.edited].sort().at(-1)!);
          const vhits = await engine.searchVector(new Float32Array(stubVector(text, 1536)), { limit: 5, sourceId: src }).catch(() => []);
          vectorHit = (vhits as Array<{ slug: string }>).some(h => h.slug === target);
        }
      }
      if (want <= 100) return { getOk, searchHits: slugs.size, searchOk: slugs.size >= want, partial: slugs.size > 0, embedded, vectorHit, embeddedChunks };
      const [{ n }] = await engine.executeRaw("SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$2 AND p.deleted_at IS NULL AND c.chunk_text LIKE $1", ['%' + c.token + '%', src]);
      return { getOk, searchHits: n, searchOk: slugs.size >= 100 && n >= want, partial: slugs.size > 0, embedded, embeddedChunks };
    },
    async close() { await engine.disconnect(); },
  };
}

/**
 * Probes through a serve's MCP stdio. With `embedSeen` (the embedding stub returned a vector for an input carrying the
 * token) a single-file change also counts as embedded once get_page body:none reports every chunk embedded.
 */
export function mcpProber(client: McpClient, embedSeen?: (token: string) => boolean): Prober {
  return {
    kind: 'mcp',
    async check(c) {
      const { present, gone } = getTargets(c);
      const want = expectedHits(c);
      let getOk = true;
      for (const path of present) {
        const text = await client.call('get_page', { slug: slugOf(path), source_id: c.source }).catch(e => String(e));
        if (!text.includes(c.token)) { getOk = false; break; }
      }
      if (getOk) for (const path of gone) {
        const text = await client.call('get_page', { slug: slugOf(path), source_id: c.source }).catch(e => String(e));
        if (text.includes('Status: baseline')) { getOk = false; break; }
      }
      const text = await client.call('search', { query: c.token, limit: 100, source_id: c.source, match: 'keyword' }).catch(e => String(e));
      const slugs = new Set([...text.matchAll(/notes\/(?:d\d{3}\/n-\d{6}|added\/a-\d{6})/g)].map(m => m[0]));
      let embedded: boolean | undefined;
      if (embedSeen && want <= 100) {
        embedded = false;
        if (getOk && embedSeen(c.token)) {
          const none = await client.call('get_page', { slug: slugOf(present[0]!), source_id: c.source, body: 'none' }).catch(e => String(e));
          const m = /"chunks"\s*:\s*\{\s*"total"\s*:\s*(\d+)\s*,\s*"embedded"\s*:\s*(\d+)/.exec(none);
          embedded = !!m && Number(m[1]) > 0 && m[1] === m[2];
        }
      }
      return { getOk, searchHits: slugs.size, searchOk: slugs.size >= Math.min(want, 100), partial: slugs.size > 0, embedded };
    },
    async close() { /* the serve owns it */ },
  };
}

export interface Visibility { t_get: number | null; t_search: number | null; t_first_hit: number | null; t_embedded?: number | null; t_vector?: number | null; probes: number; probe_ms_mean: number }
/** Polls until both get_page and search see the change, or the deadline. */
export async function pollVisible(prober: Prober, c: Change, deadline: number, everyMs: number): Promise<Visibility> {
  let t_get: number | null = null, t_search: number | null = null, t_first: number | null = null, t_emb: number | null = null, t_vec: number | null = null;
  let probes = 0, probeMs = 0, wantEmb = false, wantVec = false;
  const pending = () => t_get === null || t_search === null || (wantEmb && t_emb === null) || (wantVec && t_vec === null);
  while (now() < deadline && pending()) {
    const t0 = now();
    const r = await prober.check(c);
    const t1 = now();
    probes++; probeMs += t1 - t0;
    if (r.getOk && t_get === null) t_get = t1;
    if (r.searchOk && t_search === null) t_search = t1;
    if (r.partial && t_first === null) t_first = t1;
    if (r.embedded !== undefined) { wantEmb = true; if (r.embedded && t_emb === null) t_emb = t1; }
    if (r.vectorHit !== undefined) { wantVec = true; if (r.vectorHit && t_vec === null) t_vec = t1; }
    if (pending()) await sleep(Math.max(0, everyMs - (now() - t0)));
  }
  return { t_get, t_search, t_first_hit: t_first, t_embedded: wantEmb ? t_emb : undefined, t_vector: wantVec ? t_vec : undefined, probes, probe_ms_mean: probes ? round1(probeMs / probes) : 0 };
}

/** CPU seconds (user + system, reaped children included) of a process and every live descendant, from /proc (Linux). */
export function treeCpuSeconds(pid: number): number {
  const tck = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  const procs = new Map<number, { ppid: number; ticks: number }>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync('/proc/' + name + '/stat', 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.set(Number(name), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]) });
    } catch { /* exited while listing */ }
  }
  let ticks = 0;
  const queue = [pid];
  for (let q = queue.shift(); q !== undefined; q = queue.shift()) {
    ticks += procs.get(q)?.ticks ?? 0;
    for (const [child, p] of procs) if (p.ppid === q) queue.push(child);
  }
  return ticks / tck;
}

export function copyDir(from: string, to: string): void { rmSync(to, { recursive: true, force: true }); cpSync(from, to, { recursive: true }); }
export { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync };
