/**
 * BrainEngine parity — the page batch of `chronicle-backfill` (src/core/chronicle/backfill.ts,
 * BrainEngine.readChronicleBackfillBatch), through the CLI's op handler (chronicle_backfill is local-only: MCP
 * does not serve it on any engine).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: chronicle_backfill --dry-run over seeded calendar, rescue-slug, note and old pages reports the same
 *    counts, skips and estimate on every engine and queues nothing; the source-list, one-source,
 *    unscoped and `since` scans agree; a `since` in the future scans nothing. A real queue (--yes) is
 *    test/engine-parity/chronicle-backfill-done.test.ts. Every engine arm answers the same (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the batch was raw SQL, so on a Rust brain chronicle_backfill refused before it scanned a page, even
 *    as a dry run.
 *  - Why existing coverage misses it: test/chronicle-*.test.ts run on PGLite and Postgres only.
 *  - Seam: none. Real engines and the chronicle_backfill op handler under the CLI's local caller.
 *    Carried from 6f801f6d17 (rust-engine/chronicle-reads-rebased c827c0c60c), the batch read only.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runChronicleBackfill } from '../../src/core/chronicle/backfill.ts';
import { operations } from '../../src/core/operations.ts';

const { parityTest } = parityArms(testBackends());

const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta release. '.repeat(3);
const today = new Date().toISOString().slice(0, 10);
/** The calendar event starts yesterday at 09:00 UTC: a start later today would wait as not_yet_happened. */
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'default', remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const cli = (engine: BrainEngine, params: Record<string, unknown>) =>
  operations.find(o => o.name === 'chronicle_backfill')!.handler(ctxFor(engine) as never, params) as Promise<Record<string, unknown>>;

/** Pages of every shape the scan sees: a calendar event, rescue slugs, a note, an old dated page. */
async function seedPages(engine: BrainEngine): Promise<void> {
  const page = (slug: string, type: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: BODY, timeline: '', frontmatter });
  await page('cal/standup-example', 'calendar-event', { start: `${yesterday}T09:00:00Z` });
  await page('meetings/rescued-note', 'note', { date: today });
  await page('meetings/old-note', 'note', { date: '2020-01-02' });
  await page('notes/plain-example', 'note');
}

/** A backfill result without its campaign id (a fresh uuid per run). */
const stable = (r: unknown): Record<string, unknown> => ({ ...(r as Record<string, unknown>), campaign_id: (r as Record<string, unknown>).campaign_id == null ? null : 'campaign' });

describe('engine parity: the chronicle-backfill page batch', () => {
  parityTest('chronicle_backfill --dry-run reports the same candidates and queues nothing',
    { methods: ['readChronicleBackfillBatch', 'putPage'], timeout: 120_000 }, async (engine) => {
      await seedPages(engine);
      const dry = stable(await cli(engine, { dry_run: true }));
      const again = stable(await cli(engine, { dry_run: true }));
      expect(dry).toMatchObject({ dry_run: true, scanned: 3, eligible: 3, queued: 3, already_done: 0, ask_user: true });
      expect(again).toEqual(dry);
      return { dry, again };
    });

  parityTest('the source-list, one-source, unscoped and since scans agree, and a future since scans nothing',
    { methods: ['readChronicleBackfillBatch', 'putPage'], timeout: 120_000 }, async (engine) => {
      await seedPages(engine);
      const out = {
        unscoped: stable(await runChronicleBackfill(engine, { dryRun: true })),
        listed: stable(await runChronicleBackfill(engine, { dryRun: true, sourceIds: ['default'] })),
        one: stable(await runChronicleBackfill(engine, { dryRun: true, sourceId: 'default' })),
        elsewhere: stable(await runChronicleBackfill(engine, { dryRun: true, sourceId: 'other' })),
        future: stable(await runChronicleBackfill(engine, { dryRun: true, since: '2999-01-01' })),
        recent: stable(await runChronicleBackfill(engine, { dryRun: true, since: today, recent: true })),
      };
      expect({ listed: out.listed, one: out.one }).toEqual({ listed: out.unscoped, one: out.unscoped });
      expect({ elsewhere: (out.elsewhere as { scanned: number }).scanned, future: (out.future as { scanned: number }).scanned }).toEqual({ elsewhere: 0, future: 0 });
      return out;
    });
});
