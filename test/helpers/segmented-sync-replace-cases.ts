/**
 * #8729: a managed sync replace of a page stored in segments, where each write changes only the eof tail row. Shared by
 * the PGLite arm (test/large-pages/segmented-sync-replace-8729.test.ts) and the Postgres arm
 * (test/e2e/segmented-sync-replace-8729-postgres.test.ts).
 *
 * 1. Protects: every replace commits in its own sync run while each write's version prunes the page's segmented history
 *    (versions.segmented_max_per_page 1, so every version prunes and sweeps); the live generation tiles the body; no
 *    staging is left live after a run (the no-op screen aborts the staging its preparation opened, the admitted write
 *    commits its own); a refusal of body_staging_expired records its staging in error_detail, and the run prepares the
 *    page again in the same invocation and commits it.
 * 2. Fails when: the version's prune sweep runs beside the flip (Postgres pipelines the publication's calls), deletes the
 *    tail row the flip just published and the flip refuses body_staging_expired (generation_incomplete), blocking the
 *    source; the screen's staging stays prepared until the idle sweep; or the refusal's error_detail is NULL.
 * 3. PGLite runs pipelined calls in order, so only the Postgres arm can interleave the sweep with the flip; both arms
 *    check the staging and error_detail contracts.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { withEnv } from './with-env.ts';
import { withManagedFixtureWrite } from './managed-e2e-fixture-write.ts';
import { conversationBody } from './conversation-page.ts';

const SLUG = 'conversations/chat-example';
const PATH = 'conversations/chat-example.md';

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string): void { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'test content'); }

export function defineSegmentedSyncReplaceCases(opts: { getEngine: () => BrainEngine; home: string }): void {
  const env = () => ({ GBRAIN_HOME: opts.home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });

  async function fixture(name: string) {
    const engine = opts.getEngine();
    await disposePersistenceConsumer(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('versions.segmented_max_per_page', '1');
    const sourceId = name;
    const root = join(opts.home, sourceId);
    mkdirSync(join(root, 'conversations'), { recursive: true });
    git(root, 'init', '-q');
    writeFileSync(join(root, PATH), '---\ntype: conversation\ntitle: Chat Example\n---\n\n' + conversationBody(2000 * 1024, { seed: 3 }));
    commit(root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect(await performManagedSync(engine, { sourceId, noPull: true })).toMatchObject({ status: 'first_sync', filesImported: 1 });
    const [page] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, SLUG]);
    expect(page!.body_storage).toBe('segmented');
    return { engine, sourceId, root, pageId: Number(page!.id) };
  }

  async function appendTurn(f: { engine: BrainEngine; sourceId: string; root: string }, n: number) {
    appendFileSync(join(f.root, PATH), '\n\n**alice-example**: another turn number ' + n + ' for the tail.\n\n**bob-example**: reply ' + n + '.');
    commit(f.root);
    return performManagedSync(f.engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  }

  async function pageState(engine: BrainEngine, pageId: number) {
    const [page] = await engine.executeRaw<{ gen: string; body_bytes: string; covered: string }>(
      'SELECT p.body_generation::text AS gen, p.body_bytes::text AS body_bytes, (SELECT COALESCE(sum(m.byte_len),0)::text FROM page_body_manifest m WHERE m.page_id=p.id AND m.staging_id IS NULL AND m.gen_from<=p.body_generation AND (m.gen_to IS NULL OR m.gen_to>p.body_generation)) AS covered FROM pages p WHERE p.id=$1', [pageId]);
    const [live] = await engine.executeRaw<{ n: string }>("SELECT count(*)::text AS n FROM page_body_stagings WHERE page_id=$1 AND state IN ('open','sealed','prepared')", [pageId]);
    return { generation: Number(page!.gen), bodyBytes: Number(page!.body_bytes), covered: Number(page!.covered), liveStagings: Number(live!.n) };
  }

  test('each tail-only replace commits in its own run while every version prunes, and leaves no staging live', async () => withEnv(env(), async () => {
    const f = await fixture('replace-8729');
    let generation = (await pageState(f.engine, f.pageId)).generation;
    const liveAfterRun: number[] = [];
    for (let n = 1; n <= 3; n++) {
      const result = await appendTurn(f, n);
      expect(result.failures).toBeUndefined();
      expect(result.status).toBe('synced');
      const state = await pageState(f.engine, f.pageId);
      expect(state.generation).toBe(generation + 1);
      expect(state.covered).toBe(state.bodyBytes);
      liveAfterRun.push(state.liveStagings);
      generation = state.generation;
    }
    expect(await f.engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.sourceId])).toEqual([]);
    expect(liveAfterRun).toEqual([0, 0, 0]);
  }), 600_000);

  test('a body_staging_expired refusal records its staging in error_detail and the run prepares the page again', async () => withEnv(env(), async () => {
    const f = await fixture('expired-8729');
    let expired: string | null = null;
    installFaultHook(async point => {
      if (point !== 'segmented:chunks_staged' || expired !== null) return;
      const running = await f.engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state='running'", [f.sourceId]);
      if (!running.length) return;
      const [row] = await withManagedFixtureWrite(f.engine, [f.sourceId], tx => tx.executeRaw<{ id: string }>(
        "UPDATE page_body_stagings SET state='expired' WHERE page_id=$1 AND state IN ('open','sealed','prepared') RETURNING id::text AS id", [f.pageId]));
      expired = row?.id ?? null;
    });
    let result: Awaited<ReturnType<typeof appendTurn>>;
    try { result = await appendTurn(f, 1); } finally { installFaultHook(undefined); }
    expect(expired).not.toBeNull();
    expect(result.status).toBe('synced');
    const [failed] = await f.engine.executeRaw<{ error_code: string; error_detail: Record<string, unknown> | null }>(
      "SELECT error_code, error_detail FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.sourceId]);
    expect(failed?.error_code).toBe('body_staging_expired');
    expect(failed?.error_detail).toMatchObject({ origin: 'body_staging', staging: { staging_id: expired, state: 'expired' } });
    const state = await pageState(f.engine, f.pageId);
    expect(state.covered).toBe(state.bodyBytes);
    expect(state.liveStagings).toBe(0);
  }), 600_000);
}
