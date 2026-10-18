/**
 * Bench-only instrumentation, loaded with `bun --preload` in front of src/cli.ts.
 * Product code is untouched; everything here is opt-in through env vars.
 *
 *   BENCH_USAGE_LOG=<file.jsonl>   wrap globalThis.fetch: one line per outbound call
 *                                  (host, path, status, ms, model, token usage).
 *                                  Request and response bodies are never written.
 *   BENCH_ENGINE_TIMING=<file.json> wrap every PGLiteEngine / PostgresEngine prototype
 *                                  method; on exit write calls + wall ms per method for
 *                                  outermost calls only (nested engine calls are not
 *                                  double-counted), plus process CPU and wall time.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

const T0 = performance.now();
const usageLog = process.env.BENCH_USAGE_LOG;
const timingFile = process.env.BENCH_ENGINE_TIMING;

if (usageLog) {
  const realFetch = globalThis.fetch;
  const wrapped = async function (input: any, init?: any): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let model: string | undefined;
    try {
      const body = init?.body;
      if (typeof body === 'string' && body.length < 50_000_000) model = JSON.parse(body)?.model;
    } catch { /* non-JSON body */ }
    const t0 = performance.now();
    let status = 0;
    try {
      const res = await realFetch(input, init);
      status = res.status;
      const rec: Record<string, unknown> = { host: url.host, path: url.pathname, model, status, ms: Math.round(performance.now() - t0) };
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json') && /voyageai|openai|anthropic|googleapis|typesafe/.test(url.host)) {
        try {
          const j: any = await res.clone().json();
          const u = j?.usage ?? {};
          rec.model = rec.model ?? j?.model;
          rec.input_tokens = u.input_tokens ?? u.prompt_tokens;
          rec.output_tokens = u.output_tokens ?? u.completion_tokens;
          rec.total_tokens = u.total_tokens;
        } catch { /* streamed or non-JSON */ }
      }
      appendFileSync(usageLog, JSON.stringify(rec) + '\n');
      return res;
    } catch (e) {
      appendFileSync(usageLog, JSON.stringify({ host: url.host, path: url.pathname, model, status, ms: Math.round(performance.now() - t0), error: (e as Error)?.name }) + '\n');
      throw e;
    }
  };
  globalThis.fetch = Object.assign(wrapped, realFetch) as typeof fetch;
}

if (timingFile) {
  const als = new AsyncLocalStorage<boolean>();
  const stats: Record<string, { calls: number; ms: number }> = {};
  const wrapClass = (label: string, proto: any) => {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== 'function') continue;
      const orig = desc.value;
      proto[name] = function (this: unknown, ...args: unknown[]) {
        if (als.getStore()) return orig.apply(this, args);
        const t0 = performance.now();
        const done = () => {
          const s = (stats[`${label}.${name}`] ??= { calls: 0, ms: 0 });
          s.calls++;
          s.ms += performance.now() - t0;
        };
        return als.run(true, () => {
          let out: any;
          try { out = orig.apply(this, args); } catch (e) { done(); throw e; }
          if (out && typeof out.then === 'function') return out.finally(done);
          done();
          return out;
        });
      };
    }
  };
  const { PGLiteEngine } = await import('../../../src/core/pglite-engine.ts');
  const { PostgresEngine } = await import('../../../src/core/postgres-engine.ts');
  wrapClass('pglite', PGLiteEngine.prototype);
  wrapClass('postgres', PostgresEngine.prototype);
  process.on('exit', () => {
    const cpu = process.cpuUsage();
    const rounded = Object.fromEntries(Object.entries(stats).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => [k, { calls: v.calls, ms: Math.round(v.ms) }]));
    writeFileSync(timingFile, JSON.stringify({ wall_ms: Math.round(performance.now() - T0), cpu_user_ms: Math.round(cpu.user / 1000), cpu_system_ms: Math.round(cpu.system / 1000), engine: rounded }, null, 1));
  });
}
