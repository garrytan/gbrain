/**
 * GBRA-130 A-25: propose_takes (src/core/cycle/propose-takes.ts) listed the
 * newest pages first, never memoized a failed extraction and halted after 5
 * failures with zero successes. A page whose extractor call fails the same
 * way every time (a prompt too long for the model, a provider content block)
 * was re-billed every cycle, and when the 5 newest uncached pages all failed,
 * the zero-success halt fired before any older page every run.
 *
 * Authoring gate: (1) protects "a deterministically failing page stops being
 * billed and never blocks the rest": a page that failed before is retried
 * after the fresh pages, the halt streak skips only a recorded page repeating
 * its content-class code (a transient or provider failure always counts, so a
 * 12-page outage halts systemic on every run), and a page
 * failing with the same content-class code in 3 counted runs at the same
 * content hash and prompt version gets a failure tombstone (distinct from a
 * successful empty extraction) that `gbrain takes propose --retry-failed`
 * releases and that a content or prompt-version change bypasses; a
 * run-scoped extractor error stops the phase and records nothing; a run where
 * most fresh pages fail counts nothing. (2) Reverting the ordering or the
 * counting makes the item case red (the healthy page never gets a proposal).
 * (3) test/propose-takes.test.ts pins the #3763 halt on a mock engine, never
 * a failing head of the list across runs. (4) No production seam: the
 * extractor is the phase's existing injection point.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../../src/core/cycle/propose-takes.ts';
import { retryFailedProposals } from '../../src/core/cycle/propose-takes-failures.ts';
import { runTakes } from '../../src/commands/takes.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const PAGES = ['page-01', 'page-02', 'page-03', 'page-04', 'page-05', 'page-06'];
const OUTAGE_PAGES = Array.from({ length: 12 }, (_, i) => `page-${String(i + 1).padStart(2, '0')}`);
const POISON = new Set(PAGES.slice(0, 5));
const HEALTHY = 'page-06';
const tooLong = () => Object.assign(new AIConfigError('[chat(anthropic:claude-example)] prompt is too long: 250000 tokens > 200000 maximum'), { status: 400 });

interface Failed { slug: string; key: string; code: string; class: string; attempts: number; held: boolean; fix: unknown }

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>, pages = PAGES): Promise<void> {
  const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
  try {
    for (const [i, slug] of pages.entries()) {
      await engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: `Body of ${slug}: liquidity decides which marketplace wins.`, timeline: '', frontmatter: {} });
      await engine.executeRaw(`UPDATE pages SET updated_at = now() - ($1::int * interval '1 hour') WHERE source_id = $2 AND slug = $3`, [i + 1, SOURCE, slug]);
    }
    await run(engine);
  } finally { await close(); }
}

const ctx = (engine: BrainEngine): OperationContext => ({ engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
  dryRun: false, remote: false, sourceId: SOURCE });

function extractor(failing: (slug: string) => unknown | null, calls: string[] = []): ProposeTakesExtractor {
  return async ({ pagePath }) => {
    calls.push(pagePath);
    const error = failing(pagePath);
    if (error) throw error;
    return [{ claim_text: `Claim from ${pagePath}`, kind: 'take', holder: 'brain', weight: 0.6 }];
  };
}

const poison = (slug: string) => POISON.has(slug) ? tooLong() : null;
const run = async (engine: BrainEngine, ex: ProposeTakesExtractor, extra: Record<string, unknown> = {}) => {
  const result = await expectUnitNotAborted(() => runPhaseProposeTakes(ctx(engine), { extractor: ex, deadlineMs: 600_000, ...extra }));
  return { result, details: result.details as Record<string, unknown> & { failed_pages?: Failed[] } };
};

async function proposals(engine: BrainEngine): Promise<Record<string, string[]>> {
  const rows = await engine.executeRaw<{ page_slug: string; claim_text: string }>(
    'SELECT page_slug, claim_text FROM take_proposals WHERE source_id = $1 ORDER BY page_slug, claim_text', [SOURCE]);
  const out: Record<string, string[]> = {};
  for (const row of rows) (out[row.page_slug] ??= []).push(row.claim_text);
  return out;
}

const failureTombstone = '(extraction failed: request_too_large)';
/** Every run rewrites its own extract receipt page; every other page must stay as it was. */
const receipts = (snapshot: Map<string, unknown>) => ({ changed: [...snapshot.keys()].filter(slug => slug.startsWith('extracts/')) });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-25 propose_takes: a page that keeps failing is tombstoned and never blocks the rest (${backend})`, () => {
    test('A-25 item: the 5 newest pages fail every run; the 6th page gets proposals and the 5 carry a failure tombstone after 4 runs', () => withBrain(databaseUrl, async engine => {
      const before = await snapshotItems(engine, SOURCE);
      const calls: string[][] = [];
      const runs = [];
      for (let i = 0; i < 4; i++) { const c: string[] = []; calls.push(c); runs.push(await run(engine, extractor(poison, c))); }
      const got = await proposals(engine);
      expect(got[HEALTHY]).toEqual([`Claim from ${HEALTHY}`]);
      for (const slug of POISON) expect({ slug, rows: got[slug] }).toEqual({ slug, rows: [failureTombstone] });
      expect(calls[1]![0]).toBe(HEALTHY);
      const last = runs[3]!.details.failed_pages!;
      expect(last.map(f => [f.slug, f.attempts, f.held])).toEqual([...POISON].map(slug => [slug, 3, true]));
      expectItemFailure(last[0], { key: 'page-01', code: 'request_too_large', fix: /gbrain takes propose --retry-failed --slug page-01 --source default/ });

      const fifth = await run(engine, extractor(poison));
      expect({ calls: fifth.details.llm_calls_succeeded as number + (fifth.details.llm_calls_failed as number), cache_hits: fifth.details.cache_hits })
        .toEqual({ calls: 0, cache_hits: 6 });
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), receipts(before));
    }), 120_000);

    test('A-25 item: a failure tombstone stays distinct from a successful empty extraction', () => withBrain(databaseUrl, async engine => {
      for (let i = 0; i < 4; i++) await run(engine, extractor(slug => slug === 'page-01' ? tooLong() : null));
      const rows = await engine.executeRaw<{ page_slug: string; claim_text: string; status: string }>(
        "SELECT page_slug, claim_text, status FROM take_proposals WHERE source_id = $1 AND page_slug = 'page-01'", [SOURCE]);
      expect(rows).toEqual([{ page_slug: 'page-01', claim_text: failureTombstone, status: 'rejected' }]);
    }), 120_000);

    test('A-25 recovery: retry-failed releases the tombstone, and a content change bypasses it', () => withBrain(databaseUrl, async engine => {
      for (let i = 0; i < 4; i++) await run(engine, extractor(poison));
      const released = await retryFailedProposals(engine, SOURCE, 'page-01');
      expect(released).toEqual({ released: ['page-01'] });
      await engine.putPage('page-02', { type: 'note' as never, title: 'page-02', compiled_truth: 'A shorter page-02 the model can read.', timeline: '', frontmatter: {} });
      const before = await snapshotItems(engine, SOURCE);
      const healed = await run(engine, extractor(() => null));
      expect(healed.details.failed_pages).toEqual([]);
      const got = await proposals(engine);
      expect({ p1: got['page-01'], p2: got['page-02']?.includes('Claim from page-02') }).toEqual({ p1: ['Claim from page-01'], p2: true });
      expect(got['page-03']).toEqual([failureTombstone]);
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), receipts(before));
    }), 120_000);

    test('A-25 recovery: the fix a held page names (takes propose --retry-failed) releases it, and --failed lists what is held', () => withBrain(databaseUrl, async engine => {
      let last: Failed[] = [];
      for (let i = 0; i < 4; i++) last = (await run(engine, extractor(poison))).details.failed_pages!;
      const cli = async (argv: string[]) => {
        const lines: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
        try { await runTakes(engine, argv); } finally { console.log = log; }
        return JSON.parse(lines.join('\n'));
      };
      const fix = last.find(f => f.slug === 'page-01')!.fix as { argv: string[]; verify: { argv: string[] } };
      expect(fix.argv.slice(0, 2)).toEqual(['gbrain', 'takes']);
      expect((await cli(fix.verify.argv.slice(2))).map((f: { slug: string; code: string }) => [f.slug, f.code]))
        .toEqual([...POISON].map(slug => [slug, 'request_too_large']));
      expect(await cli([...fix.argv.slice(2), '--json'])).toEqual({ source_id: SOURCE, released: ['page-01'] });
      expect((await cli(fix.verify.argv.slice(2))).map((f: { slug: string }) => f.slug)).toEqual([...POISON].filter(slug => slug !== 'page-01'));
      await run(engine, extractor(() => null));
      expect((await proposals(engine))['page-01']).toEqual(['Claim from page-01']);
    }), 120_000);

    test('A-25 recovery: a prompt-version change retries a tombstoned page', () => withBrain(databaseUrl, async engine => {
      for (let i = 0; i < 4; i++) await run(engine, extractor(poison), { promptVersion: 'v-example-1' });
      const calls: string[] = [];
      await run(engine, extractor(() => null, calls), { promptVersion: 'v-example-2' });
      expect(calls.sort()).toEqual([...PAGES].sort());
    }), 120_000);

    for (const { name, error } of runScopedErrors()) {
      test(`A-25 run: a run-scoped ${name} from the extractor stops the phase and records no failure`, () => withBrain(databaseUrl, async engine => {
        const before = await snapshotItems(engine, SOURCE);
        const calls: string[] = [];
        const { result } = await run(engine, extractor(() => error(), calls));
        expect(result.status).toBe('fail');
        expect(calls).toEqual(['page-01']);
        expect(await proposals(engine)).toEqual({});
        const ledger = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op = 'propose-takes-failures'");
        expect(ledger).toEqual([]);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), receipts(before));
      }), 120_000);
    }

    test('A-25 breaker: when every page fails, no run counts a failure and no page is ever tombstoned', () => withBrain(databaseUrl, async engine => {
      const runs = [];
      for (let i = 0; i < 4; i++) runs.push(await run(engine, extractor(() => tooLong())));
      expect(await proposals(engine)).toEqual({});
      expect(runs[0]!.details.systemic).toMatchObject({ code: 'item_failures_systemic' });
      for (const { details } of runs) {
        expect(details.failed_pages!.length).toBeGreaterThan(0);
        expect(details.failed_pages!.filter(f => f.attempts !== 0 || f.held)).toEqual([]);
      }
    }), 120_000);

    test('A-25 breaker: an extractor outage over 12 pages halts systemic on every run, including pages that failed before', () => withBrain(databaseUrl, async engine => {
      const runs = [];
      const calls: string[][] = [];
      for (let i = 0; i < 4; i++) {
        const c: string[] = []; calls.push(c);
        runs.push(await run(engine, extractor(() => new AITransientError('[chat(anthropic:claude-example)] 503 Service Unavailable'), c)));
      }
      expect(await proposals(engine)).toEqual({});
      expect(runs.map(({ result, details }, i) => ({ run: i + 1, calls: calls[i]!.length, status: result.status, halted: details.halted,
        streak: details.aborted_failure_streak, systemic: (details.systemic as { code?: string } | undefined)?.code, succeeded: details.llm_calls_succeeded })))
        .toEqual([1, 2, 3, 4].map(run => ({ run, calls: 5, status: 'fail', halted: true, streak: true, systemic: 'item_failures_systemic', succeeded: 0 })));
      for (const { details } of runs) expect(details.failed_pages!.filter(f => f.attempts !== 0 || f.held)).toEqual([]);
    }, OUTAGE_PAGES), 120_000);
  });
}
