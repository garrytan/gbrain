import { expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { managedAtomSession } from '../../src/core/persistence/atom-maintenance.ts';
import { retryManagedAtomBatch } from '../../src/core/persistence/atom-retry.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { refreshManagedFilesystemRoots } from '../../src/core/persistence/filesystem-guard.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { withEnv } from './with-env.ts';
import { exerciseManagedAtomAuthority } from './managed-atoms-contract.ts';

export const retryStates = ['failed', 'conflict', 'committed'] as const;
export const retryEdits = ['unchanged', 'before_retry', 'after_validation', 'before_admission', 'after_admission'] as const;

export async function exerciseAtomRetrySourceIsolation(engine: BrainEngine): Promise<void> {
  const priorSource = 'fence-committed-before-admission';
  let phase: 'hold' | 'drain' | 'done' = 'hold';
  let pendingRetryId = '';
  const observe = (target: BrainEngine): BrainEngine => new Proxy(target, {
    get(current, key) {
      if (key === 'transaction' || key === 'transactionDirect') {
        return async <T>(fn: (tx: BrainEngine) => Promise<T>) => current[key](tx => fn(observe(tx)));
      }
      if (key === 'executeRaw') return async (sql: string, args?: unknown[]) => {
        if (sql.includes('SELECT r.* FROM persistence_requests r') && sql.includes('FOR UPDATE OF r SKIP LOCKED')) {
          if (phase === 'hold') {
            const failed = await current.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent ? 'checkpointKey' AND intent->>'kind'='managed_atom_page' AND state='conflict'", [priorSource]);
            if (failed.length) return [];
          }
          if (phase === 'drain') {
            const pending = await current.executeRaw("SELECT id FROM persistence_requests WHERE id=$1::uuid AND state IN ('queued','running')", [pendingRetryId]);
            if (pending.length) return current.executeRaw(sql.replace("WHERE r.state='queued'", "WHERE r.source_id=$3 AND r.state='queued'"), [...args!, priorSource]);
            phase = 'done';
          }
        }
        return current.executeRaw(sql, args);
      };
      const value = Reflect.get(current, key);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  const observedEngine = observe(engine);
  await exerciseAtomRetryFence(observedEngine, 'committed', 'before_admission');
  const pending = await engine.executeRaw<{ id: string; kind: string }>("SELECT id,intent->>'kind' AS kind FROM persistence_requests WHERE source_id=$1 AND intent ? 'checkpointKey' AND state='queued' ORDER BY sequence", [priorSource]);
  expect(pending.map(row => row.kind)).toEqual(['managed_atom_page', 'managed_atom_complete']);
  pendingRetryId = pending[0].id;
  phase = 'drain';
  await exerciseAtomRetryFence(observedEngine, 'committed', 'after_admission');
  expect<string>(phase).toBe('done');
  expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE id=$1::uuid', [pendingRetryId])).toEqual([{ state: 'committed' }]);
}

export async function exerciseAtomRetryFence(engine: BrainEngine, state: typeof retryStates[number], edit: typeof retryEdits[number]): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-atom-retry-fence-'));
  const sourceId = `fence-${state}-${edit.replaceAll('_', '-')}`;
  let observedEngine = engine;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/2026-01-01-example', { type: 'source', title: 'Example', compiled_truth: 'A private project record. '.repeat(40), frontmatter: { visibility: 'private' } }, { sourceId });
      const page = (await engine.getPage('notes/2026-01-01-example', { sourceId }))!;
      const titles = state === 'committed' ? ['Measured progress', 'Explicit ownership'] : ['Measured progress'];
      const slugs = titles.map(title => `atoms/2026-01-01/${title.toLowerCase().replaceAll(' ', '-')}-${sha256(`${page.slug}\0${title}`).slice(0, 8)}`);
      if (state !== 'committed') await engine.putPage(slugs[0], { type: 'atom', title: titles[0], compiled_truth: 'Previously reviewed atom.',
        frontmatter: { source_slug: page.slug, visibility: 'private' } }, { sourceId });
      const originalTarget = await engine.readPageSnapshot(slugs[0], { sourceId });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let retrying = false;
      let injected = false;
      let failureInjected = false;
      let targetReads = 0;
      const independentlyEdit = async () => {
        injected = true;
        await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
          await tx.lockPageKeys([{ sourceId, slug: slugs[0] }]);
          const atom = (await tx.getPage(slugs[0], { sourceId }))!;
          await tx.putPage(slugs[0], { ...atom, compiled_truth: 'Independent correction that must survive retry.' }, { sourceId });
        }));
      };
      const observe = (target: BrainEngine, inTransaction = false): BrainEngine => new Proxy(target, {
        get(current, key) {
          if (key === 'addLinksBatch') return async (...args: Parameters<BrainEngine['addLinksBatch']>) => {
            const links = args[0];
            if (!retrying && !failureInjected && links.some(link => link.to_slug === slugs.at(-1)
              && link.from_source_id === sourceId && link.to_source_id === sourceId)) {
              failureInjected = true;
              if (state === 'conflict') throw new OperationError('revision_conflict', 'Fixture publication conflict');
              throw new Error('Fixture publication failure');
            }
            return current.addLinksBatch(...args);
          };
          if (key === 'readPageSnapshot') return async (...args: Parameters<BrainEngine['readPageSnapshot']>) => {
            const snapshot = await current.readPageSnapshot(...args);
            if (retrying && !inTransaction && args[0] === slugs[0] && args[1]?.sourceId === sourceId && args[1]?.includeDeleted) {
              targetReads++;
              if (!injected && (edit === 'after_validation' && targetReads === 1 || edit === 'before_admission' && targetReads === 2)) await independentlyEdit();
            }
            return snapshot;
          };
          if (key === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
            const result = await current.transaction(tx => fn(observe(tx, true)));
            if (retrying && !injected && edit === 'after_admission' && Array.isArray(result) && result.some(row => row.source_id === sourceId && row.intent?.kind === 'managed_atom_page')) await independentlyEdit();
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
      const first = await runPhaseExtractAtoms(observedEngine, { sourceId, _chat: chat, _transcripts: [],
        _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
      expect(first.status).toBe('warn');
      expect(failureInjected).toBe(true);
      expect(calls).toBe(1);
      const accepted = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      expect(accepted).toHaveLength(slugs.length + 1);
      const completion = await waitForWrite(observedEngine, accepted.at(-1)!, { engine: engine.kind });
      expect(completion.state).toBe('conflict');
      await disposePersistenceConsumer(observedEngine);
      const originals = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      expect(originals[0].state).toBe(state);
      expect(originals[0].page_id).toBe(originalTarget?.page.id ?? null);
      expect(originals[0].intent?.expected_revision).toBe(originalTarget?.revision);
      const beforeRetry = (await engine.readPageSnapshot(slugs[0], { sourceId }))!;
      if (state === 'committed') expect(originals[0].outcome?.revision).toBe(beforeRetry.revision);
      __setChatTransportForTests(async () => { calls++; throw new Error('Retained output must not invoke a provider'); });
      retrying = true;
      if (edit === 'before_retry') await independentlyEdit();
      let retryError: unknown;
      let result: Record<string, unknown> | undefined;
      try { result = await retryManagedAtomBatch(observedEngine, sourceId, completion.request_id, 'reviewed-retry'); }
      catch (error) { retryError = error; }
      if (edit === 'unchanged') {
        expect(retryError).toBeUndefined();
        expect(result).toMatchObject({ status: 'completed', model_rerun: false });
        const [retried] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence DESC LIMIT 1', [sourceId, slugs[0]]);
        expect(retried.page_id).toBe(beforeRetry.page.id);
        expect(retried.intent?.expected_revision).toBe(beforeRetry.revision);
        expect((await engine.getPage(slugs[0], { sourceId }))?.compiled_truth).toContain('Use measured progress to guide the project.');
        await disposePersistenceConsumer(observedEngine);
        expect(await retryManagedAtomBatch(observedEngine, sourceId, completion.request_id, 'reviewed-retry')).toMatchObject({ replayed: true, model_rerun: false });
      } else {
        expect(injected).toBe(true);
        expect((await engine.getPage(slugs[0], { sourceId }))?.compiled_truth).toBe('Independent correction that must survive retry.');
        expect(retryError).toBeInstanceOf(OperationError);
        expect(['page_identity_changed', 'revision_conflict']).toContain((retryError as OperationError).code);
        expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId])).toEqual([]);
      }
      await disposePersistenceConsumer(observedEngine);
      expect(calls).toBe(1);
      expect(await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [originals.map(row => row.id)])).toEqual(originals);
    });
  } finally {
    await disposePersistenceConsumer(observedEngine);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null);
    rmSync(home, { recursive: true, force: true });
  }
}

export const atomWriteThroughValues = ['false', '0', 'OFF', 'No', 'true'] as const;
export const atomOwnerStates = ['absent', 'local', 'remote', 'inactive'] as const;
export const atomDisabledAuthorityCases = ['revoked_writer', 'source_grant', 'archived_source', 'stdio'] as const;

export async function exerciseAtomDisabledAuthority(engine: BrainEngine, scenario: typeof atomDisabledAuthorityCases[number]): Promise<void> {
  await engine.setConfig('sync.write_through', 'false');
  try { await exerciseManagedAtomAuthority(engine, scenario); }
  finally { await engine.setConfig('sync.write_through', 'true'); }
}

export async function exerciseAtomWriteThroughPolicy(engine: BrainEngine, value: typeof atomWriteThroughValues[number], owner: typeof atomOwnerStates[number]): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-atom-write-through-'));
  const sourceId = `atom-policy-${value.toLowerCase()}-${owner}`;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const root = join(home, 'repo');
      mkdirSync(root);
      writeFileSync(join(root, 'operator-file.md'), 'Operator content must not change.');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.putPage('notes/2026-01-01-example', { type: 'source', title: 'Example', compiled_truth: 'A private project record. '.repeat(40), frontmatter: { visibility: 'private' } }, { sourceId });
      const page = (await engine.getPage('notes/2026-01-01-example', { sourceId }))!;
      await registerLocalWriter(engine, 'cli');
      if (owner !== 'absent') {
        const binding = await claimWorktree(engine, sourceId, root);
        if (owner === 'remote') await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=gen_random_uuid() WHERE id=$1::uuid', [binding.worktree_id]);
        if (owner === 'inactive') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
      }
      await engine.setConfig('sync.write_through', value);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await refreshManagedFilesystemRoots(engine);
      const beforeFiles = readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();
      const beforeBytes = beforeFiles.filter(path => statSync(join(root, path)).isFile())
        .map(path => [path, readFileSync(join(root, path)).toString('base64')]);
      let calls = 0;
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria."}]',
          blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const run = () => runPhaseExtractAtoms(engine, { sourceId, _chat: chat, _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
      if (value === 'true' && owner !== 'local') {
        await expect(run()).rejects.toMatchObject({ code: 'owner_unavailable' });
        expect(calls).toBe(0);
        expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).toEqual([]);
        return;
      }
      const session = (await managedAtomSession(engine, sourceId))!;
      expect((await run()).status).toBe('ok');
      await disposePersistenceConsumer(engine);
      expect(calls).toBe(1);
      const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.state === 'committed')).toBe(true);
      const atom = (await engine.getPage(rows[0].slug, { sourceId }))!;
      expect(atom.frontmatter.visibility).toBe('private');
      expect(atom.frontmatter.source_slug).toBe(page.slug);
      if (value !== 'true') {
        expect(readdirSync(root, { recursive: true }).sort()).toEqual(beforeFiles);
        expect(beforeBytes.map(([path]) => [path, readFileSync(join(root, String(path))).toString('base64')])).toEqual(beforeBytes);
        expect(session.binding).toBeNull();
        expect(session.authority.databaseOnlyReason).toBe('disabled_by_config');
        for (const row of rows) {
          expect(row.worktree_id).toBeNull();
          expect(row.authority.databaseOnlyReason).toBe('disabled_by_config');
          expect(row.outcome?.write_through).toEqual({ written: false, skipped: 'disabled_by_config' });
          expect(row.outcome?.persistence).toEqual({ mode: 'database' });
        }
        expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=ANY($1::uuid[]) AND kind='git'", [rows.map(row => row.id)])).toEqual([]);
      } else {
        expect(rows[0].outcome?.persistence).toMatchObject({ mode: 'filesystem', file_written: true });
        expect(readFileSync(join(root, `${rows[0].slug}.md`), 'utf8')).toContain('Measure progress against clear exit criteria.');
      }
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.setConfig('sync.write_through', 'true');
    rmSync(home, { recursive: true, force: true });
  }
}
