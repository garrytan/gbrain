import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { embeddingInputHash } from '../src/core/embedding-input-hash.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { settleNoopEmbeddingEffects } from '../src/core/persistence/embedding-noop-settle.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { withEnv } from './helpers/with-env.ts';

// Reproduces durable queued rows with complete vectors whose title-formatted inputs are unproven or stale.
// The page writes, projections, vectors and effects are persisted in a disposable PGLite brain.
describe('formatted document no-op settle proof', () => {
  let engine: BrainEngine;
  let scratch: string;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-document-noop-settle-'));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(scratch, 'brain') });
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine?.disconnect();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test('leaves legacy and outdated titled vectors queued while settling an unaffected model', () =>
    withEnv({ GBRAIN_HOME: scratch }, async () => {
      const signature = 'ollama:embeddinggemma:latest:1536';
      const formattedModel = 'ollama:embeddinggemma:latest';
      const unaffectedSignature = 'test:model:1536';
      await registerLocalWriter(engine, 'cli');

      async function page(slug: string, title: string, sourceId: string) {
        const [source] = await engine.executeRaw<{ incarnation: string }>(
          'INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
        const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false,
          sourceId, logger: { info() {}, warn() {}, error() {} } };

        async function publish(nextTitle: string) {
          const [current] = await engine.executeRaw<{ revision: string }>(
            'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
          const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, slug);
          await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
            sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: { title: nextTitle },
            intent: { title: nextTitle } });
          const write = (await claimNextWrite(engine, localHostId()))!;
          await publishMutation(engine, write, { observedRevision: current?.revision ?? null, apply: async tx => {
            await tx.putPage(slug, { type: 'note', title: nextTitle, compiled_truth: `Body of ${slug}`, timeline: '', frontmatter: {} }, { sourceId });
            return {};
          } }, localHostId());
          const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
          await installPageProjection(engine, prepared,
            [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Body of ${slug}` }], { seal: true });
          await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'embedding'");
          const [effect] = await engine.executeRaw<{ id: string }>(
            "SELECT id::text AS id FROM persistence_effects WHERE source_id=$1 AND data->>'slug'=$2 AND kind='embedding' ORDER BY id DESC LIMIT 1", [sourceId, slug]);
          if (!effect) throw new Error(`Missing embedding effect for ${slug}`);
          const [pageRow] = await engine.executeRaw<{ id: number }>(
            'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
          return { effectId: effect.id, pageId: pageRow.id };
        }

        const initial = await publish(title);
        return { sourceId, slug, initial, publish };
      }

      async function persistVector(pageId: number, model: string, embeddingSignature: string, inputHash: string | null) {
        const values = `[${new Array(1536).fill('0.1').join(',')}]`;
        await engine.executeRaw(`UPDATE content_chunks SET embedding=$1::vector, embedded_at=now(), embedded_text_hash=md5(chunk_text),
          model=$2, embedding_input_hash=$3 WHERE page_id=$4`, [values, model, inputHash, pageId]);
        await engine.executeRaw('UPDATE pages SET embedding_signature=$2 WHERE id=$1', [pageId, embeddingSignature]);
      }

      const legacy = await page('proof/legacy', 'Before title formatting', `proof-${randomUUID()}`);
      await persistVector(legacy.initial.pageId, formattedModel, signature, null);

      const renamed = await page('proof/renamed', 'Old title', `proof-${randomUUID()}`);
      const oldTitleHash = embeddingInputHash({ column: 'embedding', model: formattedModel, dimensions: 1536,
        title: 'Old title', corpusGeneration: null, bodyHash: '' }, 'none', { chunk_text: 'Body of proof/renamed' });
      await persistVector(renamed.initial.pageId, formattedModel, signature, oldTitleHash);
      const current = await renamed.publish('New title');
      // A vector from the prior page title survives in the persisted row without proof of the new formatted input.
      await persistVector(current.pageId, formattedModel, signature, oldTitleHash);

      const unaffected = await page('proof/unaffected', 'Unchanged input', `proof-${randomUUID()}`);
      await persistVector(unaffected.initial.pageId, 'test:model', unaffectedSignature, null);

      const formattedEffects = [legacy.initial.effectId, current.effectId];
      const pass = await settleNoopEmbeddingEffects(engine, localHostId(), signature);
      expect(pass).toMatchObject({ settled: 0, done: true, cursor: { through: '0' } });
      expect(await engine.executeRaw<{ id: string; state: string }>(
        'SELECT id::text AS id,state FROM persistence_effects WHERE id=ANY($1::text[]::bigint[]) ORDER BY id', [formattedEffects]))
        .toEqual(formattedEffects.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).map(id => ({ id, state: 'queued' })));

      const unaffectedPass = await settleNoopEmbeddingEffects(engine, localHostId(), unaffectedSignature);
      expect(unaffectedPass.settled).toBe(1);
      const [unaffectedRow] = await engine.executeRaw<{ state: string }>(
        'SELECT state FROM persistence_effects WHERE id=$1::bigint', [unaffected.initial.effectId]);
      expect(unaffectedRow.state).toBe('committed');
    }));
});
