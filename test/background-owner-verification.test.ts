/**
 * #6741 C (final v3 review, item 5): the reporter's `recovery_required` came from a deleted `.gbrain-owner.json`
 * while the worktree state was still `active`, so a state-only check misses it. A background producer runs the
 * claim's owner verification (the canonical paths, the physical root and its marker, owner-verification.ts: the
 * check writer onboarding reports as `recovery_required`) once per source per run, caches it for the run, and
 * skips the source with `owner_unavailable` and the owner-status fix when it fails; the purge's per-source
 * writer preflight runs the same verification. Interactive writes are unaffected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withAdmissionOrigin } from '../src/core/persistence/admission-origin.ts';
import { writerOnboardingPreflight } from '../src/core/persistence/onboarding.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/root-metadata.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'owner-verify';
let engine: PGLiteEngine;
let dir: string;
let root: string;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

const env = () => ({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
const logger = { info() {}, warn() {}, error() {} };
const ctxFor = (admissionOrigin: 'interactive' | 'background'): OperationContext => ({ engine, sourceId: SOURCE, remote: false, dryRun: false, logger,
  config: { engine: engine.kind, embedding_disabled: true } as never, admissionOrigin });
const put = (origin: 'interactive' | 'background', slug: string) => submitPageMutation(ctxFor(origin), { operation: 'put_page',
  params: { slug, content: '---\ntitle: Note\ntype: note\n---\nBackground maintenance output.', request_id: randomUUID() } });
const lifetimeIds = async () => Number((await engine.executeRaw<{ n: string }>("SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key='brain'"))[0]?.n ?? 0);
const worktreeState = async () => (await engine.executeRaw<{ state: string }>(
  'SELECT w.state FROM persistence_worktrees w JOIN persistence_source_bindings b ON b.worktree_id=w.id WHERE b.source_id=$1', [SOURCE]))[0]?.state;
const deleteMarker = () => rmSync(join(root, PHYSICAL_ROOT_MARKER));

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-owner-verify-'));
  root = join(dir, 'brain');
  mkdirSync(root);
  await withEnv(env(), async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await engine.setConfig('sync.write_through', 'true');
    await claimWorktree(engine, SOURCE, root);
    await submitPageMutation(ctxFor('interactive'), { operation: 'put_page', params: { slug: 'notes/expired', content: '---\ntitle: Expired\ntype: note\n---\nGone soon.', request_id: randomUUID() } });
    const snapshot = await engine.readPageSnapshot('notes/expired', { sourceId: SOURCE });
    await submitPageMutation(ctxFor('interactive'), { operation: 'delete_page', params: { slug: 'notes/expired', expected_revision: snapshot!.revision, request_id: randomUUID() } });
    await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug='notes/expired'", [SOURCE]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });
  expect(existsSync(join(root, PHYSICAL_ROOT_MARKER))).toBe(true);
});
afterEach(async () => { await disposePersistenceConsumer(engine); rmSync(dir, { recursive: true, force: true }); });

describe('#6741 C: the owner marker deleted while the worktree state is still active', () => {
  test('writer onboarding reports recovery_required for it, with the state still active', async () => {
    deleteMarker();
    expect(await worktreeState()).toBe('active');
    const [source] = (await withEnv(env(), () => writerOnboardingPreflight(engine, SOURCE))).sources;
    expect(source).toMatchObject({ source_id: SOURCE, state: 'recovery_required', physical_error: expect.any(String) });
  });

  test('the purge spends no request id and reports why, and the cycle purge phase warns', async () => {
    deleteMarker();
    const before = await lifetimeIds();
    const result = await withEnv(env(), () => purgeDeletedPagesCoordinated(engine, 72));
    expect(result).toMatchObject({ count: 0, failed: 0, inactive: 1 });
    expect(result.blocked).toEqual([expect.objectContaining({ slug: 'notes/expired', code: 'writer_not_active', binding_state: 'recovery_required' })]);
    expect(result.blocked[0]!.reason.length).toBeGreaterThan(80);
    const phase = (await withEnv(env(), () => runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: SOURCE }))).phases.find(p => p.phase === 'purge')!;
    expect(phase.status).toBe('warn');
    expect(await lifetimeIds()).toBe(before);
  }, 120_000);

  test('a background admission is refused owner_unavailable with the owner-status fix before any receipt', async () => {
    deleteMarker();
    const before = await lifetimeIds();
    const refusal = await withEnv(env(), () => put('background', 'notes/background')).then(() => null, error => error as { code: string; message: string; fix?: { argv?: string[] } });
    expect(refusal).toMatchObject({ code: 'owner_unavailable', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', SOURCE, '--json'] } });
    expect(refusal!.message).toContain(SOURCE);
    expect(await lifetimeIds()).toBe(before);
    expect((await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE slug='notes/background'")).length).toBe(0);
  }, 120_000);

  test('the verification runs once per source per background run and is cached for that run', async () => {
    await withEnv(env(), () => withAdmissionOrigin('background', async () => {
      await put('background', 'notes/first');
      deleteMarker();
      // Same run: the cached verification (taken before the marker went) stands, so this one is admitted; its
      // publication then meets the owner check itself and ends recovery_required.
      const idsBefore = await lifetimeIds();
      const second = await put('background', 'notes/second').then(() => null, error => error as { code?: string });
      expect(second?.code).toBe('recovery_required');
      expect(await lifetimeIds()).toBe(idsBefore + 1);
    }));
    const before = await lifetimeIds();
    // A new run verifies again and refuses.
    await expect(withEnv(env(), () => withAdmissionOrigin('background', () => put('background', 'notes/third')))).rejects.toMatchObject({ code: 'owner_unavailable' });
    expect(await lifetimeIds()).toBe(before);
  }, 120_000);

  test('a failed verification is cached too: the run refuses each later admission without spending an id', async () => {
    deleteMarker();
    const before = await lifetimeIds();
    await withEnv(env(), () => withAdmissionOrigin('background', async () => {
      for (const slug of ['notes/a', 'notes/b', 'notes/c']) await expect(put('background', slug)).rejects.toMatchObject({ code: 'owner_unavailable' });
    }));
    expect(await lifetimeIds()).toBe(before);
  }, 120_000);

  test('an interactive admission is not subject to the background verification', async () => {
    deleteMarker();
    const before = await lifetimeIds();
    await withEnv(env(), () => put('interactive', 'notes/interactive')).catch(() => undefined);
    expect(await lifetimeIds()).toBe(before + 1);
  }, 120_000);
});
