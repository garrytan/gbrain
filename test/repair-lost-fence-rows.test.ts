/**
 * `gbrain repair lost-fence-rows` brings back fact and take rows an older gbrain retired after a page rewrite dropped
 * their section and a later write re-created the section without them. The lost state is built with page writes:
 * a section with the rows, a rewrite without it (the rows stay held), then a section holding only a new row (what
 * remember or takes_add used to write), which retires them. A row removed by an edit inside a section that stayed, or by
 * an explicit empty section, is a deliberate removal and is never listed. Nothing is restored without a preview.
 * Managed brain, repo-less and Git-backed; PGLite, and Postgres from test/postgres-unit-arms.txt.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { emptyFenceBlock } from '../src/core/generations/fence.ts';
import { resolveRepairScope, runRepair, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const gitSetup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | user said so |  |`;
const FACTS = (...rows: string[]) => `## Facts\n\n<!--- gbrain:facts:begin -->\n\n${HEADER}${rows.join('\n')}\n<!--- gbrain:facts:end -->\n`;
const TAKES = (...rows: Array<[number, string]>) => `## Takes\n\n${renderTakesFence(rows.map(([rowNum, claim]) => ({ rowNum, claim, kind: 'bet', holder: 'world', weight: 0.5, active: true })))}\n`;
const PAGE = (body: string) => `---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n${body}`;
const SLUG = 'people/alice-example';
const A = 'Alice Example is allergic to peanuts';
const B = 'Alice Example rides a bike to work';
const TA = 'Acme Example reaches profitability in 2027';
const TB = 'Acme Example hires a finance lead this year';

const put = async (ctx: OperationContext, content: string) => {
  const prior = await ctx.engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  await operationsByName.put_page!.handler(ctx, { slug: SLUG, content, request_id: randomUUID(), ...(prior ? { expected_revision: prior.revision } : {}) });
};
const live = async (engine: BrainEngine) => ({
  facts: (await engine.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND expired_at IS NULL ORDER BY row_num", [SLUG])).map(r => r.fact),
  takes: (await engine.executeRaw<{ claim: string }>("SELECT t.claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY t.row_num", [SLUG])).map(r => r.claim),
});
const tierOf = async (engine: BrainEngine, table: 'facts' | 'takes', claim: string) => (await engine.executeRaw<{ trust_tier: string }>(table === 'facts'
  ? "SELECT trust_tier FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL" : 'SELECT trust_tier FROM takes WHERE claim=$1', [claim]))[0]?.trust_tier;
async function repair(engine: BrainEngine, expectHash?: string): Promise<RepairResult> {
  const scope = await resolveRepairScope(engine, 'default');
  return (await repairRunner(engine, { apply: expectHash !== undefined, noEmbed: true, logger: { info() {}, warn() {}, error() {} } })).run('lost-fence-rows', scope,
    { explicit: true, sourceFlag: 'default', ...(expectHash ? { expect: expectHash } : {}), });
}
/** The section with the rows, a rewrite without it (held), then a section holding only a new row: the rows are retired. */
async function loseRows(ctx: OperationContext) {
  await put(ctx, PAGE(`Alice v1.\n\n${FACTS(ROW(1, A))}\n${TAKES([1, TA])}`));
  await put(ctx, PAGE('Alice v2, rewritten without its sections.\n'));
  expect(await live(ctx.engine)).toEqual({ facts: [A], takes: [TA] });
  await put(ctx, PAGE(`Alice v2, rewritten without its sections.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
  await put(ctx, PAGE(`Alice v3, tagged.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
  expect(await live(ctx.engine)).toEqual({ facts: [B], takes: [TB] });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const storage of ['repo-less', 'git'] as const) {
    const opts = { databaseUrl, ...(storage === 'git' ? { setup: gitSetup } : {}) };
    describe(`gbrain repair lost-fence-rows (${backend}, ${storage})`, () => {
      test('lists the rows a re-created section retired, writes nothing on preview, and restores exactly that set on apply', () => managedBrain(async ({ engine, ctx, root }) => {
        await loseRows(ctx);
        const revision = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
        const preview = await repair(engine);
        expect(preview.affected).toBe(1);
        expect(preview.listing?.map(l => l.class)).toEqual(['restore']);
        expect(preview.listing?.[0]?.detail).toContain(A);
        expect(preview.listing?.[0]?.detail).toContain(TA);
        expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision).toBe(revision);
        expect(await live(engine)).toEqual({ facts: [B], takes: [TB] });
        const applied = await repair(engine, preview.preview_hash);
        expect(applied.applied).toBe(1);
        expect(await live(engine)).toEqual({ facts: [A, B], takes: [TA, TB] });
        const rows = await engine.executeRaw<{ fact: string; row_num: number | null; expired: boolean }>(
          "SELECT fact, row_num, expired_at IS NOT NULL AS expired FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id", [SLUG]);
        expect(rows.map(r => [r.fact, r.row_num, r.expired])).toEqual([[A, null, true], [B, 2, false], [A, 1, false]]);
        if (storage === 'git') await settleManagedGitEffects(engine);
        const file = readFileSync(join(root, `${SLUG}.md`), 'utf8');
        for (const claim of [A, B, TA, TB]) expect(file).toContain(claim);
        expect((await repair(engine)).affected).toBe(0);
      }, opts), 180_000);

      test('a row removed by an edit inside a section that stayed is not listed', () => managedBrain(async ({ engine, ctx }) => {
        await put(ctx, PAGE(`Alice v1.\n\n${FACTS(ROW(1, A), ROW(2, B))}\n${TAKES([1, TA], [2, TB])}`));
        await put(ctx, PAGE(`Alice v2.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
        expect(await live(engine)).toEqual({ facts: [B], takes: [TB] });
        await put(ctx, PAGE('Alice v3, rewritten without its sections.\n'));
        await put(ctx, PAGE(`Alice v3.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
        expect((await repair(engine)).affected).toBe(0);
      }, opts), 180_000);

      test('rows retired by an explicit empty section are not listed', () => managedBrain(async ({ engine, ctx }) => {
        await put(ctx, PAGE(`Alice v1.\n\n${FACTS(ROW(1, A))}\n${TAKES([1, TA])}`));
        await put(ctx, PAGE('Alice v2, rewritten without its sections.\n'));
        await put(ctx, PAGE(`Alice v2.\n\n${emptyFenceBlock('facts')}\n${emptyFenceBlock('takes')}`));
        expect(await live(engine)).toEqual({ facts: [], takes: [] });
        await put(ctx, PAGE(`Alice v3.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
        expect((await repair(engine)).affected).toBe(0);
      }, opts), 180_000);

      test('a forgotten fact and a removed take are not listed', () => managedBrain(async ({ engine, ctx }) => {
        await put(ctx, PAGE(`Alice v1.\n\n${FACTS(ROW(1, A))}\n${TAKES([1, TA])}`));
        const [{ id }] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE source_id='default' AND fact=$1", [A]);
        await operationsByName.forget!.handler(ctx, { id: String(id), reason: 'the user withdrew it' });
        await operationsByName.takes_remove!.handler(ctx, { slug: SLUG, row_num: 1 });
        await put(ctx, PAGE('Alice v2, rewritten without its sections.\n'));
        await put(ctx, PAGE(`Alice v3.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
        await put(ctx, PAGE(`Alice v4, tagged.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
        expect(await live(engine)).toEqual({ facts: [B], takes: [TB] });
        expect((await repair(engine)).affected).toBe(0);
      }, opts), 180_000);

      test('a lost row the user re-added and then withdrew again is not listed', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        const { id } = await operationsByName.remember!.handler(ctx, { fact: A, entity: SLUG, provenance: 'the user said so', content_origin: 'user_said', request_id: randomUUID() }) as { id: number };
        await operationsByName.forget!.handler(ctx, { id: String(id), reason: 'the user withdrew it' });
        const added = await operationsByName.takes_add!.handler(ctx, { slug: SLUG, claim: TA, kind: 'bet', holder: 'world', request_id: randomUUID() }) as { row_num: number };
        await operationsByName.takes_remove!.handler(ctx, { slug: SLUG, row_num: added.row_num, request_id: randomUUID() });
        expect(await live(engine)).toEqual({ facts: [B], takes: [TB] });
        expect((await repair(engine)).affected).toBe(0);
      }, opts), 180_000);

      test('a lost row the user put back by hand and then deleted from the section is not listed', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        await put(ctx, PAGE(`Alice v4.\n\n${FACTS(ROW(2, B), ROW(3, A))}\n${TAKES([2, TB], [3, TA])}`));
        await put(ctx, PAGE(`Alice v5.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
        expect(await live(engine)).toEqual({ facts: [B], takes: [TB] });
        expect((await repair(engine)).affected).toBe(0);
      }, opts), 180_000);

      test('a lost row is not listed once the user wrote an explicit empty section after the loss', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        await put(ctx, PAGE(`Alice v4.\n\n${emptyFenceBlock('facts')}\n${emptyFenceBlock('takes')}`));
        await put(ctx, PAGE(`Alice v5.\n\n${FACTS(ROW(3, B))}\n${TAKES([3, TB])}`));
        expect((await repair(engine)).affected).toBe(0);
      }, opts), 180_000);

      test('a restored fact whose expired row has no stored tier comes back at the lowest tier, and the preview says so', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("DELETE FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NOT NULL", [A]), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine);
        expect(preview.affected).toBe(1);
        expect(JSON.stringify(preview.listing)).toContain('at the lowest trust tier: no record of its earlier tier');
        await repair(engine, preview.preview_hash);
        expect(await tierOf(engine, 'facts', A)).toBe('external_untrusted');
      }, opts), 180_000);

      test('a restored take comes back at the lowest tier: a deleted take keeps no record of its tier', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        const preview = await repair(engine);
        await repair(engine, preview.preview_hash);
        expect(await tierOf(engine, 'takes', TA)).toBe('external_untrusted');
      }, opts), 180_000);

      test('an apply whose page write is left pending lowers the restored tiers when it is rerun', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        const preview = await repair(engine);
        const first = await withEnv({ GBRAIN_WRITE_WAIT_MS: '0' }, () => repair(engine, preview.preview_hash));
        await settleManagedGitEffects(engine);
        for (let i = 0; i < 100 && !(await live(engine)).facts.includes(A); i++) await Bun.sleep(100);
        const now = await live(engine);
        expect({ facts: now.facts.sort(), takes: now.takes.sort() }).toEqual({ facts: [A, B].sort(), takes: [TA, TB].sort() });
        if (first.stopped?.reason === 'write_pending') await repair(engine, preview.preview_hash);
        expect(await tierOf(engine, 'takes', TA)).toBe('external_untrusted');
        expect(first.stopped?.reason).toBe('write_pending');
      }, opts), 180_000);

      test('an apply whose pending page write publishes while the run waits still lowers the restored tiers', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        const preview = await repair(engine);
        const scope = await resolveRepairScope(engine, 'default');
        const { handler } = repairSpec('lost-fence-rows');
        const result = await runRepair({ ...ctx, remote: false, dryRun: false, writeWaitMs: 5_000 } as OperationContext,
          { ...handler, apply: (itemCtx, item, opts) => handler.apply({ ...itemCtx, writeWaitMs: 0 }, item, opts) }, scope,
          { apply: true, explicit: true, sourceFlag: 'default', expect: preview.preview_hash, spec: repairSpec('lost-fence-rows'),
            publicationOwner: async () => { await settleManagedGitEffects(engine); return { alive: true, owner: 'test publisher' }; } });
        if (result.stopped?.reason === 'write_pending') await repair(engine, preview.preview_hash);
        expect(await tierOf(engine, 'takes', TA)).toBe('external_untrusted');
      }, opts), 180_000);

      test('an apply after the page changed restores nothing and asks for a new preview', () => managedBrain(async ({ engine, ctx }) => {
        await loseRows(ctx);
        const preview = await repair(engine);
        await put(ctx, PAGE(`Alice v4, edited after the preview.\n\n${FACTS(ROW(2, B))}\n${TAKES([2, TB])}`));
        const applied = await repair(engine, preview.preview_hash);
        expect(applied.applied).toBe(0);
        expect(await live(engine)).toEqual({ facts: [B], takes: [TB] });
      }, opts), 180_000);
    });
  }
}
