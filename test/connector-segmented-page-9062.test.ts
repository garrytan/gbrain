/**
 * #9062: a GitHub (API) connector source keeps moving when an item's page is stored in segments.
 *
 * A long issue (a body plus hundreds of comments) runs past the inline ceiling, so its page is stored in segments.
 * Before the fix the connector's publication sealed the page's text projection by reading its timeline whole, so the
 * item never imported; and once such a page existed, every later sweep of a bound source read it whole while checking
 * whether the item was fresh, before any item's failure handling ran, so the whole source stopped on
 * `page_body_segmented` with no slug, run after run. Now a segmented page up to the single-string ceiling imports and
 * re-renders like any other, and one over it is held on its own while the rest of the run imports.
 *
 * PGLite here; PostgreSQL through test/e2e/connector-segmented-page-9062.test.ts.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { readAllSourceHolds } from '../src/core/connectors/item-holds-store.ts';
import { PAGE_INLINE_MAX_BYTES, PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { createConnectorFixture, options, settleConnectorWrites } from './helpers/connector-fixture.ts';
import { fakeGitHub, githubHoldsFetch } from './helpers/connector-holds-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const githubConfig = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_TEST_TOKEN' };
/** A synthetic issue thread past the inline ceiling, so its page is stored in segments. */
const longThread = (tag: string) => {
  const line = (i: number) => `Synthetic comment ${i} (${tag}): ` + 'lorem ipsum '.repeat(8);
  const lines: string[] = [];
  for (let i = 0, bytes = 0; bytes < PAGE_INLINE_MAX_BYTES + 64 * 1024; i++) { lines.push(line(i)); bytes += line(i).length + 2; }
  return lines.join('\n\n');
};

async function state(engine: BrainEngine, id: string) {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]);
  return readManagedConnectorState(engine, id, row.incarnation);
}
const storage = async (engine: BrainEngine, id: string, slug: string) =>
  (await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [id, slug]))[0]?.body_storage ?? null;
const bodyHas = async (engine: BrainEngine, id: string, slug: string, text: string) =>
  (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id
    WHERE p.source_id=$1 AND p.slug=$2 AND strpos(c.chunk_text, $3) > 0`, [id, slug, text]))[0].n > 0;

for (const bound of [false, true]) {
  test(`#9062 (${bound ? 'bound' : 'unbound'} managed source): a long issue stored in segments imports and re-renders, and the rest of the run keeps importing`, async () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = bound ? await boundSource(engine, githubConfig) : await source(engine, githubConfig);
      const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
      const fx = fakeGitHub();
      const run = () => runGitHubSync(engine, f.id, cfg, options, githubHoldsFetch(fx));
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        fx.issues = [{ number: 1, title: 'Synthetic long issue', body: longThread('first'), updated_at: '2026-02-01T00:00:00Z' }];
        expect((await run()).status).not.toBe('partial');
        await settleConnectorWrites(engine, f.id);
        expect(await storage(engine, f.id, 'gh/acme-example/app/1')).toBe('segmented');
        expect((await state(engine, f.id)).last_failure).toBeNull();
        await disposePersistenceConsumer(engine);

        // A new comment on the long issue and a new issue: both import, and the cursor moves past both.
        fx.issues = [{ number: 1, title: 'Synthetic long issue', body: longThread('second'), updated_at: '2026-02-02T00:00:00Z' },
          { number: 2, title: 'Synthetic short issue', body: 'Short body.', updated_at: '2026-02-03T00:00:00Z' }];
        expect((await run()).status).not.toBe('partial');
        await settleConnectorWrites(engine, f.id);
        expect(await storage(engine, f.id, 'gh/acme-example/app/1')).toBe('segmented');
        expect(await bodyHas(engine, f.id, 'gh/acme-example/app/1', '(second)')).toBe(true);
        expect(await bodyHas(engine, f.id, 'gh/acme-example/app/1', '(first)')).toBe(false);
        expect(await storage(engine, f.id, 'gh/acme-example/app/2')).toBe('inline');
        expect((await state(engine, f.id)).last_failure).toBeNull();
        expect(await readAllSourceHolds(engine, { sourceIds: [f.id] }).then(s => s[0]?.held ?? [])).toEqual([]);
        await disposePersistenceConsumer(engine);
        fx.since.length = 0;
        expect((await run()).status).not.toBe('partial');
        expect(fx.since).toEqual(['2026-02-03T00:00:00Z']);
        await settleConnectorWrites(engine, f.id);
        await disposePersistenceConsumer(engine);
      } finally { errors.mockRestore(); }
    }
  }), 300_000);
}

test('#9062 (bound managed source): a segmented page over the single-string ceiling is held on its own; the rest of the source imports and the cursor moves', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    const fx = fakeGitHub();
    const run = () => runGitHubSync(engine, f.id, cfg, options, githubHoldsFetch(fx));
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fx.issues = [{ number: 1, title: 'Synthetic long issue', body: longThread('first'), updated_at: '2026-02-01T00:00:00Z' }];
      await run();
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      // The stored body now reads as over the ceiling a whole-body read takes (a page this size is costly to build in a test).
      await engine.executeRaw('UPDATE pages SET body_bytes=$3 WHERE source_id=$1 AND slug=$2', [f.id, 'gh/acme-example/app/1', PAGE_MAX_BYTES + 1]);
      fx.issues = [{ number: 1, title: 'Synthetic long issue', body: longThread('second'), updated_at: '2026-02-02T00:00:00Z' },
        { number: 2, title: 'Synthetic short issue', body: 'Short body.', updated_at: '2026-02-03T00:00:00Z' }];
      // Every run before the hold fails only that item: the run finishes partial and the rest of the source imports.
      for (let i = 0; i < 3; i++) {
        expect((await run()).status).toBe('partial');
        await settleConnectorWrites(engine, f.id);
        await disposePersistenceConsumer(engine);
        expect(await storage(engine, f.id, 'gh/acme-example/app/2')).toBe('inline');
      }
      const held = (await readAllSourceHolds(engine, { sourceIds: [f.id] }))[0]?.held ?? [];
      expect(held.map(h => ({ key: h.key, code: h.code, class: h.class, slug: h.slug }))).toEqual([
        { key: 'acme-example/app#1', code: 'page_body_segmented', class: 'content', slug: 'gh/acme-example/app/1' }]);
      const next = await run();
      expect(next.status).not.toBe('partial');
      await settleConnectorWrites(engine, f.id);
      expect(await storage(engine, f.id, 'gh/acme-example/app/2')).toBe('inline');
      expect((await state(engine, f.id)).last_failure).toBeNull();
      await disposePersistenceConsumer(engine);
      fx.since.length = 0;
      await run();
      expect(fx.since).toEqual(['2026-02-03T00:00:00Z']);
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      // A new comment re-admits the held item; it fails again on its own and a newer item still imports.
      fx.issues = [{ number: 1, title: 'Synthetic long issue', body: longThread('third'), updated_at: '2026-02-04T00:00:00Z' },
        { number: 3, title: 'Synthetic newer issue', body: 'Newer body.', updated_at: '2026-02-05T00:00:00Z' }];
      await run();
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      expect(await storage(engine, f.id, 'gh/acme-example/app/3')).toBe('inline');
      expect((await state(engine, f.id)).last_failure).toBeNull();
    } finally { errors.mockRestore(); stderr.mockRestore(); }
  }
}), 300_000);
