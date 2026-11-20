/**
 * BrainEngine parity — the maintenance sweep (`gbrain sweep --once`) on a freshly imported brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after `gbrain import` of a markdown brain, repeated sweeps until nothing is left extract the same links
 *    and timeline entries on every engine arm, reconcile the facts fence the same way (the same fact rows on the
 *    fenced page, the same held row left on the holding page), and skip no pass with an error reason. No call the
 *    sweep makes refuses for want of raw SQL, except the one named Rust known stop (RUST_KNOWN_STOP, lane 3's).
 *  - Regression: an engine that refuses one of the sweep's candidate reads makes the sweep skip the pass
 *    (`facts_fence_error`, `links_timeline_error`) and report success, so the brain never gains links or timeline
 *    entries and every graph read (backlinks, timeline, traverse) answers empty.
 *  - Why existing coverage misses it: the sweep tests run on PGLite and Postgres only, and the extraction parity cases
 *    call the extraction members directly, never the sweep's own candidate reads.
 *  - Seam: none. The synthetic fixture brain test/fixtures/rust-cli-parity-brain goes in through importFromContent
 *    (the `gbrain import` path). One more page holds a facts fence; it goes in through putPage, because importing a
 *    fence also reads the purge tombstones (facts/purge-overlay.ts), a different path from the sweep. The sweep is the
 *    real runMaintenanceSweep. A held row (a fact about grace-example kept on the memory/unattributed holding page)
 *    goes in through insertFacts; the brain is not managed, so the held-fact move plans it and leaves it where it is.
 */
import { describe, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runMaintenanceSweep } from '../../src/core/sweep.ts';
import { parityArms } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const FIXTURE = resolve(import.meta.dir, '..', 'fixtures', 'rust-cli-parity-brain');

const FENCED_BODY = [
  '# Grace Example', '', 'Grace advises [[companies/widget-co]].', '',
  '## Facts', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Grace advises Widget Co | fact | 1.0 | world | medium | 2025-01-01 |  | chat |  |',
  '<!--- gbrain:facts:end -->', '',
].join('\n');
const FENCED_TIMELINE = '- **2025-02-03** | joined [[companies/widget-co]] as an advisor';

/**
 * The one raw-SQL stop left in pass 1 on Rust (owner: lane 3, cut 1, src/core/page-state/projections.ts). The extract
 * receipt write (receipt-writer.ts:239) calls resealSafeChunks: installPageProjection (its first raw statement is the
 * planProjectionKeep read) plus the pending-count read. Both still run through executeRaw, so the receipt write
 * refuses and extract_facts logs it and goes on. Whichever of sweep-facts-rust and lane 3's cut 1 lands second
 * removes this pin; the case must then be equal on all three arms.
 */
const RUST_KNOWN_STOP = { member: 'resealSafeChunks', firstFrame: 'planProjectionKeep',
  message: "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran." };

/** `engine`, keeping every raw-SQL refusal a call on it (or on a transaction handle it opens) raised, caught or not. */
function keepingRefusals(engine: BrainEngine, refusals: unknown[]): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
          const fn = args[0] as (tx: BrainEngine) => unknown;
          args = [(tx: BrainEngine) => fn(keepingRefusals(tx, refusals)), ...args.slice(1)];
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.catch((error: unknown) => {
          if (isCapabilityRefusal(error, 'raw_sql')) refusals.push(error);
          throw error;
        });
      };
    },
  });
}

function fixturePages(): Array<{ slug: string; content: string }> {
  const pages: Array<{ slug: string; content: string }> = [];
  for (const dir of readdirSync(FIXTURE).sort()) {
    for (const file of readdirSync(join(FIXTURE, dir)).sort()) {
      if (!file.endsWith('.md')) continue;
      pages.push({ slug: `${dir}/${file.slice(0, -3)}`, content: readFileSync(join(FIXTURE, dir, file), 'utf8') });
    }
  }
  return pages;
}

async function importAll(engine: BrainEngine, pages: Array<{ slug: string; content: string }>): Promise<void> {
  for (const { slug, content } of pages) {
    await importFromContent(engine, slug, content, { noEmbed: true, filename: slug.split('/').pop() });
  }
}

describe('engine parity: maintenance sweep reads', () => {
  parityTest(
    'sweep --once after import extracts every link and timeline entry and reconciles the facts fence, with no error skip',
    { methods: ['putPage', 'insertFacts', 'getLinks', 'getTimeline', 'listFactsForPage', 'listHeldFactRows'], timeout: 120_000 },
    async (engine, backend) => {
      const pages = fixturePages();
      await importAll(engine, pages);
      await engine.putPage('people/grace-example', { type: 'person', title: 'Grace Example', compiled_truth: FENCED_BODY,
        timeline: FENCED_TIMELINE, frontmatter: {} });
      pages.push({ slug: 'people/grace-example', content: '' });
      await engine.putPage('memory/unattributed', { type: 'note', title: 'Unattributed', compiled_truth: 'Held memory.', timeline: '', frontmatter: {} });
      await engine.insertFacts([{ fact: 'Grace mentors founders', kind: 'fact', visibility: 'world', source: 'chat', embedding: null,
        entity_slug: 'people/grace-example', row_num: 1, source_markdown_slug: 'memory/unattributed' }] as never, { source_id: 'default' });

      const refusals: unknown[] = [];
      const swept = keepingRefusals(engine, refusals);
      const skipped = new Map<string, number>();
      let links = 0, timeline = 0, facts = 0, sweeps = 0;
      // Until nothing is left: a sweep reads at most batchLimit pages, so the 21 pages take several.
      for (; sweeps < 10; sweeps++) {
        const report = await runMaintenanceSweep(swept, { budgetMs: 60_000, batchLimit: 8 });
        for (const s of report.skipped) skipped.set(s.reason, (skipped.get(s.reason) ?? 0) + s.count);
        links += report.linksExtracted; timeline += report.timelineExtracted; facts += report.factsReconciled;
        if (report.linksExtracted === 0 && report.timelineExtracted === 0 && report.factsReconciled === 0) break;
      }

      const errorSkips = [...skipped.keys()].filter(reason => reason.endsWith('_error')).sort();
      expect(errorSkips).toEqual([]);
      if (backend === 'rust') {
        // The known stop: every refusal is the receipt write's resealSafeChunks call (see RUST_KNOWN_STOP).
        expect(refusals.length).toBeGreaterThan(0);
        expect([...new Set(refusals.map(e => (e as Error).message))]).toEqual([RUST_KNOWN_STOP.message]);
        expect(String((refusals[0] as Error).stack)).toContain(RUST_KNOWN_STOP.firstFrame);
      } else {
        expect(refusals.map(e => (e as Error).message)).toEqual([]);
      }
      expect(facts).toBeGreaterThan(0);

      const stored: Record<string, { links: string[]; timeline: string[] }> = {};
      for (const { slug } of pages) {
        const outbound = (await engine.getLinks(slug)).map(l => `${l.to_slug}|${l.link_type}`).sort();
        const entries = (await engine.getTimeline(slug)).map(t => `${String(t.date).slice(0, 10)}|${t.summary}`).sort();
        if (outbound.length > 0 || entries.length > 0) stored[slug] = { links: outbound, timeline: entries };
      }
      const linkTotal = Object.values(stored).reduce((n, s) => n + s.links.length, 0);
      const timelineTotal = Object.values(stored).reduce((n, s) => n + s.timeline.length, 0);
      expect(linkTotal).toBeGreaterThan(0);
      expect(timelineTotal).toBeGreaterThan(0);
      expect(stored['people/grace-example']?.links.some(l => l.startsWith('companies/widget-co|'))).toBe(true);
      const factRows = (await engine.listFactsForPage('default', 'people/grace-example'))
        .map(f => `${f.row_num}|${f.fact}|${f.kind}|${f.visibility}|${f.source}|${f.expired_at ? 'expired' : 'active'}`).sort();
      expect(factRows).toEqual(['1|Grace advises Widget Co|fact|world|chat|active']);
      const held = (await engine.listHeldFactRows('default', '30')).map(r => `${r.entity_slug}|${r.fact}`);
      expect(held).toEqual(['people/grace-example|Grace mentors founders']);
      // Every other result above holds on Rust too; the arm still counts as stopped until the pin is removed.
      if (backend === 'rust') throw refusals[0];
      return { links, timeline, facts, linkTotal, timelineTotal, stored, factRows, held };
    },
  );

  // The links and timeline pass alone: no page holds a facts fence, so pass 1 reads its scan and stops. Every arm must
  // extract the same links and timeline entries and skip nothing with an error reason (the bench reads these counts).
  parityTest(
    'sweep --once after import extracts every link and timeline entry through the links and timeline pass, with no error skip',
    { methods: ['listSweepStalePages', 'getLinks', 'getTimeline'], timeout: 120_000 },
    async (engine) => {
      const pages = fixturePages();
      await importAll(engine, pages);

      const skipped = new Map<string, number>();
      let links = 0, timeline = 0, sweeps = 0;
      for (; sweeps < 10; sweeps++) {
        const report = await runMaintenanceSweep(engine, { budgetMs: 60_000, batchLimit: 8 });
        for (const s of report.skipped) skipped.set(s.reason, (skipped.get(s.reason) ?? 0) + s.count);
        links += report.linksExtracted; timeline += report.timelineExtracted;
        if (report.linksExtracted === 0 && report.timelineExtracted === 0) break;
      }
      expect([...skipped.keys()].filter(reason => reason.endsWith('_error')).sort()).toEqual([]);

      const stored: Record<string, { links: string[]; timeline: string[] }> = {};
      for (const { slug } of pages) {
        const outbound = (await engine.getLinks(slug)).map(l => `${l.to_slug}|${l.link_type}`).sort();
        const entries = (await engine.getTimeline(slug)).map(t => `${String(t.date).slice(0, 10)}|${t.summary}`).sort();
        if (outbound.length > 0 || entries.length > 0) stored[slug] = { links: outbound, timeline: entries };
      }
      const linkTotal = Object.values(stored).reduce((n, s) => n + s.links.length, 0);
      const timelineTotal = Object.values(stored).reduce((n, s) => n + s.timeline.length, 0);
      expect(linkTotal).toBeGreaterThan(0);
      expect(timelineTotal).toBeGreaterThan(0);
      return { links, timeline, linkTotal, timelineTotal, sweeps, stored };
    },
  );
});
