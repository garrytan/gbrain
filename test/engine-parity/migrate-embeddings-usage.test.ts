/**
 * BrainEngine parity: `gbrain retrieval-upgrade` / `gbrain migrate embeddings` with no `--to` answers the usage error first.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a run that is neither `--status` nor `--help` and names no `--to <provider:model>` exits 1 with the
 *    "Missing --to" usage line and its recovery lines on every engine, before anything reads the brain. A Rust brain
 *    still refuses a real migration typed (the store fixes its vector width at creation), but a malformed command is
 *    a usage error there too.
 *  - Regression: the Rust engine refused the command typed (engine_capability_missing) before it read the arguments, so
 *    `retrieval-upgrade --dry-run --json` printed a capability refusal on Rust and the usage error on PGLite and
 *    Postgres (census row retrieval-upgrade).
 *  - Why existing coverage misses it: the migrate-embeddings tests run on PGLite only, and the census compares the
 *    command but no test pins the order.
 *  - Seam: runMigrateEmbeddings with its injected exit; stderr through console.error.
 */
import { describe, expect, spyOn } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { runMigrateEmbeddings } from '../../src/commands/migrate-embeddings.ts';

const { parityTest } = parityArms(testBackends());

class Exited extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

describe('migrate embeddings usage', () => {
  parityTest('with no --to, a dry run exits 1 with the usage error before it reads the brain', {
    methods: ['getConfig'],
  }, async (engine) => {
    // A read every arm serves, so the case reaches the engine before the command runs.
    await engine.getConfig('version');
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    let code: number | null = null;
    try {
      await runMigrateEmbeddings(engine, ['--dry-run', '--json'], { exit: (c: number) => { throw new Exited(c); } });
    } catch (error) {
      if (!(error instanceof Exited)) throw error;
      code = error.code;
    } finally {
      spy.mockRestore();
    }
    const out = { code, usage: lines.filter(l => l.startsWith('Missing --to') || l.startsWith('Run with --help')) };
    expect(out).toEqual({
      code: 1,
      usage: ['Missing --to <provider:model>. Example: gbrain migrate embeddings --to openai:text-embedding-3-small', 'Run with --help for all flags.'],
    });
    return out;
  });
});
