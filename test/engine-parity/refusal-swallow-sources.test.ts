/**
 * BrainEngine parity: four source-existence probes that ran caller SQL inside a catch with a default (lane 8's
 * refusal-swallow triage, rule capability_refusal_swallowed). Each now reads `listAllSources`, so a Rust brain answers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm, `edges-backfill --all-sources` walks every live source in byte order; code-scope's
 *    `--source` check, bootstrap verify's registration probe and the stdio MCP source preflight answer from the sources
 *    the brain holds (live, archived, missing) the same way PGLite does.
 *  - Regression: on a Rust brain the raw statement was refused and the catch answered a default: edges-backfill walked
 *    only `default`, code-scope and verify said every source exists, and the preflight let a phantom GBRAIN_SOURCE serve.
 *  - Why existing coverage misses it: the four probes ran through `executeRaw`, and their tests run on PGLite only.
 *  - Seam: none. Real engines; sources are made with the harness fixtures (createSource, archiveSource).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runEdgesBackfill } from '../../src/commands/edges-backfill.ts';
import { sourceExists } from '../../src/commands/code-scope.ts';
import { verifySourceRegistered } from '../../src/core/bootstrap/verify.ts';
import { assertStdioSourceBindable } from '../../src/mcp/source-preflight.ts';
import { archiveSource, createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** Two live sources besides `default` (`b-z` before `ba` in byte order) and an archived one. */
async function seedSources(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  for (const id of ['ba', 'b-z', 'old']) await createSource(engine, backend, id);
  await archiveSource(engine, backend, 'old');
}

/** What a call printed to stdout and stderr, and how it ended. */
async function captured(run: () => Promise<unknown>): Promise<{ out: string; err: string; threw: string | null }> {
  const out: string[] = [], err: string[] = [];
  const log = console.log, write = process.stderr.write.bind(process.stderr), print = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  (process.stdout as { write: unknown }).write = (s: string | Uint8Array) => { out.push(String(s)); return true; };
  (process.stderr as { write: unknown }).write = (s: string | Uint8Array) => { err.push(String(s)); return true; };
  let threw: string | null = null;
  try { await run(); } catch (e) { threw = (e as { code?: string }).code ?? String((e as Error).message); }
  finally { console.log = log; (process.stdout as { write: unknown }).write = print; (process.stderr as { write: unknown }).write = write; }
  return { out: out.join('\n'), err: err.join(''), threw };
}

describe('refusal-swallow source probes', () => {
  parityTest('edges-backfill.ts:94 --all-sources walks every live source in byte order', { methods: ['listAllSources'] }, async (engine, backend) => {
    await seedSources(engine, backend);
    const run = await captured(() => runEdgesBackfill(engine, ['--all-sources', '--json']));
    expect(run.threw).toBeNull();
    const summary = (JSON.parse(run.out) as { summary: Array<{ source_id: string; chunks_walked: number; edges_resolved: number }> }).summary;
    return summary.map(s => ({ source_id: s.source_id, chunks_walked: s.chunks_walked, edges_resolved: s.edges_resolved }));
  });

  parityTest('code-scope.ts:226 an explicit --source exists only when a live source holds it', { methods: ['listAllSources'] }, async (engine, backend) => {
    await seedSources(engine, backend);
    return { default: await sourceExists(engine, 'default'), live: await sourceExists(engine, 'ba'),
      archived: await sourceExists(engine, 'old'), missing: await sourceExists(engine, 'ghost') };
  });

  parityTest('verify.ts:1212 the registration probe reads registered sources, archived ones included', { methods: ['listAllSources'] }, async (engine, backend) => {
    await seedSources(engine, backend);
    return { live: await verifySourceRegistered(engine, 'ba'), archived: await verifySourceRegistered(engine, 'old'),
      missing: await verifySourceRegistered(engine, 'ghost') };
  });

  parityTest('source-preflight.ts:51 GBRAIN_SOURCE must name a live source', { methods: ['listAllSources'] }, async (engine, backend) => {
    await seedSources(engine, backend);
    const outcome = async (env: string) => {
      const run = await captured(() => assertStdioSourceBindable(engine, env));
      return { threw: run.threw, skipped: run.err.includes('preflight skipped') };
    };
    return { live: await outcome('ba'), archived: await outcome('old'), missing: await outcome('ghost') };
  });
});
