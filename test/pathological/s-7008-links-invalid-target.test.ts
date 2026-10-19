/**
 * #7008 (GBRA-133): a remote put_page whose body mentions a target that is not
 * a valid slug (`[[../outside-example]]`, an encoded separator) queued a
 * `links` effect that threw in validateSlug inside lockPageKeys on every
 * attempt. On its own the page lost every mention edge (the effect was counted
 * to PARK_AFTER_FAILURES and skipped as effect_unavailable, valid targets
 * included); when most effects of a pass carried one, the pass looked systemic
 * and every effect retried as item_failures_systemic forever.
 *
 * Protects: an invalid mention target is set aside before any lock, recorded
 * on the effect as skipped with reason invalid_slug and shown on the write
 * receipt's links effect; the page's valid targets are linked on the first
 * pass. A run-scoped failure on the same page still retries (never counted,
 * never skipped). PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { publicEffectsForRequest } from '../../src/core/persistence/effect-journal.ts';
import { listBlockingEffects } from '../../src/core/persistence/blocking-effects.ts';
import { PARK_AFTER_FAILURES } from '../../src/core/persistence/effect-model.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { failLocks, passes } from './effects-fixture.ts';
import { expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors } from './harness.ts';

const TARGET = 'notes/target-example';
const PAGES = Array.from({ length: 6 }, (_, i) => `notes/m-${i + 1}`);
const BAD = 'notes/m-3';
const INVALID = ['../outside-example', 'notes/a%2fb-example'];
const note = (slug: string, body: string) => `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n`;
const withInvalid = `See [[${TARGET}]], [[${INVALID[0]}]] and [[${INVALID[1]}]].`;

type Row = { slug: string; request_id: string; state: string; error_code: string | null; outcome: Record<string, any> | null };
const linksEffects = (engine: BrainEngine) => engine.executeRaw<Row>(`SELECT r.slug,r.id::text AS request_id,e.state,e.error_code,e.outcome
  FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='links' AND r.slug LIKE 'notes/m-%' ORDER BY r.slug`);
const edges = (engine: BrainEngine, from: string) => engine.executeRaw<{ to_slug: string }>(`SELECT t.slug AS to_slug FROM links l
  JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug=$1 AND l.link_source='mcp-remote-mention' ORDER BY t.slug`, [from]);

async function remoteWrites(engine: BrainEngine, ctx: OperationContext, bodies: Map<string, string>): Promise<void> {
  const remote = { remote: true as const, transport: 'http' as const, config: ctx.config, sourceId: 'default', logger: ctx.logger,
    auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default' } };
  for (const [slug, body] of [[TARGET, 'The target.'] as const, ...bodies]) {
    const response = await dispatchToolCall(engine, 'put_page', { request_id: randomUUID(), slug, content: note(slug, body) }, remote);
    const payload = JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
    expect({ slug, isError: response.isError === true, state: payload.state }).toEqual({ slug, isError: false, state: 'committed' });
  }
  // The test's passes are the only effect drainer from here on, so no effect is left running by the resident consumer.
  await disposePersistenceConsumer(engine);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#7008 links effect with an invalid mention target (${backend})`, () => {
    test('#7008 item: one page with invalid targets keeps its valid edge and records each invalid target as skipped', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await remoteWrites(engine, ctx, new Map(PAGES.map(slug => [slug, slug === BAD ? withInvalid : `See [[${TARGET}]].`])));
        await expectUnitNotAborted(() => passes(engine, ctx.config, PARK_AFTER_FAILURES + 1));
        const rows = await linksEffects(engine);
        expect(rows.map(row => ({ slug: row.slug, state: row.state, links: row.outcome?.links, added: row.outcome?.added })))
          .toEqual(PAGES.map(slug => ({ slug, state: 'committed', links: 'committed', added: 1 })));
        const bad = rows.find(row => row.slug === BAD)!;
        expect(bad.outcome!.skipped_targets).toEqual(INVALID.map(slug => ({ slug, reason: 'invalid_slug' })));
        expect(await edges(engine, BAD)).toEqual([{ to_slug: TARGET }]);
        expect((await publicEffectsForRequest(engine, bad.request_id)).find(effect => effect.kind === 'links')).toEqual({ kind: 'links', state: 'committed',
          added: 1, removed: 0, invalid_targets: INVALID.map(slug => ({ slug, reason: 'invalid_slug' })) });
        expect(await listBlockingEffects(engine)).toEqual([]);
      }, { databaseUrl });
    }, 180_000);

    test('#7008 systemic: every page of the pass carrying an invalid target links on the first pass instead of retrying as item_failures_systemic', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await remoteWrites(engine, ctx, new Map(PAGES.map(slug => [slug, withInvalid])));
        await expectUnitNotAborted(() => passes(engine, ctx.config, 1));
        for (const row of await linksEffects(engine)) {
          expect({ slug: row.slug, state: row.state, error_code: row.error_code, links: row.outcome?.links, added: row.outcome?.added })
            .toEqual({ slug: row.slug, state: 'committed', error_code: null, links: 'committed', added: 1 });
        }
        expect(await listBlockingEffects(engine)).toEqual([]);
      }, { databaseUrl });
    }, 180_000);

    for (const injected of runScopedErrors()) {
      test(`#7008 run: a run-scoped failure (${injected.name}) on a page with invalid targets is never counted and stays queued`, async () => {
        await managedBrain(async ({ engine, ctx }) => {
          await remoteWrites(engine, ctx, new Map([[BAD, withInvalid]]));
          const restore = failLocks(engine, new Set([BAD]), injected.error);
          try { await expectUnitNotAborted(() => passes(engine, ctx.config, PARK_AFTER_FAILURES + 1)); } finally { restore(); }
          const [row] = await linksEffects(engine);
          expect({ state: row!.state, outcome: row!.outcome }).toEqual({ state: 'queued', outcome: null });
          await passes(engine, ctx.config, 1);
          expect((await linksEffects(engine))[0]!.outcome).toMatchObject({ links: 'committed', added: 1 });
        }, { databaseUrl });
      }, 180_000);
    }
  });
}
