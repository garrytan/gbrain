/**
 * BrainEngine parity: a whole meetings connector sync (src/core/meetings/meetings-source.ts `runMeetingsSync`) on a
 * repo-less brain, over a synthetic Fireflies transport (no network).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the first run publishes the one listed meeting as a page and reports it synced; a second run finds
 *    nothing new and reports up to date. Same receipts and the same page on every arm, and the Rust arm raises no typed
 *    refusal on the way (the harness fails a case that caught one), so no step falls back silently.
 *  - Regression: the connector path read and wrote raw SQL in several places (the attempt stamp, the cursor row, the
 *    hold retry keys, the source row, the meeting page lookup), so a Rust brain refused the sync before it fetched a
 *    meeting, or skipped a step behind a caught refusal.
 *  - Why existing coverage misses it: test/meetings-source*.test.ts run the connector on PGLite only.
 *  - Seam: the provider's fetch (a synthetic transport); the engines and the connector code are real.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runMeetingsSync } from '../../src/core/meetings/meetings-source.ts';
import { parseMeetingsSourceConfig } from '../../src/core/meetings/source-config.ts';
import { firefliesProvider } from '../../src/core/meetings/providers/fireflies.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { createSource, parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const NOW = Date.parse('2026-06-15T12:00:00Z');
const MEETING = { id: 'm-1', title: 'Planning', date: NOW - 86_400_000 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function fireflies(_url: string, init: RequestInit): Promise<Response> {
  const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
  if (query.includes('GbrainUser')) return json({ data: { user: { user_id: 'u-1', email: 'owner@example.invalid', name: 'Owner Example' } } });
  if (query.includes('GbrainTranscripts')) return json({ data: { transcripts: Number(variables.skip ?? 0) ? [] : [MEETING] } });
  const attendees = ['owner@example.invalid', 'alice@example.invalid'];
  return json({ data: { transcript: {
    ...MEETING, duration: 30, transcript_url: 'https://app.fireflies.example/view/m-1', organizer_email: attendees[0], participants: attendees,
    meeting_attendees: attendees.map(email => ({ email, displayName: email.split('@')[0] })),
    summary: { overview: 'Summary of Planning.', action_items: '- Send the follow-up', keywords: ['planning'] },
  } } });
}

const run = (engine: BrainEngine, cfg: ReturnType<typeof parseMeetingsSourceConfig>) => runMeetingsSync(engine, 'meet-example', cfg, { noEmbed: true } as never, {
  provider: firefliesProvider({ token: 'synthetic-fixture-key', userAgent: 'gbrain-test', now: () => NOW, fetchImpl: fireflies as never, sleep: async () => {} }),
  now: () => NOW,
});

describe('engine parity: meetings sync', () => {
  parityTest('a repo-less meetings sync publishes the meeting once, then reports up to date',
    { methods: ['recordConnectorSyncAttempt', 'writeConnectorDbCursor', 'readOpCheckpointRecord', 'readSourceState', 'readMeetingPage'], timeout: 120_000 },
    async (engine, backend) => {
      const config = { kind: 'meetings', m_provider: 'fireflies', m_record: 'database', federated: false };
      await createSource(engine, backend, 'meet-example', config);
      const cfg = parseMeetingsSourceConfig(config, '');
      const receipt = (r: Awaited<ReturnType<typeof runMeetingsSync>>) =>
        ({ status: r.status, added: r.added, modified: r.modified, deleted: r.deleted, pages: r.pagesAffected });
      const first = receipt(await run(engine, cfg));
      const second = receipt(await run(engine, cfg));
      const page = first.pages[0] ? await engine.getPage(first.pages[0], { sourceId: 'meet-example' }) : null;
      const result = { first, second, title: page?.title ?? null, meetingId: (page?.frontmatter as { meeting_id?: string } | undefined)?.meeting_id ?? null };
      expect({ ...result, first: { ...first, pages: first.pages.map(slug => slug.startsWith('meetings/2026-06-14-planning')) } }).toEqual({
        first: { status: 'synced', added: 1, modified: 0, deleted: 0, pages: [true] },
        second: { status: 'up_to_date', added: 0, modified: 0, deleted: 0, pages: [] },
        title: 'Planning', meetingId: 'm-1',
      });
      return result;
    });
});
