/**
 * #7436: a repair item's request id named its page and revision, not the item. Two items of one run that write the same
 * page (two facts of one fence) at the same revision got one id: while the first write was still pending, the second
 * item reused its id for a different write, and admission refused it as idempotency_conflict, which an approved apply
 * (--expect) does not continue past. Each item now gets its own id, and an item whose page has a pending write from the
 * run waits for it, so every fact of a many-fact page is applied in one run.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { repairRequestId, resolveRepairScope, runRepair, type RepairHandler, type RepairItem } from '../src/core/repair/core.ts';
import { repairSpec } from '../src/core/repair/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-repair-per-item-'));
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dataDir, { recursive: true, force: true }); });

const ctxFor = (sourceId: string, writeWaitMs?: number) => ({ engine, sourceId, remote: false as const, config: { engine: 'pglite', embedding_disabled: true },
  dryRun: false, logger: quiet, ...(writeWaitMs === undefined ? {} : { writeWaitMs }) }) as never;
const page = (body: string) => `---\ntype: note\ntitle: Example\n---\n${body}\n`;

/** Applies `count` approved items that each mark the same page, with the first publication held past the write wait. */
async function markOnePage(count: number) {
  const dir = mkdtempSync(join(dataDir, 'case-'));
  const source = `repair-${randomUUID().slice(0, 8)}`;
  return withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    try {
      const root = join(dir, source); mkdirSync(root);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await claimWorktree(engine, source, root);
      await submitPageMutation(ctxFor(source), { operation: 'put_page', params: { slug: 'people/alice-example', content: page('Facts.'), request_id: randomUUID() } });
      const ids: string[] = [];
      const item = (id: number): RepairItem => ({ cursor: { phase: 0, id }, source_id: source, slug: 'people/alice-example', chars: 1, action: `mark fact ${id}` });
      const handler: RepairHandler = { kind: 'visibility', embeds: false,
        async plan(_engine, _scope, after) { return { items: Array.from({ length: count }, (_, i) => item(i)).filter(i => !after || i.cursor.id > after.id), residuals: {}, preview_hash: 'h' }; },
        async apply(ctx, it) {
          const snapshot = (await engine.readPageSnapshot('people/alice-example', { sourceId: source }))!;
          const request_id = await repairRequestId(ctx, 'visibility', it, snapshot.revision);
          ids.push(request_id);
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/alice-example', source_id: source, expected_revision: snapshot.revision,
            content: page(`${snapshot.page.compiled_truth.trim()} M{${it.cursor.id}}.`), request_id } });
          return true;
        } };
      let held = true;
      installFaultHook(async point => { if (point === 'consumer:prepared' && held) { held = false; await new Promise(resolve => setTimeout(resolve, 1_500)); } });
      const scope = await resolveRepairScope(engine);
      const result = await runRepair(ctxFor(source, 1_000), handler, scope, { apply: true, spec: repairSpec('visibility'), embed: false, expect: 'h',
        publicationOwner: async () => ({ alive: true, owner: 'this process' }) });
      const body = (await engine.readPageSnapshot('people/alice-example', { sourceId: source }))!.page.compiled_truth;
      return { ids, result, marks: [...body.matchAll(/M\{(\d+)\}/g)].map(m => Number(m[1])) };
    } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
  });
}

describe('#7436: repair request ids are per item', () => {
  test('a second item on a page whose first write is pending gets its own id and writes after it, instead of idempotency_conflict', async () => {
    const { ids, result, marks } = await markOnePage(3);
    expect(new Set(ids).size).toBe(3);
    expect(result.failed).toEqual([]);
    expect(result.stopped).toBeUndefined();
    expect(result).toMatchObject({ applied: 3, skipped: 0, complete: true });
    expect(marks).toEqual([0, 1, 2]);
  }, 120_000);

  test('86 items on one page all apply in one run', async () => {
    const { ids, result, marks } = await markOnePage(86);
    expect(new Set(ids).size).toBe(86);
    expect(result.failed).toEqual([]);
    expect(result.stopped).toBeUndefined();
    expect(result).toMatchObject({ applied: 86, skipped: 0, complete: true });
    expect(marks).toEqual(Array.from({ length: 86 }, (_, i) => i));
  }, 240_000);
});
