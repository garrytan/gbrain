/**
 * Wave B PR 2 lane 2r: `remember` against an entity page stored in segments.
 *
 * 1. Protects: a remember whose entity page (named, or inferred from one
 *    exact mention) stores its body in segments over the single-string
 *    ceiling (PAGE_MAX_BYTES) refuses before admission with the frozen wire
 *    code `invalid_params`, the canonical code and write_error
 *    `page_body_segmented`, not retryable, and a fix that saves the claim
 *    unattributed (infer_entity: false); no fact row is written. A segmented
 *    entity within the ceiling links, named and inferred (preparation reads it
 *    back whole). A receipt that failed with `page_body_segmented` in
 *    preparation maps the same way, and its write diagnostic names the code.
 *    Inline entity pages keep linking as before.
 * 2. Fails when: the refusal surfaces as `unavailable` / storage_error (a
 *    server fault an agent retries), or an inferred subject on a segmented
 *    page is silently saved with NO_ENTITY.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { disposePersistenceConsumer, writeResponse } from '../../src/core/persistence/service.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { runMemoryWrite, writeFailureDiagnostic } from '../../src/core/persistence/verb-errors.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { toAgentError, type RenderContext } from '../../src/core/agent-output.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const HUGE = 'people/zara-example';
const SEGMENTED = 'people/xena-example';
const INLINE = 'people/yuri-example';
const dir = mkdtempSync(join(tmpdir(), 'gbrain-remember-segmented-'));
const sourceId = 'default';

async function refusal(run: Promise<unknown>): Promise<OperationError> {
  try { await run; } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const factCount = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: unknown }>('SELECT count(*) AS n FROM facts'))[0]!.n);

for (const kind of testBackends()) {
  describe(`remember on a segmented entity page (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const ctx = (): OperationContext => ({ engine, remote: false, sourceId, config: { engine: kind }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext);
    const remember = (params: Record<string, unknown>) => operationsByName.remember!.handler(ctx(), { provenance: 'chat 2026-10-15', ...params }) as Promise<Record<string, any>>;

    beforeAll(async () => {
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; close = pg.close;
      } else {
        const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
        engine = lite; close = () => lite.disconnect();
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      await engine.setConfig('pages.segmented_storage', 'on');
      await importFromContent(engine, SEGMENTED, `---\ntype: person\ntitle: Xena Example\n---\n\n# Xena Example\n\n${conversationBody(1_300_000, { seed: 3 })}\n`, { sourceId, noEmbed: true });
      // A person page over the ceiling imports streamed only while derived entity aliases are off (they read the whole body).
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${kind}-zara.md`);
      writeFileSync(file, `---\ntype: person\ntitle: Zara Example\n---\n\n# Zara Example\n\n${conversationBody(PAGE_MAX_BYTES + 512 * 1024, { seed: 4 })}\n`);
      await engine.setConfig('mentions.auto_link', 'off');
      expect(await importFromFile(engine, file, `${HUGE}.md`, { sourceId, noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
      await engine.unsetConfig('mentions.auto_link');
      rmSync(file);
      await importFromContent(engine, INLINE, '---\ntype: person\ntitle: Yuri Example\n---\n\n# Yuri Example\n\nA small inline person page.\n', { sourceId, noEmbed: true });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      for (const [slug, over] of [[HUGE, true], [SEGMENTED, false]] as const) {
        const [row] = await engine.executeRaw<{ body_storage: string; body_bytes: string }>('SELECT body_storage, body_bytes::text AS body_bytes FROM pages WHERE slug=$1', [slug]);
        expect(row?.body_storage).toBe('segmented');
        expect(Number(row?.body_bytes) > PAGE_MAX_BYTES).toBe(over);
      }
    }, 300_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await close();
      resetGateway();
      rmSync(dir, { recursive: true, force: true });
    });

    const expectSegmentedRefusal = (e: OperationError, slug: string) => {
      expect(e.code).toBe('invalid_params');
      expect(e.canonicalCode).toBe('page_body_segmented');
      expect(e.writeError).toBe('page_body_segmented');
      expect(e.message).toContain(slug);
      expect(e.fix?.mcp).toEqual({ tool: 'remember', arguments: { fact: '<FACT>', provenance: '<PROVENANCE>', infer_entity: false } });
      expect(e.fix?.argv).toEqual(['gbrain', 'remember', '<FACT>', '--provenance', '<PROVENANCE>', '--infer-entity', 'false']);
      const render: RenderContext = { transport: 'stdio', surface: 'full', isCallable: () => true, preapproved: () => false, routing: { brain: 'host', source: sourceId } };
      const envelope = toAgentError(e, { transport: 'stdio', op: 'remember', mutating: true, idempotent: true, render }) as unknown as Record<string, any>;
      expect(envelope.code).toBe('page_body_segmented');
      expect(envelope.retryable).toBe(false);
    };

    test('a named segmented entity over the ceiling refuses page_body_segmented with the unattributed-save fix, not unavailable/storage_error', async () => {
      const before = await factCount(engine);
      const e = await refusal(remember({ fact: 'Zara Example prefers tea', entity: HUGE }));
      expectSegmentedRefusal(e, HUGE);
      expect(await factCount(engine)).toBe(before);
    }, 60_000);

    test('an inferred segmented subject over the ceiling refuses the same way instead of saving with NO_ENTITY', async () => {
      const before = await factCount(engine);
      const e = await refusal(remember({ fact: 'Zara Example moved the offsite to May' }));
      expectSegmentedRefusal(e, HUGE);
      expect(e.message).toContain('inferred from a mention');
      expect(await factCount(engine)).toBe(before);
    }, 60_000);

    test('within the ceiling a segmented entity links, named and inferred', async () => {
      expect(await remember({ fact: 'Xena Example likes chess', entity: SEGMENTED })).toMatchObject({ status: 'inserted', entity_slug: SEGMENTED });
      const inferred = await remember({ fact: 'Xena Example joined the board' });
      expect(inferred).toMatchObject({ status: 'inserted', entity_slug: SEGMENTED, entity_inferred: 'mention' });
      expect(inferred.warnings).toBeUndefined();
    }, 120_000);

    test('the fix saves the claim unattributed; inline entities still link, named and inferred', async () => {
      const unattributed = await remember({ fact: 'Zara Example moved the offsite to May', infer_entity: false });
      expect(unattributed).toMatchObject({ status: 'inserted', entity_slug: null, warnings: ['NO_ENTITY'] });
      expect(await remember({ fact: 'Yuri Example likes chess', entity: INLINE })).toMatchObject({ status: 'inserted', entity_slug: INLINE });
      expect(await remember({ fact: 'Yuri Example joined the board' })).toMatchObject({ status: 'inserted', entity_slug: INLINE, entity_inferred: 'mention' });
    }, 60_000);
  });
}

describe('a receipt that failed page_body_segmented in preparation', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001', request_id: '00000000-0000-4000-8000-000000000002', state: 'failed', operation: 'remember',
    source_id: 'default', slug: HUGE, principal_kind: 'local', principal_id: 'cli', outcome: null, authority: { remote: false },
    error_code: 'page_body_segmented', error_detail: null,
    error_message: `remember facts fence write: page ${HUGE} (source default) stores its body in segments, and this path reads or writes the whole body as one string. Nothing was read or changed.`,
    created_at: '2026-10-15T00:00:00.000Z', updated_at: '2026-10-15T00:00:01.000Z',
  } as unknown as WriteRequest;

  test('keeps its code through the verb boundary and the write diagnostic', async () => {
    const e = await refusal(runMemoryWrite(async () => writeResponse(row)));
    expect(e.code).toBe('invalid_params');
    expect(e.canonicalCode).toBe('page_body_segmented');
    expect(e.writeError).toBe('page_body_segmented');
    expect(e.detail).toBe('page_body_segmented');
    expect(e.message).toContain('stores its body in segments');
    expect(e.fix?.mcp?.arguments).toMatchObject({ infer_entity: false });
    const diagnostic = writeFailureDiagnostic('page_body_segmented', row.error_message);
    expect(diagnostic).toMatchObject({ reason: 'page_body_segmented', message: row.error_message });
    expect(diagnostic.suggestion).toContain('infer_entity: false');
  });
});
