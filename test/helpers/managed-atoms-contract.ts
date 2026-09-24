import { expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms, countExtractAtomsBacklog, discoverExtractablePages } from '../../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalGrant } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { retryManagedAtomBatch } from '../../src/core/persistence/atom-retry.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { withSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { purgeStaleCheckpoints } from '../../src/core/op-checkpoint.ts';
import { __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { withEnv } from './with-env.ts';

export const atomContractCases = ['publication', 'zero_yield', 'revision', 'removal', 'deferred', 'unavailable', 'source_replaced', 'malformed', 'malformed_retry', 'malformed_retry_failure', 'publication_retry', 'pagination', 'transcript', 'transcript_changed'] as const;
type Case = typeof atomContractCases[number];

export async function exerciseManagedAtoms(engine: BrainEngine, scenario: Case): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atoms-'));
  const sourceId = `atoms-${scenario.replaceAll('_', '-')}`;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/example', { type: 'source', title: 'Example', compiled_truth: 'A private project record. '.repeat(40), frontmatter: { visibility: 'private' } }, { sourceId });
      const page = (await engine.getPage('notes/example', { sourceId }))!;
      const transcript = scenario.startsWith('transcript') ? join(home, 'meeting.txt') : null;
      if (transcript) writeFileSync(transcript, page.compiled_truth);
      if (scenario === 'pagination') {
        await engine.putPage('notes/second', { type: 'source', title: 'Second', compiled_truth: 'Another distinct project record. '.repeat(40) }, { sourceId });
        await engine.setConfig('cycle.extract_atoms.page_discovery_budget', '1');
      }
      let binding: Awaited<ReturnType<typeof claimWorktree>> | undefined;
      let root: string | undefined;
      if (scenario === 'deferred' || scenario === 'unavailable' || scenario === 'publication' || scenario === 'publication_retry') {
        root = join(home, 'repo');
        mkdirSync(join(root, 'notes'), { recursive: true });
        writeFileSync(join(root, 'notes/example.md'), serializePageToMarkdown(page, []));
        await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
        await registerLocalWriter(engine, 'cli');
        binding = await claimWorktree(engine, sourceId, root);
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      if (scenario === 'unavailable') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding!.worktree_id]);
      let calls = 0;
      let blockedPath: string | undefined;
      let retryRecovery = false;
      const ctx = { engine, config: { engine: engine.kind }, remote: false, sourceId, dryRun: false, logger: console };
      const chat = async (): Promise<ChatResult> => {
        calls++;
        if (scenario === 'revision' || scenario === 'removal') {
          const snapshot = (await engine.readPageSnapshot(page.slug, { sourceId }))!;
          await submitPageMutation(ctx, { operation: scenario === 'removal' ? 'delete_page' : 'put_page',
            params: { slug: page.slug, expected_revision: snapshot.revision, ...(scenario === 'revision' ? { content: '# Changed\n\nA concurrent edit.' } : {}) } });
        }
        if (scenario === 'source_replaced') await engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await tx.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [sourceId]);
        });
        if (scenario === 'deferred') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding!.worktree_id]);
        if (scenario === 'transcript_changed') writeFileSync(transcript!, 'Changed while extraction was running.');
        if (scenario === 'publication_retry') {
          const path = join(root!, 'atoms', new Date().toISOString().slice(0, 10));
          mkdirSync(path, { recursive: true });
          blockedPath = join(path, `measured-progress-${sha256(`${page.slug}\0Measured progress`).slice(0, 8)}.md`);
          writeFileSync(blockedPath, 'Unindexed operator content.');
        }
        return { text: scenario === 'zero_yield' ? '[]' : scenario === 'malformed' || scenario.startsWith('malformed_retry') &&
          (calls === 1 || scenario === 'malformed_retry_failure' && !retryRecovery) ? 'not valid output' :
          '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria."}]', blocks: [], stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const opts = { sourceId,
        _transcripts: transcript ? [{ filePath: transcript, content: page.compiled_truth, contentHash: sha256(page.compiled_truth) }] : [],
        _pages: transcript ? [] : scenario === 'pagination' ? undefined : [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chat };
      if (scenario === 'unavailable') {
        await expect(runPhaseExtractAtoms(engine, opts)).rejects.toMatchObject({ code: 'owner_unavailable' });
        expect(calls).toBe(0);
        return;
      }
      const first = await runPhaseExtractAtoms(engine, opts);
      const readState = () => engine.executeRaw<{ content_hash: string; fail_count: number; tombstoned: boolean }>(
        'SELECT content_hash,fail_count,tombstoned FROM extract_atoms_page_state WHERE page_id=$1', [page.id]);
      if (scenario === 'zero_yield' || scenario === 'malformed' || scenario.startsWith('malformed_retry')) {
        expect(page.content_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(await readState()).toEqual([{ content_hash: page.content_hash!, fail_count: scenario === 'zero_yield' ? 0 : 1, tombstoned: scenario === 'zero_yield' }]);
        const checkpoints = await engine.executeRaw<{ content_hash: string; request_id: string }>(
          "SELECT completed_keys->0->>'contentHash' AS content_hash,completed_keys->0->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0].content_hash).toBe(page.content_hash!);
        expect(await engine.executeRaw('SELECT request_id FROM persistence_requests WHERE request_id=$1::uuid AND state=\'committed\'', [checkpoints[0].request_id])).toHaveLength(1);
        expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(scenario === 'zero_yield' ? 0 : 1);
        expect((await discoverExtractablePages(engine, sourceId)).map(item => item.slug)).toEqual(scenario === 'zero_yield' ? [] : [page.slug]);
      }
      if (scenario.startsWith('malformed_retry') || scenario === 'publication_retry') {
        expect(first.status).toBe('warn');
        expect(calls).toBe(1);
        const receipt = (first.details?.write_requests as Array<{ request_id: string }>)[0];
        expect(receipt.request_id).toBeTruthy();
        const [original] = await engine.executeRaw<{ state: string; outcome: unknown }>('SELECT state,outcome FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
        if (blockedPath) rmSync(blockedPath);
        await disposePersistenceConsumer(engine);
        const worker = new MinionWorker(engine, { queue: 'fixture' });
        await registerBuiltinHandlers(worker, engine, { quiet: true });
        __setChatTransportForTests(chat);
        const job: MinionJobContext = { id: 944, name: 'extract-atoms-drain', data: { sourceId, retryRequestId: receipt.request_id }, attempts_made: 0,
          signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
          updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] };
        if (scenario === 'malformed_retry_failure') {
          await expect(worker.getHandler('extract-atoms-drain')!(job)).rejects.toMatchObject({ code: 'extraction_failed' });
          expect(calls).toBe(2);
          expect(await readState()).toEqual([{ content_hash: page.content_hash!, fail_count: 2, tombstoned: false }]);
          await disposePersistenceConsumer(engine);
          await expect(worker.getHandler('extract-atoms-drain')!(job)).rejects.toMatchObject({ code: 'extraction_failed' });
          expect(calls).toBe(2);
          expect(await readState()).toEqual([{ content_hash: page.content_hash!, fail_count: 2, tombstoned: false }]);
          retryRecovery = true;
          job.id = 945;
        }
        const retried = await worker.getHandler('extract-atoms-drain')!(job) as Record<string, unknown>;
        expect(retried.model_rerun).toBe(scenario.startsWith('malformed_retry'));
        const expectedCalls = scenario === 'malformed_retry_failure' ? 3 : scenario === 'malformed_retry' ? 2 : 1;
        expect(calls).toBe(expectedCalls);
        await disposePersistenceConsumer(engine);
        expect(await worker.getHandler('extract-atoms-drain')!(job)).toMatchObject({ replayed: true, model_rerun: false });
        await runPhaseExtractAtoms(engine, opts);
        expect(calls).toBe(expectedCalls);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toHaveLength(1);
        const [unchanged] = await engine.executeRaw<{ state: string; outcome: unknown }>('SELECT state,outcome FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
        expect(unchanged).toEqual(original);
        expect(await readState()).toEqual([{ content_hash: page.content_hash!, fail_count: scenario === 'malformed_retry_failure' ? 2 : scenario === 'malformed_retry' ? 1 : 0, tombstoned: true }]);
        expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
        expect(await discoverExtractablePages(engine, sourceId)).toEqual([]);
        return;
      }
      if (scenario === 'revision' || scenario === 'removal' || scenario === 'source_replaced' || scenario === 'transcript_changed') {
        expect(calls).toBe(1);
        expect(first.status).toBe('warn');
        expect(first.details?.atoms_extracted).toBe(0);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toHaveLength(0);
        expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId])).toHaveLength(0);
        if (scenario === 'revision') expect((await engine.getPage(page.slug, { sourceId }))?.compiled_truth).toContain('A concurrent edit.');
        if (scenario === 'removal') expect(await engine.getPage(page.slug, { sourceId })).toBeNull();
        return;
      }
      if (scenario === 'pagination') {
        expect(first.status).toBe('ok');
        expect(calls).toBe(1);
        expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
        expect((await runPhaseExtractAtoms(engine, opts)).status).toBe('ok');
        expect(calls).toBe(2);
        expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
        await runPhaseExtractAtoms(engine, opts);
        expect(calls).toBe(2);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toHaveLength(2);
        return;
      }
      if (scenario === 'deferred') {
        expect(first.status).toBe('warn');
        expect(first.details?.atoms_extracted).toBe(0);
        expect(first.details?.write_requests).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'queued' })]));
        await disposePersistenceConsumer(engine);
        const pending = await engine.executeRaw('SELECT request_id,state,outcome FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
        await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding!.worktree_id]);
        let dryCalls = 0;
        const dryRun = await runPhaseExtractAtoms(engine, { ...opts, dryRun: true, _chat: async () => {
          dryCalls++;
          return { text: '[]', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
        } });
        expect(dryRun.status).toBe('ok');
        expect(dryCalls).toBe(1);
        expect(await engine.executeRaw('SELECT request_id,state,outcome FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId])).toEqual(pending);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toEqual([]);
        expect(await readState()).toEqual([]);
      } else expect(first.status).toBe(scenario === 'malformed' ? 'warn' : 'ok');
      if (scenario === 'zero_yield') {
        await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days' WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
        await purgeStaleCheckpoints(engine, 7);
      }
      await disposePersistenceConsumer(engine);
      const replay = await runPhaseExtractAtoms(engine, opts);
      expect(calls).toBe(1);
      expect(replay.status).toBe(scenario === 'malformed' ? 'warn' : 'ok');
      const atoms = await engine.executeRaw<{ slug: string; visibility: string }>("SELECT slug,frontmatter->>'visibility' AS visibility FROM pages WHERE source_id=$1 AND type='atom'", [sourceId]);
      expect(atoms).toHaveLength(scenario === 'zero_yield' || scenario === 'malformed' ? 0 : 1);
      if (atoms.length) {
        expect(atoms[0].visibility).toBe('private');
        expect(await engine.executeRaw('SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, atoms[0].slug])).not.toHaveLength(0);
        if (!transcript) expect(await engine.executeRaw('SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1 AND t.source_id=$1 AND f.slug=$2 AND t.slug=$3', [sourceId, page.slug, atoms[0].slug])).toHaveLength(1);
        if (root) expect(readFileSync(join(root, `${atoms[0].slug}.md`), 'utf8')).toContain('visibility: private');
      }
      if (scenario !== 'malformed' && !transcript) expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
      expect((await engine.getPage(page.slug, { sourceId }))?.frontmatter).not.toHaveProperty('atoms_scan_hash');
      if (scenario === 'zero_yield' || scenario === 'malformed') {
        const state = await readState();
        await disposePersistenceConsumer(engine);
        await runPhaseExtractAtoms(engine, opts);
        expect(calls).toBe(1);
        expect(await readState()).toEqual(state);
        expect(state).toEqual([{ content_hash: page.content_hash!, fail_count: scenario === 'malformed' ? 1 : 0, tombstoned: scenario === 'zero_yield' }]);
      }
    });
  } finally { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); __setChatTransportForTests(null); rmSync(home, { recursive: true, force: true }); }
}

export const atomBatchCases = ['partial_publication', 'missing_after_provenance', 'changed_after_provenance', 'completion_rollback'] as const;

export async function exerciseManagedAtomBatch(engine: BrainEngine, scenario: typeof atomBatchCases[number]): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atom-batch-'));
  const sourceId = `atoms-${scenario.replaceAll('_', '-')}`;
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
      let blockedPath: string | undefined;
      if (scenario === 'partial_publication') {
        const root = join(home, 'repo');
        mkdirSync(join(root, 'notes'), { recursive: true });
        writeFileSync(join(root, `${page.slug}.md`), serializePageToMarkdown(page, []));
        await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
        await registerLocalWriter(engine, 'cli');
        await claimWorktree(engine, sourceId, root);
        mkdirSync(join(root, 'atoms', '2026-01-01'), { recursive: true });
        blockedPath = join(root, `${slugs[1]}.md`);
        writeFileSync(blockedPath, 'Unindexed operator content.');
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let injected = false;
      const completionLocks: Array<readonly { sourceId: string; slug: string }[]> = [];
      const observe = (target: BrainEngine): BrainEngine => new Proxy(target, {
        get(current, key) {
          if (key === 'lockPageKeys') return async (keys: readonly { sourceId: string; slug: string }[]) => {
            if (keys.some(item => item.slug === '__managed_atom_complete__')) completionLocks.push(keys);
            return current.lockPageKeys(keys);
          };
          if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
            if (scenario === 'completion_rollback' && !injected && sql.includes("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms'")) {
              const state = await current.executeRaw('SELECT content_hash,tombstoned FROM extract_atoms_page_state WHERE page_id=$1', [page.id]);
              expect(state).toEqual([{ content_hash: page.content_hash!, tombstoned: true }]);
              injected = true;
              throw new Error('Fixture failure between derived state and durable checkpoint');
            }
            return current.executeRaw(sql, params);
          };
          if (key === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
            const result = await current.transaction(tx => fn(observe(tx)));
            const row = result as Partial<WriteRequest> | undefined;
            if (!injected && scenario.endsWith('_after_provenance') && row?.state === 'committed' && row.slug === slugs[1]) {
              expect(row.outcome?.revision).toBeTruthy();
              expect(await engine.executeRaw('SELECT l.id FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, page.slug])).toHaveLength(2);
              injected = true;
              await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
                await tx.lockPageKeys([{ sourceId, slug: slugs[1] }]);
                if (scenario === 'missing_after_provenance') {
                  await tx.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slugs[1]]);
                } else {
                  const atom = (await tx.getPage(slugs[1], { sourceId }))!;
                  await tx.putPage(slugs[1], { ...atom, compiled_truth: `${atom.compiled_truth}\nAn independent correction.` }, { sourceId });
                }
              }));
            }
            return result;
          };
          const value = Reflect.get(current, key);
          return typeof value === 'function' ? value.bind(current) : value;
        },
      });
      observedEngine = observe(engine);
      let calls = 0;
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Use ${title.toLowerCase()} to guide the project.` }))),
          blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const opts = { sourceId, _transcripts: [], _chat: chat };
      expect((await discoverExtractablePages(engine, sourceId)).map(item => item.slug)).toEqual([page.slug]);
      expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
      const first = await runPhaseExtractAtoms(observedEngine, opts);
      expect(first.status).toBe('warn');
      expect(first.details?.atoms_extracted).toBe(0);
      expect(calls).toBe(1);
      const accepted = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      expect(accepted).toHaveLength(3);
      const completion = await waitForWrite(observedEngine, accepted[2], { engine: engine.kind });
      expect(completion.state).toBe(scenario === 'completion_rollback' ? 'failed' : 'conflict');
      const originals = await engine.executeRaw('SELECT request_id,state,outcome,error_code,error_message FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      expect(originals[0].state).toBe('committed');
      expect(originals[1].state).toBe(scenario === 'partial_publication' ? 'conflict' : 'committed');
      if (scenario !== 'partial_publication') expect(injected).toBe(true);
      expect(completionLocks).toContainEqual(expect.arrayContaining(slugs.map(slug => ({ sourceId, slug }))));
      const atoms = await engine.executeRaw<{ slug: string; source_hash: string }>("SELECT slug,frontmatter->>'source_hash' AS source_hash FROM pages WHERE source_id=$1 AND type='atom' ORDER BY slug", [sourceId]);
      expect(atoms).toHaveLength(scenario === 'partial_publication' || scenario === 'missing_after_provenance' ? 1 : 2);
      for (const atom of atoms) expect(atom.source_hash).toBe(`pending:${page.content_hash!.slice(0, 16)}`);
      expect(await engine.executeRaw('SELECT page_id FROM extract_atoms_page_state WHERE page_id=$1', [page.id])).toEqual([]);
      expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId])).toEqual([]);
      expect((await discoverExtractablePages(engine, sourceId)).map(item => item.slug)).toEqual([page.slug]);
      expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
      await disposePersistenceConsumer(observedEngine);
      const providerFree = async (): Promise<ChatResult> => { calls++; throw new Error('Replay must not invoke a provider'); };
      __setChatTransportForTests(providerFree);
      const replay = await runPhaseExtractAtoms(observedEngine, { ...opts, _chat: providerFree });
      expect(replay.status).toBe('warn');
      expect(calls).toBe(1);
      expect(await engine.executeRaw('SELECT request_id,state,outcome,error_code,error_message FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId])).toEqual(originals);
      if (scenario.endsWith('_after_provenance')) {
        await expect(retryManagedAtomBatch(observedEngine, sourceId, completion.request_id, 'reviewed-retry')).rejects.toMatchObject({ code: 'page_identity_changed' });
        expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
        expect(calls).toBe(1);
        return;
      }
      if (blockedPath) {
        expect(readFileSync(blockedPath, 'utf8')).toBe('Unindexed operator content.');
        rmSync(blockedPath);
      }
      expect(await retryManagedAtomBatch(observedEngine, sourceId, completion.request_id, 'reviewed-retry')).toMatchObject({ status: 'completed', model_rerun: false });
      await disposePersistenceConsumer(observedEngine);
      expect(await retryManagedAtomBatch(observedEngine, sourceId, completion.request_id, 'reviewed-retry')).toMatchObject({ replayed: true, model_rerun: false });
      expect((await runPhaseExtractAtoms(observedEngine, { ...opts, _chat: providerFree })).status).toBe('skipped');
      expect(calls).toBe(1);
      expect(await engine.executeRaw('SELECT request_id,state,outcome,error_code,error_message FROM persistence_requests WHERE source_id=$1 AND request_id=ANY($2::uuid[]) ORDER BY sequence', [sourceId, accepted.map(row => row.request_id)])).toEqual(originals);
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id=$1 AND type='atom' ORDER BY slug", [sourceId])).toEqual([...slugs].sort().map(slug => ({ slug })));
      expect(await engine.executeRaw('SELECT l.id FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, page.slug])).toHaveLength(2);
      expect(await engine.executeRaw('SELECT content_hash,fail_count,tombstoned FROM extract_atoms_page_state WHERE page_id=$1', [page.id])).toEqual([{ content_hash: page.content_hash!, fail_count: 0, tombstoned: true }]);
      expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
      expect(await discoverExtractablePages(engine, sourceId)).toEqual([]);
    });
  } finally {
    await disposePersistenceConsumer(observedEngine);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null);
    rmSync(home, { recursive: true, force: true });
  }
}

export const atomAuthorityCases = ['remote_job', 'stdio', 'missing_source', 'archived_source', 'missing_owner', 'inactive_owner', 'foreign_owner', 'revoked_writer', 'source_grant', 'read_only_grant', 'operation_grant', 'slug_grant'] as const;

export async function exerciseManagedAtomAuthority(engine: BrainEngine, scenario: typeof atomAuthorityCases[number]): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atom-authority-'));
  const sourceId = `atoms-authority-${scenario.replaceAll('_', '-')}`;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/example', { type: 'source', title: 'Example', compiled_truth: 'A project record. '.repeat(40) }, { sourceId });
      const page = (await engine.getPage('notes/example', { sourceId }))!;
      const grant: LocalGrant = { sourceIds: scenario === 'source_grant' ? ['another-source'] : ['*'], operations: scenario === 'operation_grant' ? ['submit_job'] : null,
        scopes: scenario === 'read_only_grant' ? ['read'] : ['read', 'write'], slugPrefixes: scenario === 'slug_grant' ? ['atoms/'] : null };
      const registration = await registerLocalWriter(engine, scenario === 'stdio' ? 'stdio' : 'cli', grant);
      if (scenario.endsWith('_owner')) {
        const root = join(home, 'repo');
        mkdirSync(root);
        await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
        if (scenario !== 'missing_owner') {
          const binding = await claimWorktree(engine, sourceId, root);
          if (scenario === 'inactive_owner') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
          else await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=gen_random_uuid() WHERE id=$1::uuid', [binding.worktree_id]);
        }
      }
      if (scenario === 'missing_source') await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      if (scenario === 'archived_source') await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
      if (scenario === 'revoked_writer') await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [registration.id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      const chat = async (): Promise<ChatResult> => { calls++; throw new Error('Invalid managed authority must never reach a provider'); };
      __setChatTransportForTests(chat);
      for (const dryRun of [false, true]) {
        const run = () => runPhaseExtractAtoms(engine, { sourceId, dryRun, _chat: chat, _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
        const invoked = scenario === 'remote_job' ? withSubmissionAuthority({ version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: 'example-client' },
          grant: { scopes: ['admin'], sourceId, sourceCreatedAt: new Date().toISOString(), allowedTools: ['submit_job'], allowedSlugPrefixes: ['*'] }, payloadHash: '0'.repeat(64) }, run)
          : scenario === 'stdio' ? withVerifiedLocalRegistration(engine, registration, run) : run();
        await expect(invoked).rejects.toMatchObject({ code: scenario.endsWith('_owner') ? 'owner_unavailable' : scenario.endsWith('_source') ? 'source_changed' : 'permission_denied' });
        expect(calls).toBe(0);
        expect(await engine.executeRaw('SELECT request_id FROM persistence_requests WHERE source_id=$1', [sourceId])).toEqual([]);
        expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toEqual([]);
        expect(await engine.executeRaw('SELECT page_id FROM extract_atoms_page_state WHERE page_id=$1', [page.id])).toEqual([]);
        expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId])).toEqual([]);
      }
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null);
    rmSync(home, { recursive: true, force: true });
  }
}
