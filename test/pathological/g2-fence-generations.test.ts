/**
 * GBRA-161 PR 2: facts and takes publish through the generation primitive. A canonical fence retires rows only when it
 * is read whole and valid; an absent, unread or segmented fence holds (`generation_held`, reason `fence_absent`).
 * PGLite; Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pathologicalArms } from './harness.ts';
import { FACTS_FENCE, managedSource, PERSON } from './managed-fixture.ts';
import { renderTakesFence } from '../../src/core/takes-fence.ts';
import { emptyFenceBlock } from '../../src/core/generations/fence.ts';
import { generationHeldCheck } from '../../src/commands/doctor/checks/generations.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import type { GenerationsSelection } from '../../src/core/generations/repair.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';

async function repair(engine: BrainEngine, sourceId: string, selection: GenerationsSelection, expectHash?: string): Promise<RepairResult> {
  const scope = await resolveRepairScope(engine, sourceId);
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  return (await repairRunner(engine, { apply: expectHash !== undefined, noEmbed: true, logger: quiet })).run('generations', scope,
    { explicit: true, sourceFlag: sourceId, generations: selection, ...(expectHash ? { expect: expectHash } : {}) });
}

const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |`;
const SLUG = 'people/alice-example';

async function factRows(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ fact: string; row_num: number | null; expired: boolean }>(
    'SELECT fact, row_num, expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id', [sourceId, SLUG]);
}

const TAKES = (n: number) => `## Takes\n\n${renderTakesFence(Array.from({ length: n }, (_, i) => ({ rowNum: i + 1, claim: `Take ${i + 1}`, kind: 'take' as const,
  holder: 'world', weight: 0.7, active: true })))}\n`;
const FACTS = (n: number) => n ? FACTS_FENCE(Array.from({ length: n }, (_, i) => ROW(i + 1, `Claim ${i + 1}`)).join('\n')) : emptyFenceBlock('facts');

async function liveCounts(engine: BrainEngine, sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<{ facts: number; takes: number }>(`SELECT
    (SELECT count(*)::int FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL) AS facts,
    (SELECT count(*)::int FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2) AS takes`, [sourceId, slug]);
  return { facts: Number(row!.facts), takes: Number(row!.takes) };
}

async function ledger(engine: BrainEngine, sourceId: string, slug: string) {
  return engine.executeRaw<{ kind: string; state: string; retired: number; preimages: number }>(`SELECT g.kind, g.state,
      (SELECT count(*)::int FROM derived_generation_items i WHERE i.generation_id=g.id AND i.action='retired') AS retired,
      (SELECT count(*)::int FROM derived_generation_items i WHERE i.generation_id=g.id AND i.action='retired' AND i.preimage IS NOT NULL) AS preimages
    FROM derived_generations g WHERE g.source_id=$1 AND g.owner_key=$2 AND g.state IN ('live','held') ORDER BY g.kind, g.state`, [sourceId, `page:${slug}`]);
}

describe('GBRA-161 PR 2 fence generations', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`[${backend}] B-5: a page write whose body lost its facts fence keeps every fact live`, async () => {
      await managedSource(databaseUrl, async () => {}, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS_FENCE([ROW(1, 'Alice founded acme-example'), ROW(2, 'Alice plays chess'), ROW(3, 'Alice lives in Lisbon')].join('\n'))));
        expect((await factRows(engine, sourceId)).map(row => [row.row_num, row.expired])).toEqual([[1, false], [2, false], [3, false]]);
        await put(SLUG, PERSON('Alice Example', 'Alice is an example person. The facts section was removed in this edit.\n'));
        expect((await factRows(engine, sourceId)).map(row => [row.fact, row.row_num, row.expired])).toEqual([
          ['Alice founded acme-example', 1, false], ['Alice plays chess', 2, false], ['Alice lives in Lisbon', 3, false]]);
      });
    }, 120_000);

    test(`[${backend}] canonical edits 10→9, 10→1 and 10→0 publish with no shrink floor and record each retired row`, async () => {
      await managedSource(databaseUrl, async () => {}, async ({ engine, sourceId, put }) => {
        for (const keep of [9, 1, 0]) {
          const slug = `people/edit-${keep}-example`;
          await put(slug, PERSON('Edit Example', `${FACTS(10)}\n${TAKES(10)}`));
          expect(await liveCounts(engine, sourceId, slug)).toEqual({ facts: 10, takes: 10 });
          await put(slug, PERSON('Edit Example', `${FACTS(keep)}\n${keep ? TAKES(keep) : emptyFenceBlock('takes')}`));
          expect(await liveCounts(engine, sourceId, slug)).toEqual({ facts: keep, takes: keep });
          expect(await ledger(engine, sourceId, slug)).toEqual([
            { kind: 'fact_fence', state: 'live', retired: 10 - keep, preimages: 10 - keep },
            { kind: 'take_fence', state: 'live', retired: 10 - keep, preimages: 10 - keep }]);
        }
      });
    }, 180_000);

    test(`[${backend}] an absent fence is listed with an ask_user fix in doctor, sync status and get_page`, async () => {
      await managedSource(databaseUrl, async () => {}, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS(3)));
        await put(SLUG, PERSON('Alice Example', 'The facts section was removed in this edit.\n'));
        expect(await ledger(engine, sourceId, SLUG)).toEqual([{ kind: 'fact_fence', state: 'held', retired: 0, preimages: 0 },
          { kind: 'fact_fence', state: 'live', retired: 0, preimages: 0 }]);
        const check = await generationHeldCheck(engine, [sourceId]);
        expect(check.status).toBe('warn');
        const status = await readSyncStatus(engine, sourceId);
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const page = await operationsByName.get_page!.handler(ctx as never, { slug: SLUG }) as { fence_held?: Array<{ kind: string; reason: string; rows: number; fix: Record<string, unknown> }> };
        expect(page.fence_held?.map(hold => [hold.kind, hold.reason, hold.rows])).toEqual([['fact_fence', 'fence_absent', 3]]);
        expect(status.fence_holds.map(hold => [hold.slug, hold.reason, hold.rows])).toEqual([[SLUG, 'fence_absent', 3]]);
        for (const fix of [check.fix as unknown as Record<string, unknown>, status.fence_holds[0]!.fix as unknown as Record<string, unknown>, page.fence_held![0]!.fix]) {
          expect(fix).toMatchObject({ ask_user: true, actor: 'user' });
          expect(fix.argv).toBeUndefined();
          expect(String(fix.why)).toContain('deleted the whole ## Facts section on purpose');
          expect(String(fix.why)).toContain('To keep the rows, restore the ## Facts section');
          expect(String(fix.why)).toContain(emptyFenceBlock('facts'));
          expect(String(fix.user_message)).toContain('To keep them, restore the ## Facts section. To remove them, add this empty section');
        }
        expect(status.next).toEqual(status.fence_holds[0]!.fix);
        await put(SLUG, PERSON('Alice Example', `The facts section was removed in this edit.\n\n${emptyFenceBlock('facts')}`));
        expect(await liveCounts(engine, sourceId, SLUG)).toEqual({ facts: 0, takes: 0 });
        expect(await ledger(engine, sourceId, SLUG)).toEqual([{ kind: 'fact_fence', state: 'live', retired: 3, preimages: 3 }]);
        expect((await generationHeldCheck(engine, [sourceId])).status).toBe('ok');
      });
    }, 180_000);

    if (backend === 'postgres') test(`[${backend}] a returned put has cleared its publication recovery record, so sync status names the fence fix even while the counter lock is contended`, async () => {
      await managedSource(databaseUrl, async () => {}, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS(3)));
        let contended: Promise<unknown> | undefined;
        installFaultHook(async point => {
          if (point !== 'publication:after_commit' || contended) return;
          let locked!: () => void;
          const held = new Promise<void>(resolve => { locked = resolve; });
          contended = engine.transaction(async tx => {
            await tx.executeRaw("SELECT key FROM persistence_counters WHERE key='brain' FOR UPDATE");
            locked();
            await Bun.sleep(1500);
          });
          await held;
        });
        try {
          await put(SLUG, PERSON('Alice Example', 'The facts section was removed in this edit.\n'));
          const [recovery] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [sourceId]);
          const status = await readSyncStatus(engine, sourceId);
          expect(contended).toBeDefined();
          expect(recovery!.n).toBe(0);
          expect(status.next).toEqual(status.fence_holds[0]!.fix);
        } finally {
          installFaultHook(undefined);
          await contended;
        }
      });
    }, 180_000);

    test(`[${backend}] a fence restore transplants only the fence block: body, timeline, tags and the takes fence survive, and a republish keeps the rows`, async () => {
      await managedSource(databaseUrl, async () => {}, async ({ engine, sourceId, put }) => {
        const timeline = '\n<!-- timeline -->\n\n## Timeline\n\n- **2024-02-01** | meeting — Kickoff with acme-example\n';
        const page = (prose: string, facts: number) => PERSON('Alice Example', `${prose}\n\n${TAKES(2)}\n${FACTS(facts)}${timeline}`, 'tags: [alpha-example, beta-example]\n');
        await put(SLUG, page('Alice is an example person.', 3));
        await put(SLUG, page('Alice is an example person.', 1));
        await put(SLUG, page('Alice is an example person. A later edit changed this paragraph.', 1));
        expect(await liveCounts(engine, sourceId, SLUG)).toEqual({ facts: 1, takes: 2 });
        const before = (await engine.readPageSnapshot(SLUG, { sourceId }))!;
        const selection: GenerationsSelection = { kind: 'fact_fence', mode: 'restore', key: `page:${SLUG}` };
        const preview = await repair(engine, sourceId, selection);
        expect(preview.listing).toEqual([{ item: `${sourceId}:page:${SLUG}`, class: 'restore', detail: 'generation 2 back to 1: revive 2, retire 0' }]);
        expect((await repair(engine, sourceId, selection, preview.preview_hash)).outcomes).toEqual({ restored: 1 });
        const after = (await engine.readPageSnapshot(SLUG, { sourceId }))!;
        expect(after.page.compiled_truth).toBe(before.page.compiled_truth.replace(ROW(1, 'Claim 1'), [1, 2, 3].map(n => ROW(n, `Claim ${n}`)).join('\n')));
        expect(after.page.compiled_truth).toContain('A later edit changed this paragraph.');
        expect(after.page.compiled_truth).toContain(TAKES(2));
        expect(after.page.timeline).toBe(before.page.timeline);
        expect((await engine.getTags(SLUG, { sourceId })).sort()).toEqual(['alpha-example', 'beta-example']);
        expect(await liveCounts(engine, sourceId, SLUG)).toEqual({ facts: 3, takes: 2 });
        const [entries] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, SLUG]);
        expect(Number(entries!.n)).toBe(1);
        await put(SLUG, `---\ntitle: Alice Example\ntype: person\ntags: [alpha-example, beta-example]\n---\n# Alice Example\n\n${after.page.compiled_truth.replace(/^# Alice Example\n\n/, '')}${timeline}`);
        expect(await liveCounts(engine, sourceId, SLUG)).toEqual({ facts: 3, takes: 2 });
        const edited = await repair(engine, sourceId, selection);
        expect(edited.listing?.[0]?.class).not.toBe('refused');
      });
    }, 180_000);

    test(`[${backend}] a deleted page expires its facts only on originGone, recording each before-state; rows no fence derived are held no_proof`, async () => {
      const fenceless = 'people/fenceless-example';
      await managedSource(databaseUrl, async ({ engine, sourceId, put }) => {
        await put(SLUG, PERSON('Alice Example', FACTS(2)));
        await put(fenceless, PERSON('Fenceless Example', 'No facts section on this page.\n'));
        await engine.insertFacts( // gbrain-allow-direct-insert: a fence-positioned row no generation recorded (legacy shape)
          [{ fact: 'Legacy positioned claim', kind: 'fact', source: 'chat', row_num: 1, source_markdown_slug: fenceless, visibility: 'world' }], { source_id: sourceId });
        for (const slug of [SLUG, fenceless]) await engine.softDeletePage(slug, { sourceId });
      }, async ({ engine, sourceId }) => {
        await runExtractFacts(engine, { sourceId });
        expect(await liveCounts(engine, sourceId, SLUG)).toEqual({ facts: 0, takes: 0 });
        const [gone] = await engine.executeRaw<{ proof: string; retired: number; preimages: number }>(`SELECT g.completeness->>'proof' AS proof,
            (SELECT count(*)::int FROM derived_generation_items i WHERE i.generation_id=g.id AND i.action='retired') AS retired,
            (SELECT count(*)::int FROM derived_generation_items i WHERE i.generation_id=g.id AND i.action='retired' AND i.preimage IS NOT NULL) AS preimages
          FROM derived_generations g WHERE g.source_id=$1 AND g.kind='fact_fence' AND g.owner_key=$2 AND g.state='live'`, [sourceId, `page:${SLUG}`]);
        expect(gone).toEqual({ proof: 'originGone', retired: 2, preimages: 2 });
        expect(await liveCounts(engine, sourceId, fenceless)).toEqual({ facts: 1, takes: 0 });
        expect(await ledger(engine, sourceId, fenceless)).toEqual([{ kind: 'fact_fence', state: 'held', retired: 0, preimages: 0 }]);
        const [held] = await engine.executeRaw<{ held_reason: string }>("SELECT held_reason FROM derived_generations WHERE owner_key=$1 AND state='held'", [`page:${fenceless}`]);
        expect(held?.held_reason).toBe('no_proof');
      });
    }, 180_000);
  }
});
