import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, getEmbeddingModel, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimNextWrite } from '../../src/core/persistence/journal.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { prepareManagedFactsMutation } from '../../src/core/persistence/facts-prepare.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { upsertFactRow } from '../../src/core/facts-fence.ts';
import { withEnv } from './with-env.ts';

const hostModel = 'openai:text-embedding-3-large';
const selectedModel = 'openai:text-embedding-3-small';
export const managedEmbeddingCases = ['equal_dimensions', 'file_disabled', 'database_disabled', 'keyless',
  'missing_model', 'invalid_model', 'invalid_dimensions', 'invalid_policy', 'changed_before_embedding', 'disabled_before_embedding', 'changed_after_embedding',
  'provider_error', 'cancelled', 'changed_before_publication', 'changed_before_replay', 'disabled_before_replay',
  'file_disabled_before_replay', 'unchanged_replay', 'unsigned_replay'] as const;
type Case = typeof managedEmbeddingCases[number];

export async function exerciseManagedEmbedding(engine: BrainEngine, scenario: Case): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-fact-model-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      configureGateway({ embedding_model: hostModel, embedding_dimensions: 1536,
        env: scenario === 'keyless' ? {} : { OPENAI_API_KEY: 'test' } });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.setConfig('embedding_model', scenario === 'invalid_model' ? 'ambiguous-model' : selectedModel);
      await engine.setConfig('embedding_dimensions', scenario === 'invalid_dimensions' ? '1535' : '1536');
      await engine.setConfig('embedding_disabled', scenario === 'database_disabled' ? 'true' : scenario === 'invalid_policy' ? 'invalid' : 'false');
      if (scenario === 'missing_model') await engine.executeRaw("DELETE FROM config WHERE key='embedding_model'");
      const sourceId = `model-${randomUUID()}`;
      const slug = 'people/example';
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const body = upsertFactRow('Registered example entity.', { claim: 'An older valid fact.', kind: 'fact', confidence: 1,
        visibility: 'private', notability: 'medium', source: 'fixture' }).body.trim();
      await engine.putPage(slug, { type: 'person', title: 'Example', compiled_truth: body }, { sourceId });
      const old = await engine.insertFacts([{ fact: 'An older valid fact.', kind: 'fact', visibility: 'private', source: 'fixture',
        entity_slug: slug, row_num: 1, source_markdown_slug: slug, embedding: new Float32Array([0, 1, ...Array(1534).fill(0)]) }], { source_id: sourceId });
      const [before] = await engine.executeRaw<{ vector: string }>('SELECT embedding::text AS vector FROM facts WHERE id=$1', [old.ids[0]]);
      const root = join(home, 'repo');
      mkdirSync(join(root, 'people'), { recursive: true });
      const file = join(root, `${slug}.md`);
      writeFileSync(file, serializePageToMarkdown((await engine.getPage(slug, { sourceId }))!, []));
      const originalFile = readFileSync(file, 'utf8');
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
      await registerLocalWriter(engine, 'cli');
      const binding = await claimWorktree(engine, sourceId, root);
      const config = { engine: engine.kind, embedding_model: hostModel, embedding_dimensions: 1536,
        embedding_disabled: scenario === 'file_disabled' };
      const ctx: OperationContext = { engine, config, remote: false, sourceId, dryRun: false, logger: console };
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let generations = 0;
      const embeddings: string[] = [];
      let allEmbeddings = 0;
      const deferred = ['changed_before_publication', 'changed_before_replay', 'disabled_before_replay', 'file_disabled_before_replay', 'unchanged_replay', 'unsigned_replay'].includes(scenario);
      __setChatTransportForTests(async () => {
        generations++;
        if (scenario === 'changed_before_embedding') await engine.setConfig('embedding_model', hostModel);
        if (scenario === 'disabled_before_embedding') await engine.setConfig('embedding_disabled', 'true');
        if (deferred) await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
        return { text: JSON.stringify({ facts: [{ fact: 'Example prefers weekly written reports.', kind: 'preference', entity: slug,
          confidence: 0.9, notability: 'high' }] }), blocks: [], stopReason: 'end',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
      });
      __setEmbedTransportForTests((async ({ model, values }: { model: { modelId: string }; values: string[] }) => {
        allEmbeddings++;
        if (values.includes('Example prefers weekly written reports.')) embeddings.push(model.modelId);
        if (scenario === 'changed_after_embedding') await engine.setConfig('embedding_model', hostModel);
        if (scenario === 'provider_error') throw new Error('Synthetic embedding provider failure');
        if (scenario === 'cancelled') throw new DOMException('Synthetic cancellation', 'AbortError');
        return { embeddings: values.map(() => [1, ...Array(1535).fill(0)]) };
      }) as never);
      if (scenario === 'keyless') __setEmbedTransportForTests(null);
      const params = { turn_text: 'Example discussed a durable preference for written operating reports.', request_id: randomUUID() };
      const run = () => operationsByName.extract_facts.handler(ctx, params);
      const failure = ['invalid_policy', 'invalid_model', 'invalid_dimensions', 'changed_before_embedding', 'disabled_before_embedding', 'changed_after_embedding', 'cancelled'].includes(scenario);
      if (deferred) {
        await expect(run()).rejects.toMatchObject({ code: 'write_pending' });
        await disposePersistenceConsumer(engine);
        await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
        if (scenario === 'changed_before_publication') {
          const row = (await claimNextWrite(engine, localHostId()))!;
          expect(row.slug).toBe(slug);
          const prepared = await prepareManagedFactsMutation(engine, row, config);
          await engine.setConfig('embedding_model', hostModel);
          const result = await publishMutation(engine, row, prepared, localHostId());
          expect(result.state).not.toBe('committed');
        } else if (scenario === 'unchanged_replay') {
          expect(await run()).toMatchObject({ inserted: 1 });
          expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND embedding IS NOT NULL', [sourceId])).toHaveLength(2);
        } else {
          if (scenario === 'unsigned_replay') await engine.executeRaw("UPDATE persistence_requests SET intent=intent-'embedding' WHERE source_id=$1 AND intent->>'kind'='managed_facts_entity'", [sourceId]);
          else if (scenario === 'file_disabled_before_replay') config.embedding_disabled = true;
          else await engine.setConfig(scenario === 'disabled_before_replay' ? 'embedding_disabled' : 'embedding_model', scenario === 'disabled_before_replay' ? 'true' : hostModel);
          await expect(run()).rejects.toBeDefined();
          const beforeReceipt = await engine.executeRaw('SELECT state,error_code,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
          await engine.setConfig('embedding_model', selectedModel);
          await engine.setConfig('embedding_disabled', 'false');
          config.embedding_disabled = false;
          await expect(run()).rejects.toBeDefined();
          expect(await engine.executeRaw('SELECT state,error_code,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, slug])).toEqual(beforeReceipt);
        }
        expect(generations).toBe(1);
        expect(embeddings).toHaveLength(1);
      } else if (failure) {
        await expect(run()).rejects.toBeDefined();
        expect(embeddings).toHaveLength(['changed_after_embedding', 'cancelled'].includes(scenario) ? 1 : 0);
        expect(generations).toBe(scenario.startsWith('invalid_') ? 0 : 1);
      } else {
        const result = await run() as { inserted: number; fact_ids: number[] };
        expect(result.inserted).toBe(1);
        const [fact] = await engine.executeRaw<{ embedded: boolean }>('SELECT embedding IS NOT NULL AS embedded FROM facts WHERE id=$1', [result.fact_ids[0]]);
        const shouldEmbed = scenario === 'equal_dimensions';
        expect(fact.embedded).toBe(shouldEmbed);
        expect(generations).toBe(1);
        expect(embeddings).toHaveLength(shouldEmbed || scenario === 'provider_error' ? 1 : 0);
        if (scenario === 'file_disabled' || scenario === 'database_disabled') expect(allEmbeddings).toBe(0);
        if (shouldEmbed) {
          expect(embeddings).toEqual(['text-embedding-3-small']);
          const [retained] = await engine.executeRaw<{ signature: unknown }>("SELECT intent->'embedding' AS signature FROM persistence_requests WHERE source_id=$1 AND slug=$2", [sourceId, slug]);
          expect(retained.signature).toEqual({ model: selectedModel, dimensions: 1536 });
          await engine.setConfig('embedding_model', hostModel);
          expect(await run()).toEqual(result);
          expect(generations).toBe(1);
          expect(embeddings).toHaveLength(1);
        }
      }
      if (deferred && scenario !== 'unchanged_replay' || failure) {
        expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [sourceId])).toHaveLength(1);
        expect(readFileSync(file, 'utf8')).toBe(originalFile);
        expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toBe(body);
      }
      const [after] = await engine.executeRaw<{ vector: string }>('SELECT embedding::text AS vector FROM facts WHERE id=$1', [old.ids[0]]);
      expect(after.vector).toBe(before.vector);
      expect(getEmbeddingModel()).toBe(hostModel);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
    rmSync(home, { recursive: true, force: true });
  }
}
