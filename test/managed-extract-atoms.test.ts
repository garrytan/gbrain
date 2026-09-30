import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { atomContractCases, exerciseManagedAtoms, atomBatchCases, exerciseManagedAtomBatch, atomAuthorityCases, exerciseManagedAtomAuthority } from './helpers/managed-atoms-contract.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });

for (const scenario of atomContractCases) test(`managed atom ${scenario}`, () => exerciseManagedAtoms(engine, scenario), 60_000);
for (const scenario of atomBatchCases) test(`managed atom batch ${scenario}`, () => exerciseManagedAtomBatch(engine, scenario), 60_000);
for (const scenario of atomAuthorityCases) test(`managed atom authority ${scenario} rejects normal and dry runs before providers`, () => exerciseManagedAtomAuthority(engine, scenario), 60_000);

test('managed public atom extraction publishes searchable atoms and replays without another model call', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atoms-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'A private project record. '.repeat(40), frontmatter: { visibility: 'private' } });
      const page = (await engine.getPage('notes/example', { sourceId: 'default' }))!;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria."}]', blocks: [], stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const opts = { _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chat };
      const result = await runPhaseExtractAtoms(engine, opts);
      expect(result.status).toBe('ok');
      expect(result.details?.atoms_extracted).toBe(1);
      const atoms = await engine.executeRaw<{ slug: string; visibility: string }>("SELECT slug,frontmatter->>'visibility' AS visibility FROM pages WHERE type='atom'");
      expect(atoms).toHaveLength(1);
      expect(atoms[0].visibility).toBe('private');
      expect(await engine.executeRaw('SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1', [atoms[0].slug])).not.toHaveLength(0);
      await runPhaseExtractAtoms(engine, opts);
      expect(calls).toBe(1);
      expect((await engine.getPage(page.slug, { sourceId: 'default' }))?.frontmatter).not.toHaveProperty('atoms_scan_hash');
    });
  } finally { await stopPersistenceConsumer(engine); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
