import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { managedAtomSession, readAtomOrigin, resumeManagedAtoms } from '../../src/core/persistence/atom-maintenance.ts';
import { retryManagedAtomBatch } from '../../src/core/persistence/atom-retry.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { compactWriteReceipts, receiptFor } from '../../src/core/persistence/journal.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { disposePersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { withEnv } from './with-env.ts';

export const atomCompactionCases = ['all_failed', 'mixed_all', 'completion_only', 'failed_child_only', 'committed_child_only', 'changed_target', 'success', 'malformed'] as const;
export const atomCompactionActions = ['resume', 'retry'] as const;

export async function exerciseAtomCompaction(engine: BrainEngine, scenario: typeof atomCompactionCases[number], action: typeof atomCompactionActions[number]): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-atom-compaction-'));
  const sourceId = `compact-${sha256(`${scenario}-${action}`).slice(0, 12)}`;
  let observedEngine = engine;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/2026-01-01-example', { type: 'source', title: 'Example', compiled_truth: 'A private project record. '.repeat(40), frontmatter: { visibility: 'private' } }, { sourceId });
      const page = (await engine.getPage('notes/2026-01-01-example', { sourceId }))!;
      const titles = ['Measured progress', 'Explicit ownership'];
      const slugs = titles.map(title => `atoms/2026-01-01/${title.toLowerCase().replaceAll(' ', '-')}-${sha256(`${page.slug}\0${title}`).slice(0, 8)}`);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const observe = (target: BrainEngine): BrainEngine => new Proxy(target, {
        get(current, key) {
          if (key === 'addLinksBatch') return async (...args: Parameters<BrainEngine['addLinksBatch']>) => {
            if (scenario !== 'success' && (scenario === 'all_failed' || args[0].some(link => link.to_slug === slugs[1]))) {
              throw new OperationError('revision_conflict', 'Fixture atom publication conflict');
            }
            return current.addLinksBatch(...args);
          };
          if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => current.transaction(tx => fn(observe(tx)));
          const value = Reflect.get(current, key);
          return typeof value === 'function' ? value.bind(current) : value;
        },
      });
      observedEngine = observe(engine);
      let calls = 0;
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: scenario === 'malformed' ? 'Invalid model output' : JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Use ${title.toLowerCase()} to guide the project.` }))),
          blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const opts = { sourceId, _chat: chat, _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] };
      const first = await runPhaseExtractAtoms(observedEngine, opts);
      expect(first.status).toBe(scenario === 'success' ? 'ok' : 'warn');
      expect(calls).toBe(1);
      const accepted = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      expect(accepted).toHaveLength(scenario === 'malformed' ? 1 : 3);
      const completion = await waitForWrite(observedEngine, accepted.at(-1)!, { engine: engine.kind });
      expect(completion.state).toBe(['success', 'malformed'].includes(scenario) ? 'committed' : 'conflict');
      await disposePersistenceConsumer(observedEngine);
      const originals = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      if (scenario !== 'malformed') expect(originals.map(row => row.state)).toEqual(scenario === 'success' ? ['committed', 'committed', 'committed'] :
        scenario === 'all_failed' ? ['conflict', 'conflict', 'conflict'] : ['committed', 'conflict', 'conflict']);
      if (scenario === 'changed_target') {
        await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
          await tx.lockPageKeys([{ sourceId, slug: slugs[0] }]);
          const atom = (await tx.getPage(slugs[0], { sourceId }))!;
          await tx.putPage(slugs[0], { ...atom, compiled_truth: 'Independent correction after the original atom committed.' }, { sourceId });
        }));
      }
      const pagesBefore = await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId]);
      const checkpointsBefore = await engine.executeRaw("SELECT * FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1 ORDER BY fingerprint", [sourceId]);
      expect(checkpointsBefore).toHaveLength(['success', 'malformed'].includes(scenario) ? 1 : 0);
      const compactIds = scenario === 'completion_only' ? [completion.id] : scenario === 'failed_child_only' ? [originals[1].id] :
        scenario === 'committed_child_only' ? [originals[0].id] : originals.map(row => row.id);
      const [counterBefore] = await engine.executeRaw<{ terminal_bytes: string }>("SELECT terminal_bytes::text FROM persistence_counters WHERE key='brain'");
      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=ANY($1::uuid[])", [compactIds]);
      expect(await compactWriteReceipts(engine)).toBe(compactIds.length);
      const retained = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      for (let i = 0; i < retained.length; i++) {
        expect(retained[i].compacted).toBe(compactIds.includes(retained[i].id));
        expect(retained[i].intent).toEqual(compactIds.includes(retained[i].id) ? null : originals[i].intent);
        expect(retained[i].outcome).toEqual(originals[i].outcome);
        expect(retained[i].state).toBe(originals[i].state);
      }
      const releasedBytes = originals.reduce((sum, row, i) => sum + Number(row.terminal_reservation) - Number(retained[i].terminal_reservation), 0);
      expect(releasedBytes).toBeGreaterThan(0);
      const [counterAfter] = await engine.executeRaw<{ terminal_bytes: string }>("SELECT terminal_bytes::text FROM persistence_counters WHERE key='brain'");
      expect(Number(counterAfter.terminal_bytes)).toBe(Number(counterBefore.terminal_bytes) - releasedBytes);
      const providerFree = async (): Promise<ChatResult> => { calls++; throw new Error('Compacted atom receipts must prevent another model call'); };
      __setChatTransportForTests(providerFree);
      if (action === 'resume') {
        const replay = await runPhaseExtractAtoms(engine, { ...opts, _chat: providerFree });
        expect(calls).toBe(1);
        expect(replay.status).toBe(scenario === 'success' ? 'ok' : 'warn');
        if (scenario === 'success') expect(replay.details?.duplicates_skipped).toBe(1);
        const session = (await managedAtomSession(engine, sourceId))!;
        const origin = await readAtomOrigin(engine, session, { kind: 'page', slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! });
        if (scenario === 'success') expect(await resumeManagedAtoms(engine, session, origin)).toBe(true);
        else {
          let error: unknown;
          try { await resumeManagedAtoms(engine, session, origin); } catch (caught) { error = caught; }
          expect(error).toBeInstanceOf(OperationError);
          expect(retained.map(row => row.request_id)).toContain((error as OperationError).writeRequest?.request_id!);
        }
      } else {
        for (const row of retained) {
          let error: unknown;
          try { await retryManagedAtomBatch(engine, sourceId, row.request_id, 'reviewed-expired-retry'); } catch (caught) { error = caught; }
          expect(calls).toBe(1);
          expect(error).toBeInstanceOf(OperationError);
          expect(error).toMatchObject({ code: 'recovery_required' });
          const refusal = error as OperationError;
          expect(refusal.message).toContain('expired');
          expect(refusal.suggestion ?? '').not.toContain('gbrain jobs submit');
          const expired = retained.find(item => item.request_id === refusal.writeRequest?.request_id)!;
          expect(expired.compacted).toBe(true);
          expect(refusal.writeRequest).toEqual(receiptFor(expired));
        }
      }
      await disposePersistenceConsumer(engine);
      expect(calls).toBe(1);
      expect(await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId])).toEqual(retained);
      expect(await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId])).toEqual(pagesBefore);
      expect(await engine.executeRaw("SELECT * FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1 ORDER BY fingerprint", [sourceId])).toEqual(checkpointsBefore);
      expect(await engine.executeRaw<{ terminal_bytes: string }>("SELECT terminal_bytes::text FROM persistence_counters WHERE key='brain'")).toEqual([counterAfter]);
    });
  } finally {
    await disposePersistenceConsumer(observedEngine);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null);
    rmSync(home, { recursive: true, force: true });
  }
}
