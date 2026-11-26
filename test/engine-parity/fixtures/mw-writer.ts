/**
 * The writer process of the multi-writer conformance cases C18 and C19 (test/engine-parity/multi-writer-conformance.test.ts). Not a
 * test: the case starts it with its configuration as JSON in MW_WRITER and reads what it prints.
 *
 *  - role `crash` (C19): writes a page and submits a job under a request key, one write after another, and prints `ACK <n>` only
 *    after both were acknowledged by the engine. The case SIGKILLs it mid-stream. Bounded by `max` acknowledgements and `deadlineMs`.
 *  - role `stress` (C18): the eight concurrent writers of this process (runStressWriters), then one `RESULT <json>` line and exit.
 *
 * Postgres: connects its own pool to the arm's database. Rust: opens the brain directory it is given (the case gives it a brain no
 * other engine has open, so this process is the owner).
 */
import type { BrainEngine } from '../../../src/core/engine.ts';
import { admitKeyed, crashBody, crashKey, crashSlug, runStressWriters, type StressReport, type WriterConfig } from '../multi-writer-support.ts';

const config = JSON.parse(process.env.MW_WRITER ?? 'null') as WriterConfig | null;
if (!config) throw new Error('mw-writer: MW_WRITER is not set');

async function connect(c: WriterConfig): Promise<BrainEngine> {
  if (c.backend === 'postgres') {
    const { PostgresEngine } = await import('../../../src/core/postgres-engine.ts');
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: c.databaseUrl!, poolSize: 4 } as never);
    return engine;
  }
  // The preload of a bun process strips GBRAIN_* from the environment, so the multi-user switch is set here, before the open.
  if (c.muRoute === 'env') process.env.GBRAIN_RUST_MULTIUSER = '1';
  // The commit log is on for the whole rust-mu view (both routes); a brain that keeps a log must be written with it on.
  if (c.muRoute !== undefined) process.env.GBRAIN_RUST_COMMIT_LOG = '1';
  const { openRustBrainAt, resolvedMultiuser } = await import('../rust-arm.ts');
  // With a route the open asserts, and fails on, a store that did not resolve multi-user mode (assertRustMultiuserResolved).
  const engine = await openRustBrainAt(c.databasePath!, c.muRoute);
  // Plain Rust: the writer's store must not be multi-user either.
  const resolved = resolvedMultiuser(engine);
  if (c.muRoute === undefined && resolved === true) {
    await engine.disconnect().catch(() => undefined);
    throw new Error('mw-writer: the store resolved multi-user mode for a plain Rust brain');
  }
  process.stdout.write(`RESOLVED ${String(resolved)}\n`);
  return engine as unknown as BrainEngine;
}

const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

async function crash(engine: BrainEngine, c: WriterConfig): Promise<void> {
  const end = Date.now() + c.deadlineMs;
  for (let n = 0; n < (c.max ?? 1000) && Date.now() < end; n++) {
    await engine.putPage(crashSlug(n), note(`N${n}`, crashBody(n)));
    await admitKeyed(engine, crashKey(n));
    process.stdout.write(`ACK ${n}\n`);
  }
}

async function stress(engine: BrainEngine, c: WriterConfig): Promise<void> {
  const startedAt = Date.now();
  const results = await runStressWriters(engine, c.index ?? 0);
  const report: StressReport = { results, startedAt, finishedAt: Date.now() };
  process.stdout.write(`RESULT ${JSON.stringify(report)}\n`);
}

/** Waits for the parent's start barrier (`GO` on stdin). */
async function awaitGo(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  let seen = '';
  while (!seen.includes('GO')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('mw-writer: stdin closed before GO');
    seen += new TextDecoder().decode(value);
  }
}

const engine = await connect(config);
process.stdout.write('READY\n');
try {
  if (config.startOnGo) await awaitGo();
  if (config.role === 'crash') await crash(engine, config); else await stress(engine, config);
} finally {
  await engine.disconnect().catch(() => undefined);
}
process.exit(0);
