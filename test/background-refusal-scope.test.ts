/**
 * #6741 C follow-up (v3 review): the pre-receipt refusal of a background
 * admission to a worktree in recovery (journal.ts assertWorktreeAdmission,
 * admission-origin.ts backgroundWorktreeInactive) is scoped to background
 * origin. The interactive paths an operator uses to get a source out of
 * recovery keep working exactly as before:
 *  - an interactive write (the origin the CLI and MCP surfaces set) is still
 *    admitted against a worktree in recovery;
 *  - `gbrain repair stuck-recovery` resolves a blocked publication on a worktree in
 *    recovery (projection only, no admission);
 *  - a writer self-transfer repairs a `recovery_required` source, after which the
 *    managed purge stops reporting it `writer_not_active`;
 *  - an interactive `gbrain sync` against a worktree in recovery meets the sync's own
 *    owner check, never the background refusal, and admits again once the
 *    worktree is active.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withAdmissionOrigin } from '../src/core/persistence/admission-origin.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerOnboardingPreflight } from '../src/core/persistence/onboarding.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { withEnv } from './helpers/with-env.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { AFTER, EDITED, PRIOR, stuckRecoveryFixture } from './helpers/stuck-recovery-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'gb-bg-scope-'));
const roots: string[] = [];
let engine: PGLiteEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const run = <T>(fn: () => Promise<T>) => withEnv(env, fn);
const logger = { info() {}, warn() {}, error() {} };
const ctxFor = (sourceId: string, admissionOrigin: 'interactive' | 'background'): OperationContext => ({ engine, sourceId, remote: false, dryRun: false, logger,
  config: { engine: engine.kind, embedding_disabled: true } as never, admissionOrigin });
const lifetimeIds = async () => Number((await engine.executeRaw<{ n: string }>("SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key='brain'"))[0]?.n ?? 0);
const setWorktree = (sourceId: string, state: 'active' | 'recovering') =>
  engine.executeRaw('UPDATE persistence_worktrees w SET state=$2 FROM persistence_source_bindings b WHERE b.worktree_id=w.id AND b.source_id=$1', [sourceId, state]);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await run(() => registerLocalWriter(engine, 'cli'));
}, 120_000);
afterAll(async () => {
  await run(() => disposePersistenceConsumer(engine));
  await engine.disconnect();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A claimed source on a git checkout with one committed page, managed persistence on. */
async function source(prefix: string): Promise<{ id: string; root: string }> {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), '---\ntitle: a\n---\nA durable observation at acme-example.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await run(() => disposePersistenceConsumer(engine));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await run(() => claimWorktree(engine, id, root));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

describe('#6741 C v3: interactive paths still admit against a worktree in recovery', () => {
  test('an interactive write is admitted (a receipt and a request id) where a background one is refused before any receipt', () => run(async () => {
    const { id } = await source('interactive-put');
    await setWorktree(id, 'recovering');
    const params = (slug: string) => ({ slug, content: '---\ntitle: Note\ntype: note\n---\nWritten during recovery.', request_id: randomUUID() });
    const before = await lifetimeIds();
    await expect(submitPageMutation(ctxFor(id, 'background'), { operation: 'put_page', params: params('notes/background') }))
      .rejects.toMatchObject({ code: 'owner_unavailable' });
    expect(await lifetimeIds()).toBe(before);
    const receipt = await submitPageMutation(ctxFor(id, 'interactive'), { operation: 'put_page', params: params('notes/interactive') }).catch(error => error);
    expect(String((receipt as Error)?.message ?? '')).not.toContain('Background writes');
    expect(await lifetimeIds()).toBe(before + 1);
    expect((await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug='notes/interactive'", [id])).length).toBe(1);
    await setWorktree(id, 'active');
  }), 120_000);

  test('repair stuck-recovery resolves a blocked publication on a worktree in recovery', () => run(async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const fixture = stuckRecoveryFixture(engine, roots);
    const stuck = await fixture.stuck({ prior: PRIOR, after: AFTER, disk: EDITED });
    const binding = (await getWorktreeBinding(engine, stuck.sourceId))!;
    await engine.executeRaw("UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid", [binding.worktree_id]);
    const before = await lifetimeIds();
    const preview = await fixture.repair(stuck.sourceId);
    const hash = preview.preview_hash;
    expect(preview.affected).toBe(1);
    expect(typeof hash).toBe('string');
    const applied = await fixture.repair(stuck.sourceId, { apply: true, expect: hash!, keep: 'prior' });
    expect(applied).toMatchObject({ applied: 1, complete: true, outcomes: { resolved: 1 } });
    expect(readFileSync(stuck.path, 'utf8')).toBe(PRIOR);
    expect(await getWriteRequestById(engine, stuck.id)).toMatchObject({ state: 'queued', recovery: null, blocked_reason: null });
    expect(await lifetimeIds()).toBe(before);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
  }), 120_000);

  test('a writer self-transfer repairs a recovery_required source; the purge stops reporting it writer_not_active', async () => {
    const id = `transfer-${randomUUID().slice(0, 8)}`, root = join(home, id);
    mkdirSync(root); writeFileSync(join(root, 'note.md'), 'Canonical example');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
    await withEnv({ ...env, GBRAIN_BRAIN_ID: 'host' }, async () => {
      // Writer administration binds to a reviewed state fingerprint; a running consumer's heartbeat would move it.
      await disposePersistenceConsumer(engine);
      const administer = async (operation: 'writer_claim' | 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
        runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
      await administer('writer_claim', { source_id: id, path: root });
      await submitPageMutation(ctxFor(id, 'interactive'), { operation: 'put_page', params: { slug: 'notes/expired', content: '---\ntitle: Expired\ntype: note\n---\nGone soon.', request_id: randomUUID() } });
      const snapshot = await engine.readPageSnapshot('notes/expired', { sourceId: id });
      await submitPageMutation(ctxFor(id, 'interactive'), { operation: 'delete_page', params: { slug: 'notes/expired', expected_revision: snapshot!.revision, request_id: randomUUID() } });
      await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug='notes/expired'", [id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await disposePersistenceConsumer(engine);
      // The physical root drifted (its device id changed): the writer needs recovery.
      const marker = join(root, PHYSICAL_ROOT_MARKER), stamp = JSON.parse(readFileSync(marker, 'utf8'));
      stamp.device = String(BigInt(stamp.device) + 1n); writeFileSync(marker, JSON.stringify(stamp));
      expect((await writerOnboardingPreflight(engine, id)).sources[0]).toMatchObject({ source_id: id, state: 'recovery_required' });
      const blocked = await purgeDeletedPagesCoordinated(engine, 72);
      await disposePersistenceConsumer(engine);
      expect(blocked.blocked).toContainEqual(expect.objectContaining({ source_id: id, code: 'writer_not_active', binding_state: 'recovery_required' }));
      const prepared = await administer('writer_transfer_prepare', { source_id: id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
      await administer('writer_transfer_accept', { source_id: id, path: root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
      expect((await writerOnboardingPreflight(engine, id)).sources[0]?.state).not.toBe('recovery_required');
      const purged = await purgeDeletedPagesCoordinated(engine, 72);
      expect(purged.blocked.filter(b => b.source_id === id)).toEqual([]);
      expect(purged.slugs).toContain('notes/expired');
    });
  }, 120_000);

  test('an interactive sync against a worktree in recovery meets the sync owner check, not the background refusal, and admits once active', () => run(async () => {
    const { id, root } = await source('interactive-sync');
    await setWorktree(id, 'recovering');
    const sync = () => withAdmissionOrigin('interactive', () => performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true } as never));
    const before = await lifetimeIds();
    const refused = await sync().then(() => null, error => error as { code?: string; message?: string });
    expect(refused).toMatchObject({ code: 'owner_unavailable', message: 'Sync must run on the active registered worktree owner.' });
    expect(await lifetimeIds()).toBe(before);
    await setWorktree(id, 'active');
    await sync();
    expect(await lifetimeIds()).toBeGreaterThan(before);
    expect(await engine.readPageSnapshot('a', { sourceId: id })).not.toBeNull();
    expect(root).toBeTruthy();
  }), 120_000);
});
