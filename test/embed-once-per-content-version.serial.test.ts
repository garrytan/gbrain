/**
 * PR 4 E (gbrain-evals#180, N14): a chunk's text goes to the embedder once per content version.
 *
 * 1. Protects: the post-write embedding effect and a concurrent `gbrain embed --stale` drain never both send the same
 *    chunk to the provider. Whichever path reaches a page first holds its embedding lease (page-embedding-lease.ts)
 *    through its install; the other waits, reads again and finds nothing left to embed. Embedder inputs equal the
 *    page's new (vector-less) chunks, each sent once.
 * 2. Fails when: either path reads "no vector" as "mine to embed" with no regard for a provider call in flight. The
 *    forced probes hold the first provider call at the transport until the other path calls the provider too, finds
 *    the lease held, or finishes, so the doubled input N14 saw intermittently on Postgres (5 of 23 runs) happens every
 *    run: effect first on a segmented page after append_page (the N14 path), drain first on an inline page.
 * 3. The provider is the gateway's transport seam: no network, no spend. PGLite always; PostgreSQL when DATABASE_URL is
 *    set (test/postgres-unit-arms.txt). Serial: the gateway transport and the lease probe are process-wide.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationBody, conversationPage } from './helpers/conversation-page.ts';
import { openAppendBrain, type AppendBrain } from './helpers/append-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../src/core/search/embedding-column.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { pageEmbeddingLeaseProbe } from '../src/core/page-embedding-lease.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { pendingEmbedPage } from './helpers/pending-embed-page.ts';

/** Marks the drain's provider calls; every other call comes from an embedding effect. */
const drainScope = new AsyncLocalStorage<true>();
type Path = 'effect' | 'drain';

/**
 * Records every provider input with the path that sent it and holds the first call until `release`: the other path
 * calling the provider, finding the page's lease held, or the test, once the other path has finished.
 */
class Gate {
  inputs: Array<{ by: Path; text: string }> = [];
  holder: Path | undefined;
  release!: () => void;
  readonly released = new Promise<void>(resolve => { this.release = resolve; });
  private arrive!: (by: Path) => void;
  readonly arrived = new Promise<Path>(resolve => { this.arrive = resolve; });
  async observe(values: string[]): Promise<void> {
    const by: Path = drainScope.getStore() ? 'drain' : 'effect';
    for (const text of values) this.inputs.push({ by, text });
    if (this.holder === undefined) { this.holder = by; this.arrive(by); await this.released; }
    else if (this.holder !== by) this.release();
  }
}
let gate: Gate | null = null;

async function withGate(run: (gate: Gate) => Promise<void>): Promise<void> {
  const g = gate = new Gate();
  pageEmbeddingLeaseProbe.contended = () => g.release();
  try { await run(g); } finally {
    g.release();
    gate = null;
    pageEmbeddingLeaseProbe.contended = undefined;
  }
}

/** Every provider input matched to one of `chunks` (an input carries its chunk text last); returns the inputs left over. */
function beyondOnePerChunk(inputs: string[], chunks: string[]): string[] {
  const left = [...inputs];
  for (const text of chunks) {
    const at = left.findIndex(input => input.endsWith(text));
    if (at >= 0) left.splice(at, 1);
  }
  return left;
}

async function openBrain(kind: 'pglite' | 'postgres'): Promise<AppendBrain> {
  const brain = await openAppendBrain(kind);
  const dims = (await resolveActiveEmbeddingColumnFromEngine(brain.engine)).dimensions;
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    await gate?.observe(values);
    return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
  }) as never);
  return brain;
}

/** The page's live chunks without a vector (these brains use the default \`embedding\` column). */
async function vectorless(brain: AppendBrain, sourceId: string, slug: string): Promise<string[]> {
  return (await brain.engine.executeRaw<{ chunk_text: string }>(
    `SELECT cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE p.source_id=$1 AND p.slug=$2 AND cc.embedding IS NULL AND ${chunkGenerationFilter('p', 'cc')} ORDER BY cc.chunk_index`, [sourceId, slug])).map(r => r.chunk_text);
}

const drain = (brain: AppendBrain) => drainScope.run(true, () => runEmbedCore(brain.engine, { stale: true, catchUp: true, quiet: true }));

for (const kind of testBackends()) {
  describe(`one provider call per chunk content version, effect first on a segmented page (${kind})`, () => {
    const SLUG = 'notes/embed-once-segmented';
    let brain: AppendBrain;
    const effectsSettled = async () => (await brain.engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM persistence_effects WHERE kind='embedding' AND state IN ('queued','running')"))[0]!.n === 0;

    beforeAll(async () => {
      brain = await openBrain(kind);
      await brain.seed(SLUG, conversationPage(1_200_000, { seed: 7 }));
      expect((await brain.body(SLUG)).storage).toBe('segmented');
      await runEmbedCore(brain.engine, { stale: true, catchUp: true, quiet: true });
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('forced probe: the append effect holds its provider call while a stale drain runs; each new chunk is sent once', () => withGate(async g => {
      const appended = await brain.call('append_page', { slug: SLUG, text: conversationBody(2_000, { seed: 8 }), request_id: randomUUID() });
      expect(appended).toMatchObject({ isError: false });
      expect(await g.arrived).toBe('effect');
      // The effect's call is held before its install: these are the chunks this content version adds.
      const fresh = await vectorless(brain, 'default', SLUG);
      const drained = await drain(brain);
      g.release();
      await waitFor(effectsSettled, { timeoutMs: 30_000, label: 'the append embedding effect to settle' });
      const sent = g.inputs.map(i => i.text);
      const extra = beyondOnePerChunk(sent, fresh);
      console.log(`[probe effect-first ${kind}] new chunks=${fresh.length} provider inputs=${sent.length} by=${JSON.stringify(g.inputs.map(i => i.by))}`
        + ` drain.embedded=${drained.embedded} inputs beyond one per new chunk=${extra.length}`);
      expect(fresh.length).toBeGreaterThan(0);
      expect(await vectorless(brain, 'default', SLUG)).toEqual([]);
      expect(extra.length, 'provider inputs beyond one per new chunk').toBe(0);
      expect(sent.length).toBe(fresh.length);
    }), 600_000);
  });

  describe(`one provider call per chunk content version, drain first on an inline page (${kind})`, () => {
    let brain: AppendBrain;
    let home: string;
    const CHUNKS = ['Alpha example chunk about the acme-example ledger.', 'Beta example chunk about the quarterly report.', 'Gamma example chunk about the roadmap.'];

    beforeAll(async () => {
      brain = await openBrain(kind);
      home = mkdtempSync(join(tmpdir(), 'gbrain-embed-once-'));
    }, 600_000);
    afterAll(async () => {
      await brain.close();
      rmSync(home, { recursive: true, force: true });
    }, 120_000);

    test('forced probe: a stale drain holds its provider call while the page\'s embedding effect runs; each chunk is sent once', () => withEnv({ GBRAIN_HOME: home }, () => withGate(async g => {
      const engine = brain.engine;
      const { sourceId, effectId } = await pendingEmbedPage(engine, CHUNKS);
      const fresh = await vectorless(brain, sourceId, 'page');
      expect(fresh).toEqual(CHUNKS);
      const drained = drain(brain);
      expect(await g.arrived).toBe('drain');
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [effectId]);
      await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 1 });
      const result = await drained;
      const [effect] = await engine.executeRaw<{ state: string; error_code: string | null }>('SELECT state,error_code FROM persistence_effects WHERE id=$1', [effectId]);
      const sent = g.inputs.map(i => i.text);
      const extra = beyondOnePerChunk(sent, fresh);
      console.log(`[probe drain-first ${kind}] new chunks=${fresh.length} provider inputs=${sent.length} by=${JSON.stringify(g.inputs.map(i => i.by))}`
        + ` drain.embedded=${result.embedded} effect=${effect!.state}/${effect!.error_code} inputs beyond one per new chunk=${extra.length}`);
      expect(await vectorless(brain, sourceId, 'page')).toEqual([]);
      expect(effect).toMatchObject({ state: 'committed' });
      expect(extra.length, 'provider inputs beyond one per new chunk').toBe(0);
      expect(sent.length).toBe(fresh.length);
    })), 600_000);
  });
}
