/**
 * #9302: resuming a managed facts batch read the journal with `request_id = $id OR COALESCE(intent->>'batchKey', ...) = $key`.
 * No index serves the JSON arm, so Postgres walked every extract_facts receipt of the principal and detoasted each
 * intent (embeddings included) to test it: about 14 s a batch on a small instance, growing with the journal. Each read
 * is now one an index serves: the completion by its request id, its entities by the ids it names (or, once compacted,
 * by a bounded walk down from it), and a miss checks the batch key on completion rows only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'facts-batch-9302-example';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

/** The statements `run` sends to the journal, on a spy over `engine`. */
async function journalReads<T>(run: (spy: BrainEngine) => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const sql: string[] = [];
  const execute = engine.executeRaw.bind(engine);
  const spy = Object.assign(Object.create(engine), {
    executeRaw: (text: string, params?: unknown[], opts?: never) => {
      if (/FROM persistence_requests/.test(text)) sql.push(text.replace(/\s+/g, ' '));
      return execute(text, params, opts);
    },
  }) as BrainEngine;
  return { result: await run(spy), sql };
}

const batchKeyRead = (sql: string) => sql.includes("intent->>'batchKey'");

test('#9302: a stored batch resumes through indexed reads, before and after its completion is compacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-batch-9302-'));
  try {
    await withEnv({ GBRAIN_COORDINATION_HOME: join(dir, 'coordination'), GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
      for (const slug of ['companies/acme-example', 'people/alice-example']) {
        await engine.putPage(slug, { type: slug.startsWith('people/') ? 'person' : 'company', title: slug, compiled_truth: 'Synthetic notes.', timeline: '' }, { sourceId: SOURCE });
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const config = { engine: engine.kind, embedding_disabled: true };
      const ctx: FactsBackstopCtx = { engine, config, sourceId: SOURCE, source: 'mcp:extract_facts', sessionId: null, mode: 'inline', remote: false,
        requestId: randomUUID() } as FactsBackstopCtx;
      const session = async (extra: Partial<FactsBackstopCtx> = {}) =>
        (await prepareManagedFactsSession({ ...ctx, ...extra }, { turnText: (await engine.getPage('companies/acme-example', { sourceId: SOURCE }))!.compiled_truth, pageSlug: 'companies/acme-example' }))!;
      const admitted = await session();
      const published = await publishManagedFacts(engine, admitted, ctx, [
        { fact: 'Acme ships synthetic sample kits.', entity_slug: 'companies/acme-example', kind: 'fact', source: 'mcp:extract_facts', confidence: 1, notability: 'high', embedding: null },
        { fact: 'Alice runs synthetic operations.', entity_slug: 'people/alice-example', kind: 'fact', source: 'mcp:extract_facts', confidence: 1, notability: 'high', embedding: null },
      ], 'private', 'companies/acme-example');
      expect(published?.inserted).toBe(2);

      const resumed = await journalReads(spy => resumeManagedFacts(spy, admitted));
      expect(resumed.result?.inserted).toBe(2);
      expect(resumed.sql.length).toBeGreaterThan(0);
      expect(resumed.sql.filter(batchKeyRead)).toEqual([]);

      await engine.executeRaw(`UPDATE persistence_requests SET intent=NULL, compacted=true WHERE source_id=$1 AND slug='__managed_facts_complete__'`, [SOURCE]);
      const compacted = await journalReads(spy => resumeManagedFacts(spy, admitted));
      expect(compacted.result?.inserted).toBe(2);
      expect(compacted.sql.filter(batchKeyRead).every(sql => /ORDER BY sequence DESC LIMIT/.test(sql))).toBe(true);

      const fresh = await journalReads(async spy => resumeManagedFacts(spy, await session({ requestId: randomUUID() })));
      expect(fresh.result).toBeNull();
      expect(fresh.sql.filter(batchKeyRead).every(sql => sql.includes("slug='__managed_facts_complete__'"))).toBe(true);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
