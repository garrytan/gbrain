/**
 * Large-brain operational assertions (Foundations 1 F4d) for the scale tier.
 * Each runs the real CLI against the scale run's brain (or, for `sources
 * add`, a fresh managed brain) after the timed ops, and lands in the report as
 * an enforced data check plus its measurement:
 *
 *   f4d_sync_deadline      `gbrain sync` of a fresh source (1,000 files at 10k and up)
 *                          past a 1 s progress-aware deadline keeps importing and completes.
 *   f4d_embed_budget_stop  `gbrain embed --stale` stopped by its time budget exits 11
 *                          with the remaining count and the resume command (a local
 *                          stub embedding endpoint; no provider call leaves the machine).
 *   f4d_serve_boot         `gbrain serve` on the brain answers initialize and a search
 *                          inside its boot window and does not exit on the boot deadline.
 *   f4d_sources_add_20k    `gbrain sources add` registers a 20,000-file checkout on a
 *                          fresh managed brain (tiers of 20,000 pages and up only).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataCheck } from './gates.ts';

/** Files in the sync-deadline checkout: one tenth of the brain, between 100 and 1,000 (1,000 at the 10k and 20k tiers). */
export const f4dSyncFiles = (pages: number) => Math.min(1000, Math.max(100, Math.floor(pages / 10)));
export const F4D_ADD_FILES = 20_000;
export const F4D_ADD_MIN_PAGES = 20_000;
const EMBED_BUDGET_MS = 1500;
const EMBED_STUB_DELAY_MS = 200;

export interface F4dContext {
  repo: string;
  home: string;
  pages: number;
  dim: number;
  probeToken: string;
  /** The config a fresh managed brain for the 20k-file add should use (a new PGLite path or a new Postgres database). */
  freshManagedBrain: () => Promise<{ initArgs: string[]; cleanup: () => Promise<void> }>;
}

interface Run { code: number; stdout: string; stderr: string; ms: number }

async function cli(ctx: F4dContext, args: string[], env: Record<string, string | undefined> = {}, home = ctx.home): Promise<Run> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, join(ctx.repo, 'src/cli.ts'), ...args],
    { env: { ...process.env, GBRAIN_HOME: home, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr, ms: Math.round(performance.now() - started) };
}

function gitCheckout(root: string, files: number, prefix: string): void {
  for (let i = 0; i < files; i++) {
    const dir = join(root, 'notes', `batch-${String(Math.floor(i / 500)).padStart(3, '0')}`);
    if (i % 500 === 0) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${prefix}-${String(i).padStart(6, '0')}.md`), `---\ntitle: ${prefix} ${i}\ntype: note\n---\n\nOperational ceiling note ${i}.\n`);
  }
  const git = (args: string[]) => execFileSync('git', ['-c', 'user.email=scale@example.com', '-c', 'user.name=scale', ...args], { cwd: root, stdio: 'ignore' });
  git(['init', '--quiet']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'f4d fixture']);
}

/** The watchdog's extension notice: `still progressing` after a commit, or `before the run committed anything` inside the first progress window. */
export const deadlineExtended = (stderr: string) => stderr.includes('still progressing') || stderr.includes('before the run committed anything');

const tail = (run: Run) => `exit ${run.code}; stdout: ${run.stdout.slice(-600)} stderr: ${run.stderr.slice(-600)}`;
const lastJson = (text: string) => {
  const line = text.trim().split('\n').reverse().find(l => l.startsWith('{'));
  try { return line ? JSON.parse(line) as Record<string, unknown> : undefined; } catch { return undefined; }
};

async function syncDeadline(ctx: F4dContext): Promise<{ check: DataCheck; measured: Record<string, unknown> }> {
  const root = join(ctx.home, 'f4d-sync');
  const files = f4dSyncFiles(ctx.pages);
  gitCheckout(root, files, 'sync');
  const add = await cli(ctx, ['sources', 'add', 'f4d-sync', '--path', root]);
  if (add.code !== 0) return { check: { check: 'f4d_sync_deadline', status: 'fail', detail: `sources add failed: ${tail(add)}` }, measured: {} };
  const sync = await cli(ctx, ['sync', '--source', 'f4d-sync', '--no-pull', '--no-embed', '--json'],
    { GBRAIN_SYNC_MAX_RUNTIME_SECONDS: '1', GBRAIN_SYNC_STALL_ABORT_SECONDS: '300' });
  const body = lastJson(sync.stdout);
  const imported = Number(body?.added ?? 0);
  const extended = deadlineExtended(sync.stderr);
  const problem = sync.code !== 0 ? `sync exited before finishing: ${tail(sync)}`
    : imported !== files ? `sync imported ${imported} of ${files} files`
      : !extended && sync.ms > 2000 ? 'sync outlasted its 1 s deadline without the progress-aware extension notice' : null;
  return { check: { check: 'f4d_sync_deadline', status: problem ? 'fail' : 'pass', ...(problem ? { detail: problem } : {}) },
    measured: { files, deadline_s: 1, wall_ms: sync.ms, imported, extended } };
}

async function embedBudgetStop(ctx: F4dContext): Promise<{ check: DataCheck; measured: Record<string, unknown> }> {
  const vector = Array.from({ length: ctx.dim }, (_, i) => (i === 0 ? 1 : 0));
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'bge-m3', object: 'model' }] });
    if (!url.pathname.endsWith('/embeddings')) return new Response('not found', { status: 404 });
    const body = await request.json() as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    await Bun.sleep(EMBED_STUB_DELAY_MS);
    return Response.json({ object: 'list', model: 'bge-m3', usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: vector })) });
  } });
  const configPath = join(ctx.home, '.gbrain', 'config.json');
  const original = readFileSync(configPath, 'utf8');
  try {
    const { embedding_disabled: _off, ...base } = JSON.parse(original) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...base, embedding_model: 'ollama:bge-m3', embedding_dimensions: ctx.dim }, null, 2) + '\n');
    const embed = await cli(ctx, ['embed', '--stale', '--batch-size', '50', '--yes'], {
      OLLAMA_BASE_URL: `http://127.0.0.1:${server.port}/v1`, GBRAIN_EMBED_TIME_BUDGET_MS: String(EMBED_BUDGET_MS), GBRAIN_EMBED_CONCURRENCY: '1',
    });
    const verdict = `${embed.stdout}\n${embed.stderr}`.split('\n').find(l => l.includes('reason: time_budget')) ?? '';
    const left = Number(/with (\d+) stale chunk\(s\) left/.exec(verdict)?.[1] ?? NaN);
    const problem = embed.code !== 11 ? `embed exited ${embed.code}, expected the budget-stop status 11: ${tail(embed)}`
      : !(left > 0) ? `the budget-stop verdict does not name the remaining stale chunks: ${verdict || tail(embed)}`
        : !verdict.includes('gbrain embed --stale --catch-up') ? `the budget-stop verdict does not name the resume command: ${verdict}` : null;
    return { check: { check: 'f4d_embed_budget_stop', status: problem ? 'fail' : 'pass', ...(problem ? { detail: problem } : {}) },
      measured: { budget_ms: EMBED_BUDGET_MS, wall_ms: embed.ms, exit_code: embed.code, remaining_stale: Number.isFinite(left) ? left : null } };
  } finally {
    writeFileSync(configPath, original);
    server.stop(true);
  }
}

async function serveBoot(ctx: F4dContext): Promise<{ check: DataCheck; measured: Record<string, unknown> }> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, join(ctx.repo, 'src/cli.ts'), 'serve'],
    { env: { ...process.env, GBRAIN_HOME: ctx.home }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let stdout = '', stderr = '';
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>, append: (s: string) => void) => { for await (const chunk of stream) append(decoder.decode(chunk)); };
  const pumps = [pump(child.stdout as ReadableStream<Uint8Array>, s => { stdout += s; }), pump(child.stderr as ReadableStream<Uint8Array>, s => { stderr += s; })];
  const send = (message: unknown) => (child.stdin as { write(s: string): unknown }).write(JSON.stringify(message) + '\n');
  const answered = async (id: number, limitMs: number) => {
    const deadline = performance.now() + limitMs;
    while (performance.now() < deadline) {
      const line = stdout.split('\n').find(l => { try { return JSON.parse(l).id === id; } catch { return false; } });
      if (line) return { ms: Math.round(performance.now() - started), body: JSON.parse(line) as Record<string, unknown> };
      if (child.exitCode !== null) return null;
      await Bun.sleep(25);
    }
    return null;
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scale-f4d', version: '1' } } });
    const init = await answered(1, 180_000);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: ctx.probeToken, limit: 5 } } });
    const search = await answered(2, 180_000);
    const timedOut = stderr.includes('boot did not complete');
    const problem = timedOut ? `serve exited on its boot deadline: ${stderr.slice(-800)}`
      : !init ? `serve never answered initialize (exit ${child.exitCode}): ${stderr.slice(-800)}`
        : !search || (search.body as { error?: unknown }).error ? `serve did not answer a search after boot: ${JSON.stringify(search?.body ?? null).slice(0, 400)} ${stderr.slice(-400)}`
          : child.exitCode !== null ? `serve exited ${child.exitCode} after answering` : null;
    return { check: { check: 'f4d_serve_boot', status: problem ? 'fail' : 'pass', ...(problem ? { detail: problem } : {}) },
      measured: { initialize_ms: init?.ms ?? null, first_search_ms: search?.ms ?? null } };
  } finally {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    await child.exited;
    clearTimeout(killer);
    await Promise.allSettled(pumps);
  }
}

async function sourcesAdd20k(ctx: F4dContext): Promise<{ check: DataCheck; measured: Record<string, unknown> }> {
  const home = join(ctx.home, 'f4d-managed');
  const root = join(home, 'checkout');
  mkdirSync(root, { recursive: true });
  const brain = await ctx.freshManagedBrain();
  try {
    const init = await cli(ctx, ['init', ...brain.initArgs, '--no-embedding'], { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, home);
    if (init.code !== 0) return { check: { check: 'f4d_sources_add_20k', status: 'fail', detail: `init of the managed brain failed: ${tail(init)}` }, measured: {} };
    const t = performance.now();
    gitCheckout(root, F4D_ADD_FILES, 'add');
    const checkoutMs = Math.round(performance.now() - t);
    const add = await cli(ctx, ['sources', 'add', 'big', '--path', root], {}, home);
    const body = (() => { try { return JSON.parse(add.stdout.slice(add.stdout.indexOf('{'))) as Record<string, unknown>; } catch { return undefined; } })();
    const problem = add.stderr.includes('request_too_large') ? `sources add hit request_too_large: ${tail(add)}`
      : add.code !== 0 ? `sources add failed: ${tail(add)}`
        : body?.source_id !== 'big' || body.state !== 'committed' ? `sources add did not commit the source: ${add.stdout.slice(-600)}` : null;
    return { check: { check: 'f4d_sources_add_20k', status: problem ? 'fail' : 'pass', ...(problem ? { detail: problem } : {}) },
      measured: { files: F4D_ADD_FILES, checkout_ms: checkoutMs, add_ms: add.ms } };
  } finally {
    await brain.cleanup();
  }
}

/** Run every F4d assertion that applies at this tier; the scale brain must be closed (PGLite has one owner). */
export async function runF4dChecks(ctx: F4dContext): Promise<{ checks: DataCheck[]; measured: Record<string, Record<string, unknown>> }> {
  const checks: DataCheck[] = [];
  const measured: Record<string, Record<string, unknown>> = {};
  const steps: Array<[string, (c: F4dContext) => Promise<{ check: DataCheck; measured: Record<string, unknown> }>]> = [
    ['sync_deadline', syncDeadline], ['embed_budget_stop', embedBudgetStop], ['serve_boot', serveBoot],
    ...(ctx.pages >= F4D_ADD_MIN_PAGES ? [['sources_add_20k', sourcesAdd20k] as [string, typeof syncDeadline]] : []),
  ];
  for (const [name, step] of steps) {
    try {
      const result = await step(ctx);
      checks.push(result.check);
      measured[name] = result.measured;
    } catch (error) {
      checks.push({ check: `f4d_${name}`, status: 'fail', detail: `the assertion crashed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (ctx.pages < F4D_ADD_MIN_PAGES) measured.sources_add_20k = { skipped: `runs at ${F4D_ADD_MIN_PAGES} pages and up` };
  return { checks, measured };
}
