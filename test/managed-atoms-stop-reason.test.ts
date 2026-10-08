/**
 * #6260 on a managed brain: a clipped atoms response (stopReason length,
 * refusal or content_filter) is a failure receipt. It never publishes atoms,
 * never retires the page's earlier atoms, and the next run asks for an
 * approved retry instead of paying again; the approved retry with a complete
 * answer extracts.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); });
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); resetGateway(); });

const atomsJson = (title: string) => JSON.stringify([{ title, atom_type: 'insight', body: `Body for ${title}.` }]);

async function liveAtoms(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug");
  return rows.map((row) => row.slug);
}

for (const stop of ['length', 'refusal', 'content_filter'] as const) {
  test(`managed ${stop}: failure receipt, prior atoms kept, next run asks for an approved retry`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atom-stop-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const write = (rev: number) => engine.putPage('notes/example', { type: 'note', title: 'Example',
          compiled_truth: `A careful project record at revision ${rev}. `.repeat(40) }, { sourceId: 'default' });
        let page = await write(1);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        let calls = 0;
        let next: { text: string; stopReason: ChatResult['stopReason'] } = { text: atomsJson('Patience compounds'), stopReason: 'end' };
        const chat = async (): Promise<ChatResult> => {
          calls++;
          return { text: next.text, blocks: [], stopReason: next.stopReason,
            usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
        };
        const extract = () => runPhaseExtractAtoms(engine, { _transcripts: [],
          _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chat });

        expect((await extract()).status).toBe('ok');
        const prior = await liveAtoms();
        expect(prior).toHaveLength(1);

        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        page = await write(2);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        next = { text: '[]', stopReason: stop };
        const clipped = await extract();
        expect(clipped.status).toBe('warn');
        expect(clipped.details?.stopped_outputs).toBe(1);
        expect(calls).toBe(2);
        expect(await liveAtoms()).toEqual(prior);
        const receipt = (clipped.details?.write_requests as Array<{ request_id: string }>).at(-1)!;
        expect(receipt.request_id).toBeTruthy();

        await disposePersistenceConsumer(engine);
        const again = await extract();
        expect(calls).toBe(2);
        expect(JSON.stringify(again.details?.failures)).toContain(`stopReason=${stop}`);
        expect(JSON.stringify(again.details?.failures)).toContain('a new attempt needs approval');
        expect(await liveAtoms()).toEqual(prior);

        await disposePersistenceConsumer(engine);
        next = { text: atomsJson('Hire slowly'), stopReason: 'end' };
        __setChatTransportForTests(chat);
        const worker = new MinionWorker(engine, { queue: 'fixture' });
        await registerBuiltinHandlers(worker, engine, { quiet: true });
        const job: MinionJobContext = { id: 951, name: 'extract-atoms-drain', data: { sourceId: 'default', retryRequestId: receipt.request_id }, attempts_made: 0,
          signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
          updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] };
        const retried = await worker.getHandler('extract-atoms-drain')!(job) as Record<string, unknown>;
        expect(retried.model_rerun).toBe(true);
        expect(calls).toBe(3);
        const after = await liveAtoms();
        expect(after).toHaveLength(1);
        expect(after[0]).toContain('hire-slowly');
      });
    } finally {
      __setChatTransportForTests(null);
      await stopPersistenceConsumer(engine);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
}
