import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { managedAtomCompletedSql, managedAtomSession } from '../src/core/persistence/atom-maintenance.ts';
import * as atomMaintenance from '../src/core/persistence/atom-maintenance.ts';
import { retryManagedAtomBatch } from '../src/core/persistence/atom-retry.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

for (const backend of testBackends()) {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-failed-atom-backlog-'));
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    if (backend === 'postgres') {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine; close = pg.close;
    } else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
      close = () => engine.disconnect();
    }
    await engine.setConfig('sync.write_through', 'false');
    await engine.setConfig('cycle.extract_atoms.page_discovery_budget', '1');
    await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
  }, 120_000);
  afterAll(async () => {
    __setChatTransportForTests(null);
    await disposePersistenceConsumer(engine); await close(); resetGateway();
    rmSync(home, { recursive: true, force: true });
  });

  test(`${backend}: terminal malformed transcript is skipped by exact path, source incarnation and full hash`, async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      const sourceId = `failed-transcript-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const filePath = join(home, `${sourceId}.txt`);
      let content = 'A transcript with an extraction that needs explicit approval to retry. '.repeat(30);
      writeFileSync(filePath, content);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      let reply = 'not JSON';
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: reply, blocks: [], stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const extract = (path = filePath, id = sourceId) => runPhaseExtractAtoms(engine, { sourceId: id, _pages: [],
        _transcripts: [{ filePath: path, content, contentHash: sha256(content) }], _chat: chat });
      const first = await extract();
      expect(first.status).toBe('warn');
      await disposePersistenceConsumer(engine);
      const again = await extract();
      expect(again.details?.duplicates_skipped).toBe(1);
      expect(again.details?.failures).toEqual([]);
      expect(calls).toBe(1);
      const receipt = (first.details?.write_requests as Array<{ request_id: string }>).at(-1)!;
      reply = '[]';
      __setChatTransportForTests(chat);
      expect(await retryManagedAtomBatch(engine, sourceId, receipt.request_id, 'approved-transcript-retry')).toMatchObject({ model_rerun: true });
      expect(calls).toBe(2);
      expect((await extract()).details?.duplicates_skipped).toBe(1);
      expect(calls).toBe(2);
      reply = 'not JSON';
      const otherPath = join(home, `${sourceId}-other.txt`);
      writeFileSync(otherPath, content);
      await extract(otherPath);
      expect(calls).toBe(3);
      await disposePersistenceConsumer(engine);
      content = 'Edited transcript content must be eligible for extraction again. '.repeat(30);
      writeFileSync(filePath, content);
      await extract();
      expect(calls).toBe(4);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const otherSource = `other-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [otherSource]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await extract(filePath, otherSource);
      expect(calls).toBe(5);
      await disposePersistenceConsumer(engine);
      const session = (await managedAtomSession(engine, sourceId))!;
      const transcript = { filePath, contentHash: sha256(content) };
      expect((await atomMaintenance.settledManagedAtomTranscriptKeys(engine, session, [transcript])).size).toBe(1);
      expect((await atomMaintenance.settledManagedAtomTranscriptKeys(engine, { ...session, incarnation: randomUUID() }, [transcript])).size).toBe(0);
      // A matching 16-character prefix is insufficient for managed completion coverage.
      expect((await atomMaintenance.settledManagedAtomTranscriptKeys(engine, session, [{ ...transcript,
        contentHash: transcript.contentHash.slice(0, 16) + '0'.repeat(48) }])).size).toBe(0);
    });
  }, 120_000);

  test(`${backend}: terminal malformed receipt cannot starve a healthy page or become successful replacement evidence`, async () => {
    await withEnv({ GBRAIN_HOME: home, ANTHROPIC_API_KEY: 'fixture-only-not-a-key' }, async () => {
      const sourceId = `failed-atoms-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const page = await engine.putPage('notes/bad', { type: 'note', title: 'Bad output', compiled_truth: 'A careful project record with a malformed extraction. '.repeat(30) }, { sourceId });
      await engine.putPage('notes/good', { type: 'note', title: 'Good output', compiled_truth: 'Another project record ready for a healthy extraction. '.repeat(30) }, { sourceId });
      // Force the failed page to consume the sole discovery slot on every old-code drain.
      await engine.executeRaw("UPDATE pages SET updated_at='2099-01-01' WHERE id=$1", [page.id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: calls === 1 ? 'not extraction JSON' : '[]', blocks: [], stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const first = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [], _chat: chat });
      expect(first.status).toBe('warn');
      expect(calls).toBe(1);
      const receipt = (first.details?.write_requests as Array<{ request_id: string }>).at(-1)!;
      await disposePersistenceConsumer(engine);
      const original = await engine.executeRaw('SELECT state,outcome FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
      expect(original).toMatchObject([{ state: 'committed', outcome: { status: 'failed' } }]);
      expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
      expect(await countExtractAtomsBacklog(engine)).toBe(1);
      expect((await discoverExtractablePages(engine, sourceId, undefined, 1)).map(p => p.slug)).toEqual(['notes/good']);
      // Discovery may treat a failure as settled; stale-atom repair must not treat it as a replacement.
      expect(await engine.executeRaw(`SELECT ac.fingerprint FROM op_checkpoints ac WHERE ${managedAtomCompletedSql({
        sourceId: '$1', slug: '$2', pageId: '$3', contentHash: '$4',
      })}`, [sourceId, page.slug, page.id, page.content_hash])).toEqual([]);
      __setChatTransportForTests(chat);
      const drain = await runExtractAtomsDrainForSource(engine, { sourceId, windowSeconds: 30, maxBatches: 3 });
      expect(drain).toMatchObject({ status: 'ok', stopped: 'drained', remaining: 0, failure_count: 0 });
      expect(calls).toBe(2);
      // No automatic paid retry, and the failed receipt remains inspectable and unchanged.
      expect((await runExtractAtomsDrainForSource(engine, { sourceId, windowSeconds: 30 })).batches).toBe(0);
      expect(calls).toBe(2);
      expect(await engine.executeRaw('SELECT state,outcome FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id])).toEqual(original);
      expect(await retryManagedAtomBatch(engine, sourceId, receipt.request_id, 'approved-retry')).toMatchObject({ model_rerun: true });
      expect(calls).toBe(3);
      expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
      // A content edit is fresh work, not suppressed by the retained failed checkpoint.
      await disposePersistenceConsumer(engine);
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
        await tx.putPage(page.slug, { type: 'note', title: 'Edited output', compiled_truth: 'New content with a fresh extraction opportunity. '.repeat(30) }, { sourceId });
      }, TEST_WRITE_ATTRIBUTION));
      expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
      expect((await discoverExtractablePages(engine, sourceId)).map(p => p.slug)).toEqual([page.slug]);
    });
  }, 120_000);
}
