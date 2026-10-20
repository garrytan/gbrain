/**
 * GBRA-130 C-22: `gbrain repair stuck-recovery` on a page recovery whose prior file is over the 24 MiB single-string ceiling.
 *
 * Protects: a soft delete of a canonical file over 24 MiB keeps the prior file as a staged copy (`staging.before`) instead
 * of embedding it. When the file is edited while that write publishes, recovery parks the request `unexpected_file_bytes`
 * and every write on the worktree waits. The preview lists it like a small recovery (both fingerprints, the exact
 * `--keep prior` and `--keep disk` applies), and `--keep prior`, bound to the preview hash, puts the staged prior back byte
 * for byte, after which the delete publishes and a sibling page is untouched.
 * Fails when: the preview lists the recovery as refused (`recovery_large_file_unsupported`, "resolve it by hand": the
 * dead end before v0.60.299.0) or the apply skips the preview binding.
 * Why new: test/large-pages/stuck-recovery-large.slow.test.ts covers every apply branch, crash seam and memory bound in
 * the slow lane; this is the inventory row's regression in the pathological suite, on both engines.
 * Seams: the persistence fault hook at `publication:prepared` (the hand edit, then a transient serialization failure).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { fileSha, writeCanonicalPage } from '../helpers/large-page-file.ts';
import { expectOthersUnchanged, pathologicalArms, snapshotItems } from './harness.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-c22-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const MiB = 1024 * 1024;
const EDIT = 'edited by hand while the delete was publishing\n';

afterEach(() => installFaultHook(undefined));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await call(); }
    catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; await Bun.sleep(1000); }
  }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`C-22 stuck-recovery of a large-file page recovery (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (databaseUrl) { const pg = await isolatedPersistencePostgres(databaseUrl); engine = pg.engine; close = pg.close; return; }
      const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
    }, 120_000);
    afterAll(() => withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); await close?.(); }));

    test('C-22 item: the preview lists a stuck recovery over 24 MiB with both fingerprints, and --keep prior restores the staged prior and lets the delete publish', () => withEnv(env, async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const root = join(home, `src-${randomUUID().slice(0, 8)}`);
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: root });
      const sourceId = `c22-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;

      const sibling = join(root, 'notes/sibling.md');
      writeCanonicalPage(sibling, 4096, 7);
      expect(await settled(() => importManagedFile(engine, sibling, 'notes/sibling.md', { sourceId, noEmbed: true }))).toMatchObject({ status: 'imported' });
      const slug = 'notes/large';
      const file = join(root, `${slug}.md`);
      const prior = writeCanonicalPage(file, 25 * MiB, 22);
      expect(await settled(() => importManagedFile(engine, file, `${slug}.md`, { sourceId, noEmbed: true }))).toMatchObject({ status: 'imported' });
      const before = await snapshotItems(engine, sourceId);

      installFaultHook(async (point, detail) => {
        if (point !== 'publication:prepared' || detail.sourceId !== sourceId || detail.operation !== 'delete_page') return;
        appendFileSync(file, EDIT);
        throw Object.assign(new Error('simulated serialization failure'), { code: '40001' });
      });
      const expected_revision = (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
      try { await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision, request_id: randomUUID() } }).catch(() => undefined); }
      finally { installFaultHook(undefined); }
      await disposePersistenceConsumer(engine);
      const [row] = await engine.executeRaw<{ id: string; request_id: string; recovery: any }>(
        "SELECT id::text, request_id::text, recovery FROM persistence_requests WHERE source_id=$1 AND operation='delete_page' AND state='recovering' AND blocked_reason='unexpected_file_bytes'", [sourceId]);
      expect(row!.recovery).toMatchObject({ before: null, beforeHash: prior.sha, staging: { before: { hash: prior.sha, bytes: prior.size } } });
      const edited = { sha: fileSha(file), size: statSync(file).size };

      let out = '';
      const log = console.log;
      console.log = (...parts: unknown[]) => { out += `${parts.map(String).join(' ')}\n`; };
      try { await runRepairCommand(engine, ['stuck-recovery', '--source', sourceId]); } finally { console.log = log; }
      expect(out).not.toContain('recovery_large_file_unsupported');
      expect(out).not.toContain('by hand');
      expect(out).toContain(`request ${row!.request_id} (delete_page ${sourceId}:${slug}, recovering, unexpected_file_bytes`);
      expect(out).toContain(`prior: sha256 ${prior.sha.slice(0, 16)}… size ${prior.size}`);
      expect(out).toContain(`disk:  sha256 ${edited.sha.slice(0, 16)}… size ${edited.size}`);
      const hash = /--expect ([0-9a-f]{64})/.exec(out)![1]!;
      expect(out).toContain(`gbrain repair stuck-recovery --source ${sourceId} --keep prior --apply --expect ${hash} --yes`);
      expect(out).toContain(`gbrain repair stuck-recovery --source ${sourceId} --keep disk --apply --expect ${hash} --yes`);

      const scope = await resolveRepairScope(engine, sourceId);
      const stale = await (await repairRunner(engine, { apply: true })).run('stuck-recovery', scope, { sourceFlag: sourceId, explicit: true, expect: '0'.repeat(64), keep: 'prior' })
        .then(() => null, (error: { code?: string }) => error.code);
      expect(stale).toBe('preview_changed');
      expect(fileSha(file)).toBe(edited.sha);

      const result = await (await repairRunner(engine, { apply: true })).run('stuck-recovery', scope, { sourceFlag: sourceId, explicit: true, expect: hash, keep: 'prior' });
      expect(result).toMatchObject({ applied: 1, complete: true, outcomes: { resolved: 1 } });
      expect(fileSha(file)).toBe(prior.sha);
      const queued = (await getWriteRequestById(engine, row!.id))!;
      expect(queued).toMatchObject({ state: 'queued', recovery: null, blocked_reason: null });
      expect((await waitForWrite(engine, queued, { engine: engine.kind } as never, 120_000)).state).toBe('committed');
      expect(existsSync(file)).toBe(false);
      const after = await snapshotItems(engine, sourceId);
      expect(after.get(slug)?.deleted_at).not.toBeNull();
      expectOthersUnchanged(before, after, { changed: [slug] });
    }), 600_000);
  });
}
