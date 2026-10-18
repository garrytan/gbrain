/**
 * GBRA-130 A-23: after a completed (paid) patterns child, quote grounding
 * walks every pattern page the child wrote plus every leftover pattern page a
 * crashed run left without quote_verified_at, and wrote each back with no
 * per-page catch. One leftover page whose write-back is refused failed the
 * phase after the child was paid for, left the evidence watermark unstamped,
 * and so paid for a new child every cadence period. Now the page is reported
 * in details.grounding_failed with its code, the other pages ground, the
 * watermark is stamped and the phase warns; a page refused with a content
 * error on 3 runs at the same content hash and producer version is held out
 * of the leftover query (details.grounding_held, with the command that retries
 * it) until the page or the producer changes. Run-scoped errors still fail it.
 *
 * Authoring gate: (1) protects per-page isolation of groundPatternPages and
 * groundTimelineAppends, the watermark on an isolated failure and the durable
 * hold; (2) fails when a grounding loop loses its catch, a failure blocks the
 * watermark, or a hold never clears; (3) test/cycle-patterns-quote-verify.test.ts
 * covers healthy pages only; (4) no production seam: the refusal is a real
 * trigger on pages, and the child is the spied inline drain.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import * as synthesize from '../../src/core/cycle/synthesize.ts';
import * as wait from '../../src/core/minions/wait-for-completion.ts';
import { groundTimelineAppends, runPhasePatterns, type TimelineAppend } from '../../src/core/cycle/patterns.ts';
import { renderTimelineEntry } from '../../src/core/timeline-write-through.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';
import { retainToolWriteRequestId } from '../../src/core/minions/tool-write-identity.ts';
import { persistToolExecComplete, persistToolExecPending } from '../../src/core/minions/handlers/subagent-persistence.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const PREFIX = 'wiki/personal/patterns';
const LEFTOVER = PREFIX + '/old-theme';
const FRESH = PREFIX + '/new-theme';
const HOLDS_KEY = 'dream.patterns.grounding_holds.default';
const EVIDENCE_KEY = 'dream.patterns.last_evidence_ts';

async function withPatternsBrain(databaseUrl: string | undefined, run: (engine: BrainEngine, brainDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-a23-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
        await engine.setConfig('dream.quote_verify', 'true');
        for (const [i, body] of ['I keep saying "ship smaller pieces" when projects stall.', 'Again I told myself to ship smaller pieces.', 'Shipping smaller pieces worked this week.'].entries()) {
          await importFromContent(engine, 'wiki/personal/reflections/r' + (i + 1), '---\ntype: note\ntitle: r' + (i + 1) + '\n---\n' + body + '\n', { noEmbed: true, sourceId: 'default' });
        }
        await run(engine, dir);
      } finally { await close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A pattern page a crashed run left without quote_verified_at. */
const leftover = (engine: BrainEngine, slug = LEFTOVER, body = 'Small pieces recur.') => importFromContent(engine, slug,
  '---\ntype: note\ntitle: ' + slug + '\ndream_generated: true\n---\n' + body + '\n', { noEmbed: true, sourceId: 'default' });

/** Refuses every update of the named pages, the way the database refuses one row's write (a check violation). */
async function refuseWrites(engine: BrainEngine, slugs: string[]): Promise<void> {
  const list = slugs.map(s => "'" + s + "'").join(',');
  await engine.executeRaw('CREATE OR REPLACE FUNCTION patho_refuse_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.slug IN (' + list
    + ") THEN RAISE EXCEPTION 'write refused for %', NEW.slug USING ERRCODE = '23514'; END IF; RETURN NEW; END $$");
  await engine.executeRaw('DROP TRIGGER IF EXISTS patho_refuse_page ON pages');
  await engine.executeRaw('CREATE TRIGGER patho_refuse_page BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION patho_refuse_page()');
}
const allowWrites = (engine: BrainEngine) => engine.executeRaw('DROP TRIGGER IF EXISTS patho_refuse_page ON pages');

/** A completed patterns child that writes FRESH through put_page (the inline drain and its completion wait, spied). */
async function withCompletedChild<T>(engine: BrainEngine, run: () => Promise<T>, afterChild?: () => void): Promise<{ result: T; children: number }> {
  let children = 0;
  const drain = spyOn(synthesize, 'runSubagentsInline').mockImplementation((async (e: BrainEngine, _queue: unknown, queueName: string) => {
    children++;
    const [job] = await e.executeRaw<{ id: number }>('SELECT id FROM minion_jobs WHERE queue = $1 ORDER BY id DESC LIMIT 1', [queueName]);
    await importFromContent(e, FRESH, '---\ntype: note\ntitle: New theme\n---\nShipping smaller pieces recurs (run ' + children + ').\n', { noEmbed: true, sourceId: 'default' });
    await e.executeRaw("INSERT INTO subagent_tool_executions(job_id,message_idx,tool_use_id,tool_name,input,status,ordinal) VALUES($1,0,'toolu_0','brain_put_page',$2::jsonb,'complete',0)",
      [Number(job!.id), JSON.stringify({ slug: FRESH })]);
    afterChild?.();
  }) as never);
  const completed = spyOn(wait, 'waitForCompletionRenewing').mockImplementation((async (_q: unknown, jobId: number) => ({ id: jobId, status: 'completed', error_text: null })) as never);
  try { return { result: await run(), children }; } finally { drain.mockRestore(); completed.mockRestore(); }
}

const patterns = (engine: BrainEngine, brainDir: string, once = true) => runPhasePatterns(engine, { brainDir, dryRun: false, once, cycleDate: '2026-10-15' });
type GroundingRow = { slug: string; code: string; fix: string; held?: boolean };
const holds = async (engine: BrainEngine) => JSON.parse((await engine.getConfig(HOLDS_KEY)) ?? '{}') as { items?: Record<string, { attempts: number; held_at: string | null; producer: string }> };

describe('A-23 patterns grounding isolates one page whose write-back is refused', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test('[' + backend + '] a refused leftover pattern page is reported, the new page grounds and the watermark is stamped', async () => {
      await withPatternsBrain(databaseUrl, async (engine, brainDir) => {
        await leftover(engine);
        await refuseWrites(engine, [LEFTOVER]);
        const before = await snapshotItems(engine, 'default');
        const { result } = await withCompletedChild(engine, () => expectUnitNotAborted(() => patterns(engine, brainDir)));
        expect(result.error?.code).toBeUndefined();
        expect(result.status).toBe('warn');
        const failed = result.details.grounding_failed as GroundingRow[];
        expect(failed).toHaveLength(1);
        expectItemFailure({ key: failed[0]!.slug, code: failed[0]!.code, fix: failed[0]!.fix }, { key: LEFTOVER, code: 'invalid_data', fix: /^gbrain dream --phase patterns --once --source default$/ });
        expect((await engine.getPage(FRESH))!.frontmatter.quote_verified_at).toBe('2026-10-15');
        expect((await engine.getPage(LEFTOVER))!.frontmatter.quote_verified_at).toBeUndefined();
        expect(await engine.getConfig(EVIDENCE_KEY)).not.toBeNull();
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { changed: [FRESH] });
        const again = await withCompletedChild(engine, () => patterns(engine, brainDir, false));
        expect(again.children).toBe(0);
        expect(again.result.details.reason ?? again.result.summary).toMatch(/no_new_evidence|none newer/);
      });
    }, 120_000);

    test('[' + backend + '] three content refusals at one content hash hold the page out of the leftover query until it changes', async () => {
      await withPatternsBrain(databaseUrl, async (engine, brainDir) => {
        await leftover(engine);
        await refuseWrites(engine, [LEFTOVER]);
        for (let run = 1; run <= 3; run++) {
          const { result } = await withCompletedChild(engine, () => patterns(engine, brainDir));
          expect({ run, failed: (result.details.grounding_failed as GroundingRow[]).map(f => f.slug) }).toEqual({ run, failed: [LEFTOVER] });
        }
        expect((await holds(engine)).items?.[LEFTOVER]).toMatchObject({ attempts: 3 });
        expect((await holds(engine)).items?.[LEFTOVER]?.held_at).not.toBeNull();
        const { result } = await withCompletedChild(engine, () => patterns(engine, brainDir));
        expect(result.details.grounding_failed).toEqual([]);
        expect(result.status).toBe('warn');
        const held = result.details.grounding_held as GroundingRow[];
        expectItemFailure({ key: held[0]!.slug, code: held[0]!.code, fix: held[0]!.fix },
          { key: LEFTOVER, code: 'invalid_data', fix: new RegExp('^gbrain config unset ' + HOLDS_KEY.replace(/\./g, '\\.') + ' && gbrain dream --phase patterns --once --source default$') });
        await allowWrites(engine);
        await leftover(engine, LEFTOVER, 'Small pieces recur, edited.');
        const cleared = await withCompletedChild(engine, () => patterns(engine, brainDir));
        expect(cleared.result.details.grounding_held).toEqual([]);
        expect(cleared.result.status).toBe('ok');
        expect((await engine.getPage(LEFTOVER))!.frontmatter.quote_verified_at).toBe('2026-10-15');
        expect((await holds(engine)).items?.[LEFTOVER]).toBeUndefined();
      });
    }, 180_000);

    test('[' + backend + '] a held page is retried once the producer version changes', async () => {
      await withPatternsBrain(databaseUrl, async (engine, brainDir) => {
        await leftover(engine);
        await refuseWrites(engine, [LEFTOVER]);
        for (let run = 1; run <= 3; run++) await withCompletedChild(engine, () => patterns(engine, brainDir));
        const stored = await holds(engine);
        stored.items![LEFTOVER]!.producer = '0.0.0-older';
        await engine.setConfig(HOLDS_KEY, JSON.stringify(stored));
        await allowWrites(engine);
        const { result } = await withCompletedChild(engine, () => patterns(engine, brainDir));
        expect(result.details.grounding_held).toEqual([]);
        expect((await engine.getPage(LEFTOVER))!.frontmatter.quote_verified_at).toBe('2026-10-15');
      });
    }, 180_000);

    test('[' + backend + '] most pages refused trips the breaker and holds nothing', async () => {
      await withPatternsBrain(databaseUrl, async (engine, brainDir) => {
        const slugs = ['a', 'b', 'c', 'd', 'e'].map(x => PREFIX + '/' + x + '-theme');
        for (const slug of slugs) await leftover(engine, slug);
        await refuseWrites(engine, slugs);
        const { result } = await withCompletedChild(engine, () => patterns(engine, brainDir));
        expect(result.status).toBe('fail');
        expect(result.error?.message).toMatch(/items failed at patterns\.ground_pages/);
        expect(await engine.getConfig(HOLDS_KEY)).toBeNull();
        expect(await engine.getConfig(EVIDENCE_KEY)).toBeNull();
      });
    }, 120_000);

    for (const { name, error } of runScopedErrors()) {
      test('[' + backend + '] a run-scoped error while grounding a page still fails the phase (' + name + ')', async () => {
        await withPatternsBrain(databaseUrl, async (engine, brainDir) => {
          await leftover(engine);
          const injected = error();
          // Transaction engines inherit from the engine, so the override forwards `this` (a bound read would leave the transaction).
          const read = engine.readPageSnapshot;
          const inject = () => {
            engine.readPageSnapshot = async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
              if (slug === LEFTOVER) throw injected;
              return read.call(this, slug, opts);
            } as BrainEngine['readPageSnapshot'];
          };
          try {
            const { result } = await withCompletedChild(engine, () => patterns(engine, brainDir), inject);
            expect(result.status).toBe('fail');
            expect(result.error?.code).toBe('PATTERNS_PHASE_FAIL');
          } finally { engine.readPageSnapshot = read; }
          expect(await engine.getConfig(HOLDS_KEY)).toBeNull();
          expect(await engine.getConfig(EVIDENCE_KEY)).toBeNull();
        });
      }, 120_000);
    }
  }
});

/** Two pages with one new timeline entry each, quoting text the reflections never said (so grounding rewrites both). */
async function appendedPages(engine: BrainEngine): Promise<TimelineAppend[]> {
  const out: TimelineAppend[] = [];
  for (const slug of [PREFIX + '/a-theme', PREFIX + '/b-theme']) {
    const rendered = renderTimelineEntry({ date: '2026-10-10', summary: 'You wrote "always test on staging" again', source: 'wiki/personal/reflections/r3' }, slug)!;
    await importFromContent(engine, slug, '---\ntype: note\ntitle: ' + slug + "\ndream_generated: true\nquote_verified_at: '2026-10-01'\n---\nA theme.\n\n<!-- timeline -->\n## Timeline\n\n" + rendered.block + '\n',
      { noEmbed: true, sourceId: 'default' });
    out.push({ slug, requestId: 'req-' + slug, block: rendered.block, marker: '<!-- no marker -->', entry: rendered.canonical });
  }
  return out;
}
const REFLECTIONS = [1, 2, 3].map(i => ({ slug: 'wiki/personal/reflections/r' + i })) as never;
const groundingRun = () => ({ sourceId: 'default', holds: {}, pending: {}, failed: [] as Array<{ key: string; code: string }>, grounded: new Set<string>(), appendsResolved: new Map<string, Set<string>>() });

describe('A-23 timeline-append grounding isolates one page whose write-back is refused', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test('[' + backend + '] a refused timeline-append page is recorded and the other page still grounds', async () => {
      await withPatternsBrain(databaseUrl, async engine => {
        const appends = await appendedPages(engine);
        await refuseWrites(engine, [PREFIX + '/a-theme']);
        const before = await snapshotItems(engine, 'default');
        const grounding = groundingRun();
        const stats = await expectUnitNotAborted(() => groundTimelineAppends(engine, null, appends, REFLECTIONS, 'default', '2026-10-15', undefined, new Set(), undefined, grounding as never));
        expect(stats?.quarantined).toBe(2);
        expectItemFailure(grounding.failed[0], { key: PREFIX + '/a-theme', code: 'invalid_data' });
        expect((await engine.getPage(PREFIX + '/b-theme'))!.timeline).not.toContain('always test on staging');
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { expectProgress: [PREFIX + '/b-theme'], progressFields: ['content_hash'] });
      });
    }, 120_000);

    for (const { name, error } of runScopedErrors()) {
      test('[' + backend + '] a run-scoped error while grounding timeline appends still stops grounding (' + name + ')', async () => {
        await withPatternsBrain(databaseUrl, async engine => {
          const appends = await appendedPages(engine);
          const injected = error();
          const read = engine.readPageSnapshot;
          engine.readPageSnapshot = (async () => { throw injected; }) as BrainEngine['readPageSnapshot'];
          const grounding = groundingRun();
          try {
            await expect(groundTimelineAppends(engine, null, appends, REFLECTIONS, 'default', '2026-10-15', undefined, new Set(), undefined, grounding as never)).rejects.toBe(injected);
          } finally { engine.readPageSnapshot = read; }
          expect(grounding.failed).toEqual([]);
        });
      }, 120_000);
    }
  }
});

const APPENDED = PREFIX + '/a-theme';
const APPENDS_KEY = 'dream.patterns.grounding_appends.default';

/** A pattern page an earlier run verified; a later child appends a timeline entry to it. */
const verifiedPage = (engine: BrainEngine, body = 'A theme.') => importFromContent(engine, APPENDED,
  '---\ntype: note\ntitle: A theme\ndream_generated: true\nquote_verified_at: \'2026-10-01\'\n---\n' + body + '\n', { noEmbed: true, sourceId: 'default' });

/**
 * A completed patterns child that appends one entry quoting text the reflections never said, through the real
 * brain tool and the subagent tool-execution ledger (production request ids and receipts); `afterChild` runs
 * once the child is done and before grounding.
 */
async function withAppendingChild<T>(engine: BrainEngine, databaseUrl: string | undefined, run: () => Promise<T>, afterChild?: () => Promise<unknown>): Promise<{ result: T; children: number }> {
  let children = 0;
  const drain = spyOn(synthesize, 'runSubagentsInline').mockImplementation((async (e: BrainEngine, _queue: unknown, queueName: string) => {
    children++;
    const [job] = await e.executeRaw<{ id: number }>('SELECT id FROM minion_jobs WHERE queue = $1 ORDER BY id DESC LIMIT 1', [queueName]);
    const jobId = Number(job!.id);
    const tool = buildBrainTools({ subagentId: jobId, engine: e, config: { engine: databaseUrl ? 'postgres' : 'pglite' } as GBrainConfig,
      allowedSlugPrefixes: [PREFIX + '/*'], sourceId: 'default' }).find(t => t.name === 'brain_add_timeline_entry')!;
    const input: Record<string, unknown> = { slug: APPENDED, date: '2026-10-1' + children, summary: 'You wrote "always test on staging" again (run ' + children + ')', source: 'wiki/personal/reflections/r3' };
    retainToolWriteRequestId(input, jobId, 1, 0, 'toolu_0', tool.name);
    await persistToolExecPending(e, jobId, 1, 0, 'toolu_0', tool.name, input);
    await persistToolExecComplete(e, jobId, 1, 0, 'toolu_0', await tool.execute(input, { engine: e, jobId, remote: true }));
    await afterChild?.();
  }) as never);
  const completed = spyOn(wait, 'waitForCompletionRenewing').mockImplementation((async (_q: unknown, jobId: number) => ({ id: jobId, status: 'completed', error_text: null })) as never);
  try { return { result: await run(), children }; } finally { drain.mockRestore(); completed.mockRestore(); }
}
const pendingAppends = async (engine: BrainEngine) => JSON.parse((await engine.getConfig(APPENDS_KEY)) ?? '{}') as { items?: Record<string, { attempts: number; held_at: string | null; appends: unknown[] }> };

describe('A-23 a timeline append whose grounding write-back failed is retried on a later run', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test('[' + backend + '] the failed append is recorded durably and the next run grounds it without a new child', async () => {
      await withPatternsBrain(databaseUrl, async (engine, brainDir) => {
        await verifiedPage(engine);
        const first = await withAppendingChild(engine, databaseUrl, () => patterns(engine, brainDir), () => refuseWrites(engine, [APPENDED]));
        expect(first.result.status).toBe('warn');
        expectItemFailure((first.result.details.grounding_failed as GroundingRow[])[0], { key: APPENDED, code: 'invalid_data' });
        expect((await engine.getPage(APPENDED))!.timeline).toContain('always test on staging');
        expect(readFileSync(join(brainDir, APPENDED + '.md'), 'utf8')).toContain('always test on staging');
        expect(await engine.getConfig(EVIDENCE_KEY)).not.toBeNull();
        expect((await pendingAppends(engine)).items?.[APPENDED]).toMatchObject({ attempts: 1, held_at: null });

        await allowWrites(engine);
        const before = await snapshotItems(engine, 'default');
        const again = await withAppendingChild(engine, databaseUrl, () => expectUnitNotAborted(() => patterns(engine, brainDir, false)));
        expect(again.children).toBe(0);
        expect(again.result.details.reason).toBe('no_new_evidence');
        expect(again.result.details.grounding_failed).toEqual([]);
        expect(again.result.details.timeline_append_retry).toMatchObject({ pages: 1, entries: 1, quarantined: 1 });
        const page = (await engine.getPage(APPENDED))!;
        expect(page.timeline).not.toContain('always test on staging');
        expect((page.frontmatter.unverified_claims as Array<{ text: string }>).map(c => c.text).join('\n')).toContain('always test on staging');
        expect((await engine.getTimeline(APPENDED, { sourceId: 'default' })).map(r => r.summary).join('\n')).not.toContain('always test on staging');
        expect(readFileSync(join(brainDir, APPENDED + '.md'), 'utf8').split('\n---\n').slice(1).join('\n---\n')).not.toContain('always test on staging');
        expect(await engine.getConfig(APPENDS_KEY)).toBe(JSON.stringify({ version: 1, items: {} }));
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { expectProgress: [APPENDED], progressFields: ['content_hash'] });
      });
    }, 180_000);

    test('[' + backend + '] an append refused on 3 runs at one content hash is held with a typed warning until the page changes', async () => {
      await withPatternsBrain(databaseUrl, async (engine, brainDir) => {
        await verifiedPage(engine);
        await withAppendingChild(engine, databaseUrl, () => patterns(engine, brainDir), () => refuseWrites(engine, [APPENDED]));
        for (let run = 2; run <= 3; run++) {
          const { result } = await withAppendingChild(engine, databaseUrl, () => patterns(engine, brainDir, false));
          expect({ run, status: result.status, failed: (result.details.grounding_failed as GroundingRow[]).map(f => f.slug) }).toEqual({ run, status: 'warn', failed: [APPENDED] });
        }
        expect((await pendingAppends(engine)).items?.[APPENDED]).toMatchObject({ attempts: 3 });
        expect((await pendingAppends(engine)).items?.[APPENDED]?.held_at).not.toBeNull();
        const held = await withAppendingChild(engine, databaseUrl, () => patterns(engine, brainDir, false));
        expect(held.children).toBe(0);
        expect(held.result.status).toBe('warn');
        expect(held.result.details.grounding_failed).toEqual([]);
        const rows = held.result.details.grounding_held as Array<GroundingRow & { timeline_appends?: number }>;
        expect(rows.map(r => ({ slug: r.slug, code: r.code, timeline_appends: r.timeline_appends }))).toEqual([{ slug: APPENDED, code: 'invalid_data', timeline_appends: 1 }]);
        expectItemFailure({ key: rows[0]!.slug, code: rows[0]!.code, fix: rows[0]!.fix }, { key: APPENDED, code: 'invalid_data', fix: /^gbrain get --source default -- wiki\/personal\/patterns\/a-theme$/ });
        expect((await pendingAppends(engine)).items?.[APPENDED]).toMatchObject({ attempts: 3 });

        await allowWrites(engine);
        const timeline = (await engine.getPage(APPENDED))!.timeline;
        await importFromContent(engine, APPENDED, '---\ntype: note\ntitle: A theme\ndream_generated: true\nquote_verified_at: \'2026-10-01\'\n---\nA theme, edited.\n\n<!-- timeline -->\n## Timeline\n\n' + timeline.replace(/^[\s\S]*?## Timeline\n+/, '') + '\n', { noEmbed: true, sourceId: 'default' });
        const released = await withAppendingChild(engine, databaseUrl, () => patterns(engine, brainDir, false));
        expect(released.result.details.grounding_held).toEqual([]);
        expect(released.result.status).toBe('skipped');
        expect((await engine.getPage(APPENDED))!.timeline).not.toContain('always test on staging');
        expect((await pendingAppends(engine)).items?.[APPENDED]).toBeUndefined();
      });
    }, 240_000);
  }
});
