import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runFactsBackstop } from '../../src/core/facts/backstop.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimNextWrite, compactWriteReceipts } from '../../src/core/persistence/journal.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { prepareManagedFactsMutation } from '../../src/core/persistence/facts-prepare.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { withEnv } from './with-env.ts';

export const factCompactionCases = ['explicit_failed', 'derived_failed', 'explicit_partial', 'derived_partial', 'explicit_success', 'derived_success'] as const;
type Case = typeof factCompactionCases[number];

export async function exerciseFactCompaction(engine: BrainEngine, scenario: Case): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-fact-compaction-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const sourceId = `compact-${randomUUID()}`;
      const config = { engine: engine.kind, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 };
      configureGateway({ ...config, env: { OPENAI_API_KEY: 'test' } });
      await engine.setConfig('embedding_model', config.embedding_model);
      await engine.setConfig('embedding_dimensions', '1536');
      await engine.setConfig('embedding_disabled', 'false');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slugs = ['people/first-example', 'people/second-example'];
      const root = join(home, 'repo');
      mkdirSync(join(root, 'people'), { recursive: true });
      for (const slug of slugs) {
        await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: 'A registered synthetic entity.' }, { sourceId });
        writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown((await engine.getPage(slug, { sourceId }))!, []));
      }
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
      await registerLocalWriter(engine, 'cli');
      const binding = await claimWorktree(engine, sourceId, root);
      const ctx: OperationContext = { engine, config, remote: false, sourceId, dryRun: false, logger: console };
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => [1, ...Array(1535).fill(0)]) })) as never);
      const text = 'A synthetic meeting records preferences for weekly written reports and monthly planning discussions. '.repeat(5);
      const original = await operationsByName.put_page.handler(ctx, { slug: 'meetings/example',
        content: `---\ntype: meeting\ntitle: Example meeting\n---\n\n${text}`, request_id: randomUUID() }) as { request_id: string };
      await disposePersistenceConsumer(engine);
      const [origin] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid', [sourceId, original.request_id]);
      const snapshot = (await engine.readPageSnapshot('meetings/example', { sourceId }))!;
      let generations = 0;
      let embeddings = 0;
      __setChatTransportForTests(async () => {
        generations++;
        await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
        return { text: JSON.stringify({ facts: slugs.map((slug, i) => ({ fact: `Example ${i + 1} prefers weekly written reports.`,
          entity: slug, kind: 'preference', confidence: 1, notability: 'high' })) }), blocks: [], stopReason: 'end',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
      });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        embeddings++;
        return { embeddings: values.map(() => [1, ...Array(1535).fill(0)]) };
      }) as never);
      const params = { turn_text: snapshot.page.compiled_truth, request_id: randomUUID() };
      const run = () => scenario.startsWith('explicit') ? operationsByName.extract_facts.handler(ctx, params)
        : runFactsBackstop({ slug: snapshot.page.slug, type: 'meeting', compiled_truth: snapshot.page.compiled_truth, frontmatter: {} },
          { engine, config, sourceId, sessionId: 'fixture', source: 'mcp:put_page', mode: 'inline', persistenceRequestId: origin.id });
      await expect(run()).rejects.toMatchObject({ code: 'write_pending' });
      await disposePersistenceConsumer(engine);
      expect(generations).toBe(1);
      expect(embeddings).toBe(2);
      await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
      for (let i = 0; i < 3; i++) {
        const row = (await claimNextWrite(engine, localHostId()))!;
        expect(row.operation).toBe('extract_facts');
        const prepared = await prepareManagedFactsMutation(engine, row, config);
        const shouldConflict = i < 2 && (scenario.endsWith('_failed') || scenario.endsWith('_partial') && i === 1);
        if (shouldConflict) await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [sourceId, row.slug]));
        });
        const done = await publishMutation(engine, row, prepared, localHostId());
        expect(done.state).toBe(shouldConflict || i === 2 && !scenario.endsWith('_success') ? 'conflict' : 'committed');
      }
      await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true }, { hostId: localHostId(), limit: 100 });
      const beforeSuccess = scenario.endsWith('_success') ? await run() : null;
      const beforeRows = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence", [sourceId]);
      expect(beforeRows).toHaveLength(3);
      for (const row of beforeRows.filter(row => row.state === 'conflict')) {
        expect(row.outcome?.batch_key).toBeUndefined();
        expect(row.outcome?.input_digest).toBeUndefined();
      }
      const factsBefore = await engine.executeRaw('SELECT id,fact,embedding::text FROM facts WHERE source_id=$1 ORDER BY id', [sourceId]);
      const filesBefore = slugs.map(slug => readFileSync(join(root, `${slug}.md`), 'utf8'));
      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE source_id=$1 AND operation='extract_facts'", [sourceId]);
      expect(await compactWriteReceipts(engine)).toBe(3);
      const compacted = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence", [sourceId]);
      expect(compacted.every(row => row.compacted && row.intent === null)).toBe(true);
      const terminal = compacted.map(row => ({ id: row.id, state: row.state, outcome: row.outcome, error_code: row.error_code }));
      if (beforeSuccess) expect(await run()).toMatchObject(beforeSuccess);
      else {
        let failure: unknown;
        try { await run(); } catch (error) { failure = error; }
        expect(generations).toBe(1);
        expect(embeddings).toBe(2);
        expect(failure).toMatchObject({ code: 'facts_payload_expired',
          writeRequest: { request_id: compacted[2].request_id, state: 'conflict', outcome: compacted[2].outcome } });
        await expect(run()).rejects.toMatchObject({ code: 'facts_payload_expired' });
      }
      expect(generations).toBe(1);
      expect(embeddings).toBe(2);
      expect(await engine.executeRaw('SELECT id,fact,embedding::text FROM facts WHERE source_id=$1 ORDER BY id', [sourceId])).toEqual(factsBefore);
      expect(slugs.map(slug => readFileSync(join(root, `${slug}.md`), 'utf8'))).toEqual(filesBefore);
      expect((await engine.readPageSnapshot(snapshot.page.slug, { sourceId }))?.revision).toBe(snapshot.revision);
      expect(await engine.executeRaw("SELECT id,state,outcome,error_code FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence", [sourceId])).toEqual(terminal);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
    rmSync(home, { recursive: true, force: true });
  }
}
