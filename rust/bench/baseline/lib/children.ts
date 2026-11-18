/**
 * Child-process side and parent-side helpers for the metrics that need a separate process:
 * cold_open (fresh process), crash_recovery (writer that gets SIGKILL) and second_process (a second opener).
 * The parent re-runs `run.ts` with BAKEOFF_CHILD_SPEC in the environment; the child prints one JSON line per event.
 */
import { resolve } from 'node:path';
import { openEngine, type StoreSpec } from './store.ts';
import { makeRng } from './stats.ts';
import { writePage, type PageSpec } from './write-path.ts';
import { stripSecretsFromEnv } from './sys.ts';
import { loadCorpus } from './corpus.ts';
import { loadOrComputeTruth } from './truth.ts';

export type ChildSpec =
  | { kind: 'cold-open'; store: StoreSpec; slug: string; sourceId: string }
  | { kind: 'open-probe'; store: StoreSpec; slug: string; sourceId: string }
  | { kind: 'crash-writer'; store: StoreSpec; nonce: string; dims: number }
  | { kind: 'truth'; corpusDir: string; pageLimit?: number; needed: number };

const RUN_TS = resolve(import.meta.dir, '../run.ts');

const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + '\n');

function describeError(error: unknown): { name: string; message: string; code?: string } {
  const e = error as { name?: string; message?: string; code?: string; reason?: string };
  return { name: e?.name ?? 'Error', message: String(e?.message ?? error).split('\n')[0]!.slice(0, 300), code: e?.code ?? e?.reason };
}

function randomUnit(rng: () => number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  let norm = 0;
  for (let d = 0; d < dims; d++) {
    const x = (rng() + rng() + rng() - 1.5);
    v[d] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  for (let d = 0; d < dims; d++) v[d] = v[d]! / norm;
  return v;
}

/** Entry point when run.ts is started with --child. */
export async function childMain(): Promise<void> {
  const spec = JSON.parse(process.env.BAKEOFF_CHILD_SPEC ?? 'null') as ChildSpec | null;
  if (!spec) throw new Error('BAKEOFF_CHILD_SPEC missing');
  if (spec.kind === 'cold-open' || spec.kind === 'open-probe') {
    const t0 = performance.now();
    try {
      const engine = await openEngine(spec.store);
      const t1 = performance.now();
      const page = await engine.getPage(spec.slug, { sourceId: spec.sourceId });
      const t2 = performance.now();
      emit({ ok: true, found: page !== null, connect_ms: t1 - t0, first_get_ms: t2 - t1, ms: t2 - t0 });
      await engine.disconnect();
    } catch (error) {
      emit({ ok: false, ms: performance.now() - t0, ...describeError(error) });
    }
    process.exit(0);
  }
  if (spec.kind === 'truth') {
    // Exact ground truth is computed in its own process so its copy of the corpus never counts toward the engine's peak RSS.
    const corpus = await loadCorpus(spec.corpusDir, spec.pageLimit);
    const truth = await loadOrComputeTruth(corpus, spec.needed, spec.pageLimit === undefined);
    emit({ top10: truth.top10.slice(0, spec.needed), source: truth.source, compute_seconds: truth.computeSeconds ?? null, persisted: truth.persisted });
    process.exit(0);
  }
  if (spec.kind === 'crash-writer') {
    const engine = await openEngine(spec.store);
    const rng = makeRng(0xc0ffee);
    emit({ ready: true });
    for (let i = 0; ; i++) {
      const slug = `bench/crash-${spec.nonce}-${i}`;
      const page: PageSpec = {
        slug, sourceId: 'default', type: 'note', title: `Crash page ${i}`, frontmatter: { crash: spec.nonce },
        body: `# Crash page ${i}\n\n${'crash recovery payload '.repeat(20)}`,
        chunks: Array.from({ length: 4 }, (_, k) => ({ text: `crash ${spec.nonce} ${i} chunk ${k}`, vector: randomUnit(rng, spec.dims) })),
      };
      await writePage(engine, page);
      emit({ ack: slug }); // printed only after the commit returned
    }
  }
}

export interface ChildRun { code: number | null; stdout: string; stderr: string; wallMs: number; timedOut: boolean }

export function childEnv(spec: ChildSpec): Record<string, string> {
  const env = stripSecretsFromEnv(process.env) as Record<string, string>;
  env.BAKEOFF_CHILD_SPEC = JSON.stringify(spec);
  return env;
}

/** Run a child to completion (or kill it at the timeout). */
export async function runChild(spec: ChildSpec, timeoutMs: number): Promise<ChildRun> {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, RUN_TS, '--child'], { env: childEnv(spec), stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr, wallMs: performance.now() - started, timedOut };
}

export function lastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]!) as Record<string, unknown>; } catch { /* partial line */ }
  }
  return null;
}

/** Start the crash writer, collect its acknowledgements until `killAfterMs` after it is ready, then SIGKILL it. */
export async function runCrashWriter(spec: ChildSpec, killAfterMs: number, startTimeoutMs: number): Promise<{ acked: string[]; ready: boolean; stderr: string }> {
  const proc = Bun.spawn([process.execPath, RUN_TS, '--child'], { env: childEnv(spec), stdout: 'pipe', stderr: 'pipe' });
  const acked: string[] = [];
  let ready = false;
  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const startTimer = setTimeout(() => { if (!ready) { killed = true; proc.kill('SIGKILL'); } }, startTimeoutMs);
  const stderrPromise = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const ev = JSON.parse(line) as { ready?: boolean; ack?: string };
        if (ev.ready && !ready) {
          ready = true;
          clearTimeout(startTimer);
          killTimer = setTimeout(() => { killed = true; proc.kill('SIGKILL'); }, killAfterMs);
        } else if (ev.ack) {
          acked.push(ev.ack);
        }
      } catch { /* partial or foreign line */ }
    }
  }
  await proc.exited;
  clearTimeout(startTimer);
  if (killTimer) clearTimeout(killTimer);
  return { acked, ready, stderr: (await stderrPromise).slice(-500) };
}
