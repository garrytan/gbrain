/**
 * The "CLI" side of the pipe-at-exit test (test/helpers/shadow-write-compare-scenarios.ts): a process that attaches the shadow supervisor to a real engine,
 * sends many write samples to a slow-reading shadow child (test/helpers/shadow-pipe-exit-child.ts) through the real pipe, disconnects the engine and exits at once, as a short CLI command does.
 * Prints one JSON line: how many samples the supervisor accepted and how many it refused (the sampler counts a refusal itself, `send_shed`).
 * Env: KIND (pglite|postgres), DATABASE_URL (postgres), DIR (shadow dir), READER_SLEEP (seconds the child waits before it reads), DONE (file the child writes when it has finished), N, LINE_BYTES, DRAIN_MS.
 */
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { attachShadowParts } from '../../src/shadow/attach.ts';

const env = process.env as Record<string, string>;
const dir = env.DIR!; const n = Number(env.N); const lineBytes = Number(env.LINE_BYTES);
const engine = env.KIND === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(env.KIND === 'postgres' ? { database_url: env.DATABASE_URL, poolSize: 2 } : {} as never);
const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: env.KIND };
const parts = attachShadowParts(engine as never, dir, state as never, {
  gbrainArgv: [process.execPath, join(import.meta.dir, 'shadow-pipe-exit-child.ts')],
  supervisor: { stateCheckMs: 1e12, ...(env.DRAIN_MS ? { drainMs: Number(env.DRAIN_MS) } : {}) } as never,
});
let refused = 0;
for (let i = 0; i < n; i++) {
  const head = `{"t":"write","op":"putPage","i":${i},"pad":"`; const tail = '"}\n';
  const line = head + 'x'.repeat(Math.max(0, lineBytes - head.length - tail.length)) + tail;
  if (!parts.supervisor.send(line)) refused++;
}
await engine.disconnect(); // the registered disconnect hook runs here
console.log(JSON.stringify({ sent: n - refused, refused }));
process.exit(0);
