/** A repaired file releases retained facts instead of replaying a historical hold receipt. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { clearGitHold, readGitSourceHolds, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('write-triggered facts recover after a preparation hold clears, preserving old receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-held-replay-'));
  try {
    await withEnv({ GBRAIN_COORDINATION_HOME: join(dir, "coordination"), GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
      const root = join(dir, "checkout"); mkdirSync(root);
      const sourceId = 'held-example';
      const slug = 'companies/example';
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      const config = { engine: engine.kind, embedding_disabled: true };
      const operation = { engine, sourceId, remote: false, dryRun: false, config, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      await submitPageMutation(operation, { operation: 'put_page', params: { slug, request_id: randomUUID(),
        content: '---\ntitle: Example\ntype: company\n---\n# Example\n\nSynthetic roadmap notes.\n' } });
      const [original] = await engine.executeRaw<{ id: string }>(
        "SELECT id FROM persistence_requests WHERE source_id=$1 AND operation='put_page' AND state='committed'", [sourceId]);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw("UPDATE persistence_brain SET enabled=true WHERE singleton=1");
      const page = (await engine.getPage(slug, { sourceId }))!;
      const ctx: FactsBackstopCtx = { engine, config, sourceId, source: 'mcp:put_page', sessionId: null,
        persistenceRequestId: original.id, mode: 'inline', remote: false };
      const session = async (extra: Partial<FactsBackstopCtx> = {}) =>
        (await prepareManagedFactsSession({ ...ctx, ...extra }, { turnText: page.compiled_truth, pageSlug: slug }))!;
      const file = join(root, `${slug}.md`);
      const pristine = readFileSync(file);
      appendFileSync(file, '\nUnimported local change.\n');
      const incarnation = (await session()).authority.sourceIncarnation;
      await writeGitHold(engine, { source_id: sourceId, incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
        page_id: Number(page.id), code: 'preparation_stalled', message: 'Preparation exhausted its attempts.', upstream_version: null,
        observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: 1 } });
      await expect(publishManagedFacts(engine, await session(), ctx, [{ fact: 'Example ships synthetic sample kits.', entity_slug: slug,
        kind: 'fact', source: 'mcp:put_page', confidence: 1, notability: 'high', embedding: null }], 'private', slug)).rejects.toThrow('preparation_stalled');
      const receipts = () => engine.executeRaw<{ record: string }>(
        "SELECT to_jsonb(r)::text AS record FROM persistence_requests r WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence", [sourceId]);
      const historical = await receipts();
      expect(historical).toHaveLength(2);
      await expect(resumeManagedFacts(engine, await session())).rejects.toThrow('preparation_stalled');
      expect(await receipts()).toEqual(historical);
      writeFileSync(file, pristine);
      await clearGitHold(engine, { sourceId, incarnation, path: `${slug}.md`, observedAt: new Date().toISOString() });
      expect(await readGitSourceHolds(engine, { sourceIds: [sourceId] })).toEqual([]);
      expect((await session({ requestId: randomUUID() })).fileRefusalRetry).toBe(false);
      const recoveredSession = await session();
      expect((await resumeManagedFacts(engine, recoveredSession))?.inserted).toBe(1);
      expect((await receipts()).slice(0, 2)).toEqual(historical);
      expect(await receipts()).toHaveLength(4);
      expect((await resumeManagedFacts(engine, recoveredSession))?.inserted).toBe(1);
      expect(await receipts()).toHaveLength(4);
      expect(await engine.executeRaw('SELECT fact FROM facts WHERE source_id=$1 AND expired_at IS NULL', [sourceId]))
        .toEqual([{ fact: 'Example ships synthetic sample kits.' }]);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
