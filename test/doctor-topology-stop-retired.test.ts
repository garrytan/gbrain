/**
 * The doctor and `sources writer status` surfaces carry no topology recovery stop, on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain doctor --json` has no `topology_recovery_stopped` check and the human doctor output has no row
 *    for it, on PGLite, on Postgres (with DATABASE_URL) and on the Rust engine (with GBRAIN_TEST_RUST_ARM=1). On every
 *    engine that prints `sources writer status --json`, the payload has no `topology_recoveries` key. Master never had
 *    either surface, so the CLI and JSON output stay byte-identical with it.
 *  - Regression: a branch added the doctor check and the writer status key for a Rust-only recovery stop. Both
 *    reached PGLite and Postgres readers too; this file failed on every engine while they existed.
 *  - Why existing coverage misses it: the doctor goldens run on PGLite and Postgres only, and they were regenerated
 *    with the check in them. The parity harness cannot hold the Rust doctor run, because each doctor check that reads
 *    raw SQL catches a typed refusal and reports the check as unknown.
 *  - Seam: none. Each engine is a real brain with a registered checkout; the doctor runs through `runDoctor`, the
 *    function the CLI calls, with its stdout captured. On the Rust engine `writer status` stops on a typed refusal
 *    before it prints (persistence/effect-catchup.ts `readStalledCatchups`); that stop is asserted, not skipped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isCapabilityMissing } from '../src/core/rust-engine/errors.ts';
import { createSource, type ParityBackend } from './engine-parity/harness.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends: ParityBackend[] = [...testBackends(), ...(rustArmRequested() ? ['rust' as const] : [])];

async function openEngine(backend: ParityBackend): Promise<{ engine: BrainEngine; close: () => Promise<void> }> {
  if (backend === 'rust') {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    return { engine, close: async () => { await engine.disconnect(); removeBrainDir(brain.dir); } };
  }
  if (backend === 'postgres') {
    const { engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    return { engine, close };
  }
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  return { engine, close: () => engine.disconnect() };
}

/** Everything `run` printed to stdout. */
async function stdoutOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  const exitCode = process.exitCode;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await run(); } finally {
    console.log = log;
    process.stdout.write = write;
    process.exitCode = exitCode;
  }
  return lines.join('\n');
}

/** Runs `run` on a fresh brain of `backend` with a plain checkout registered and claimed as source `work`. */
async function withClaimedCheckout<T>(backend: ParityBackend, run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const { engine, close } = await openEngine(backend);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-topology-retired-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      await Bun.write(join(root, 'example.md'), 'generic example');
      await createSource(engine, backend, 'work', {}, root);
      await runPersistenceAdministration(engine, 'writer_claim', {
        source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
      try { return await run(engine); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('the retired topology recovery stop has no doctor or writer status surface', () => {
  let lastProcessExit: typeof process.exitCode;
  afterEach(() => { process.exitCode = lastProcessExit; });

  for (const backend of backends) {
    test(`[${backend}] doctor --json and the human doctor output carry no topology_recovery_stopped check`, async () => {
      lastProcessExit = process.exitCode;
      const surface = await withClaimedCheckout(backend, async (engine) => {
        const json = await stdoutOf(() => runDoctor(engine, ['--json', '--scope=brain']));
        const human = await stdoutOf(() => runDoctor(engine, ['--scope=brain']));
        const report = JSON.parse(json.slice(json.indexOf('{'))) as { checks: { name: string }[] };
        return {
          ran: report.checks.length > 0 && human.includes('['),
          json_check: report.checks.some(check => check.name === 'topology_recovery_stopped'),
          json_text: json.includes('topology_recovery_stopped'),
          human_row: human.includes('topology_recovery_stopped'),
        };
      });
      expect(surface).toEqual({ ran: true, json_check: false, json_text: false, human_row: false });
    }, 180_000);

    test(`[${backend}] sources writer status --json has no topology_recoveries key`, async () => {
      lastProcessExit = process.exitCode;
      const outcome = await withClaimedCheckout(backend, async (engine) => {
        const status = await runPersistenceAdministration(engine, 'writer_status', {}).then(
          (value) => ({ value: value as Record<string, unknown> }), (error: unknown) => ({ error }));
        if ('error' in status) return { printed: false, typed_refusal: isCapabilityMissing(status.error), key: false };
        return { printed: true, typed_refusal: false, key: 'topology_recoveries' in status.value };
      });
      // The Rust engine stops on the typed refusal of `readStalledCatchups` before it prints anything.
      expect(outcome).toEqual(backend === 'rust'
        ? { printed: false, typed_refusal: true, key: false }
        : { printed: true, typed_refusal: false, key: false });
    }, 60_000);
  }
});
