import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let execCalls: Array<{ cmd: string; args: string[] }> = [];
let execHandler: (cmd: string, args: string[], opts: unknown, cb: (err: unknown, stdout?: string, stderr?: string) => void) => void;

mock.module('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: (err: unknown, stdout?: string, stderr?: string) => void) => {
    execCalls.push({ cmd, args });
    execHandler(cmd, args, opts, cb);
  },
  spawn: () => ({ on: () => {} }),
}));

const mod = await import('../src/core/meeting-sync.ts');
const {
  dateWindowFromArgs,
  externalSourceId,
  extractGranolaMeetingIds,
  fetchFirefliesMeetings,
  fetchGranolaMeetings,
  filterAttendees,
  inferMeetingTags,
  listPendingMeetings,
  meetingExists,
  meetingMarkdownRelativePath,
  normalizeProviderList,
  renderMeetingMarkdown,
  syncMeetings,
} = mod;
const { propagatePendingMeetings, verifyCompleteMeetings } = await import('../src/core/meeting-propagation.ts');
const { buildMeetingSyncJobParams } = await import('../src/commands/meeting-sync.ts');
const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
type NormalizedMeeting = import('../src/core/meeting-sync.ts').NormalizedMeeting;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

const meeting: NormalizedMeeting = {
  provider: 'granola',
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Weekly Team Sync',
  date: '2026-06-29',
  durationMinutes: 30,
  location: 'Google Meet',
  url: 'https://notes.example/meeting',
  attendees: [
    { name: 'Alice Example', email: 'alice@example.com' },
    { name: 'YC-SF Conference Room', email: 'room@resource.calendar.google.com' },
    { email: 'team@example.com' },
    { email: 'bob@example.com' },
  ],
  summaryMarkdown: 'Discussed roadmap.',
  keyDecisions: [],
  actionItems: ['Alice: send notes'],
  discussionNotes: ['Roadmap update'],
  transcript: [
    { speaker: 'Alice Example', text: 'Roadmap update.', startSeconds: 0 },
    { speaker: 'Bob Example', text: 'Prototype is ready.', startSeconds: 75 },
  ],
};

beforeEach(() => {
  execCalls = [];
  execHandler = (_cmd, _args, _opts, cb) => cb(null, JSON.stringify({ data: [] }), '');
});

async function truncateEngine(): Promise<void> {
  for (const table of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${table}`);
  }
}

async function setupPropagatedMeeting(opts: { readyForReview?: boolean; includeCandidateSkip?: boolean } = {}): Promise<{ repo: string; meetingPath: string; slug: string; transcriptBlock: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-meeting-propagation-'));
  mkdirSync(join(repo, 'meetings'), { recursive: true });
  mkdirSync(join(repo, 'companies'), { recursive: true });
  writeFileSync(join(repo, 'companies', 'acme.md'), [
    '---',
    'type: company',
    'title: Acme',
    '---',
    '',
    'Existing company page.',
    '',
  ].join('\n'));
  await engine.putPage('companies/acme', {
    type: 'company',
    title: 'Acme',
    compiled_truth: 'Existing company page.',
    timeline: '',
    frontmatter: {},
  });

  const meetingPath = join(repo, 'meetings', '2026-06-29-board-sync.md');
  const content = [
    '---',
    'type: meeting',
    'title: Board Sync',
    'date: "2026-06-29"',
    'source_id: "granola:11111111-1111-4111-8111-111111111111"',
    'ingestion_status: pending_propagation',
    'attendees:',
    '  - name: Alice Example',
    '    email: alice@example.com',
    '---',
    '',
    '# Board Sync',
    '',
    '## Summary',
    'Discussed Acme rollout.',
    '',
    '## Key Decisions',
    'None',
    '',
    '## Action Items',
    '- [ ] Alice Example: send Acme rollout notes',
    '',
    '## Discussion Notes / Key Points',
    opts.includeCandidateSkip ? '- Acme rollout and Carol Review were discussed.' : '- Acme rollout is ready.',
    '',
    '## Attendees',
    '- Alice Example',
    '',
    '---',
    '',
    '## Transcript',
    '',
    opts.includeCandidateSkip
      ? '**Alice Example** (00:00): Acme rollout is ready and Carol Review should inspect it.'
      : '**Alice Example** (00:00): Acme rollout is ready.',
    '',
  ].join('\n');
  writeFileSync(meetingPath, content);
  const before = readFileSync(meetingPath, 'utf8');
  const transcriptBlock = before.slice(before.indexOf('\n---\n\n## Transcript'));
  await propagatePendingMeetings(engine, { repoPath: repo, sourceId: 'default' });
  if (opts.readyForReview) {
    markPropagationReviewed(meetingPath);
    const updated = readFileSync(meetingPath, 'utf8');
    await engine.putPage('meetings/2026-06-29-board-sync', {
      type: 'meeting',
      title: 'Board Sync',
      compiled_truth: updated,
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
  }
  await engine.upsertChunks('meetings/2026-06-29-board-sync', [
    { chunk_index: 0, chunk_text: 'Board Sync meeting discussed Acme rollout with Alice Example.', chunk_source: 'compiled_truth' },
  ], { sourceId: 'default' });
  return { repo, meetingPath, slug: 'meetings/2026-06-29-board-sync', transcriptBlock };
}

function markPropagationReviewed(path: string): void {
  const content = readFileSync(path, 'utf8');
  writeFileSync(path, content.replace(/### Skip Reasons\n[\s\S]*?(?=\n---\n\n## Transcript)/, '### Skip Reasons\nNone\n'));
}

function setComposioResponses(responses: Record<string, Array<unknown | Error>>): void {
  const queues = new Map(Object.entries(responses).map(([k, v]) => [k, [...v]]));
  execHandler = (_cmd, args, _opts, cb) => {
    const slug = args[1];
    const queue = queues.get(slug);
    if (!queue || queue.length === 0) {
      cb(new Error(`unexpected composio call ${slug}`), '', '');
      return;
    }
    const next = queue.shift();
    if (next instanceof Error) cb(next, '', next.message);
    else cb(null, JSON.stringify(next), '');
  };
}

async function captureMeetingSyncHandler(): Promise<(job: { data: Record<string, unknown>; signal?: AbortSignal }) => Promise<any>> {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
  await registerBuiltinHandlers(fakeWorker as never, engine, { quiet: true });
  const handler = handlers.get('meeting-sync');
  if (!handler) throw new Error('meeting-sync handler was not registered');
  return handler;
}

describe('meeting sync pure helpers', () => {
  test('provider list defaults and validates', () => {
    expect(normalizeProviderList(undefined)).toEqual(['fireflies', 'granola']);
    expect(normalizeProviderList('all')).toEqual(['fireflies', 'granola']);
    expect(normalizeProviderList('granola,fireflies,granola')).toEqual(['granola', 'fireflies']);
    expect(() => normalizeProviderList('circleback')).toThrow(/Unknown meeting provider/);
  });

  test('date window supports default cron window and full backfill with optional explicit start', () => {
    const now = new Date('2026-06-29T12:00:00Z');
    expect(dateWindowFromArgs({ now })).toEqual({ start: '2026-06-28', end: '2026-06-29' });
    expect(dateWindowFromArgs({ days: 7, now })).toEqual({ start: '2026-06-23', end: '2026-06-29' });
    expect(dateWindowFromArgs({ all: true, now })).toEqual({ start: undefined, end: undefined });
    expect(dateWindowFromArgs({ all: true, start: '2026-01-01', end: '2026-06-29', now })).toEqual({ start: '2026-01-01', end: '2026-06-29' });
  });

  test('background job params carry resolved windows for Minion idempotency', () => {
    const now = new Date('2026-07-01T12:00:00Z');
    expect(buildMeetingSyncJobParams(['--provider', 'granola', '--days', '2'], now)).toMatchObject({
      mode: 'collect',
      providers: ['granola'],
      window: { start: '2026-06-30', end: '2026-07-01' },
    });
    expect(buildMeetingSyncJobParams(['--provider', 'fireflies', '--all'], now)).toMatchObject({
      mode: 'collect',
      providers: ['fireflies'],
      window: {},
    });
    expect(buildMeetingSyncJobParams(['--propagate-pending', '--meeting', 'granola:abc', '--source', 'default'], now)).toMatchObject({
      mode: 'propagate-pending',
      meetings: ['granola:abc'],
      sourceId: 'default',
    });
  });

  test('filters rooms, resource calendars, group emails, and derives display names', () => {
    expect(filterAttendees([
      { name: 'Alice Example', email: 'alice@example.com' },
      { name: 'Alice Example', email: 'alice@example.com' },
      { name: 'Conference Room', email: 'room@resource.calendar.google.com' },
      { email: 'team@example.com' },
      { email: 'bob@example.com' },
    ])).toEqual([
      { name: 'Alice Example', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]);
  });

  test('renders strict markdown frontmatter, mandatory sections, and no raw email attendee names', () => {
    const md = renderMeetingMarkdown(meeting);
    expect(md).toContain('type: meeting');
    expect(md).toContain('source_id: "granola:11111111-1111-4111-8111-111111111111"');
    expect(md).toContain('ingestion_status: pending_propagation');
    expect(md).toContain('duration: "30 min"');
    expect(md).toContain('location: "Google Meet"');
    expect(md).toContain('tags: ["sync"]');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Key Decisions\nNone');
    expect(md).toContain('## Action Items');
    expect(md).toContain('## Discussion Notes / Key Points');
    expect(md).toContain('- Bob');
    expect(md).not.toContain('- bob@example.com');
    expect(md).not.toContain('YC-SF Conference Room');
    expect(md).toContain('---\n\n## Transcript\n\n**Alice Example** (00:00): Roadmap update.');
    expect(md).toContain('**Bob Example** (01:15): Prototype is ready.');
    expect(meetingMarkdownRelativePath(meeting)).toBe('meetings/2026-06-29-weekly-team-sync.md');
    expect(externalSourceId(meeting)).toBe('granola:11111111-1111-4111-8111-111111111111');
  });

  test('renders None for an empty attendee section', () => {
    const md = renderMeetingMarkdown({
      ...meeting,
      attendees: [{ name: 'Conference Room', email: 'room@resource.calendar.google.com' }],
    });

    expect(md).toContain('## Attendees\nNone');
  });

  test('meeting path keeps date when title contains slash characters', () => {
    expect(meetingMarkdownRelativePath({
      ...meeting,
      title: 'Clinical Trials: / Alice Example / Bob Example - Clinical Trial Efficiency',
    })).toBe('meetings/2026-06-29-clinical-trials-alice-example-bob-example-clinical-trial-efficiency.md');
    expect(meetingMarkdownRelativePath({
      ...meeting,
      title: 'Carol Example / Dana Example',
    })).toBe('meetings/2026-06-29-carol-example-dana-example.md');
  });

  test('idempotency checks source_id even if filename changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-meeting-sync-'));
    const existing = join(dir, 'renamed.md');
    writeFileSync(existing, '---\nsource_id: "granola:11111111-1111-4111-8111-111111111111"\n---\n');
    expect(meetingExists(dir, 'granola:11111111-1111-4111-8111-111111111111', join(dir, 'new.md'))).toBe(true);
  });

  test('pending listing finds incomplete meetings only', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-meeting-sync-pending-'));
    const meetingsDir = join(repo, 'meetings');
    mkdirSync(meetingsDir, { recursive: true });
    writeFileSync(join(meetingsDir, 'pending.md'), [
      '---',
      'title: "Pending"',
      'source_id: "fireflies:ff_1"',
      'ingestion_status: pending_propagation',
      '---',
      '',
    ].join('\n'));
    writeFileSync(join(meetingsDir, 'complete.md'), [
      '---',
      'title: "Complete"',
      'source_id: "fireflies:ff_2"',
      'ingestion_status: complete',
      '---',
      '',
    ].join('\n'));
    const pending = listPendingMeetings(repo);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ sourceId: 'fireflies:ff_1', title: 'Pending', ingestionStatus: 'pending_propagation' });
  });

  test('tag inference matches recipe defaults', () => {
    expect(inferMeetingTags('1:1 with Alice')).toEqual(['1on1']);
    expect(inferMeetingTags('Board policy sync')).toEqual(['sync', 'board', 'civic']);
    expect(inferMeetingTags('Random conversation')).toEqual(['meeting']);
  });
});

describe('Composio provider fetchers', () => {
  test('normalizes Fireflies compact listing plus detail sentences', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'gbrain-meeting-sync-composio-file-'));
    const outputFile = join(outputDir, 'fireflies-detail.json');
    writeFileSync(outputFile, JSON.stringify({
      successful: true,
      data: {
        id: 'ff_1',
        title: 'Board Sync',
        dateString: '2026-06-29T15:00:00.000Z',
        duration: 1800,
        transcript_url: 'https://app.fireflies.ai/view/ff_1',
        meeting_attendees: [{ displayName: 'Alice Example', email: 'alice@example.com' }],
        summary: { overview: 'Overview', action_items: ['Follow up'], key_decisions: ['Ship it'] },
        sentences: [{ speaker_name: 'Alice Example', text: 'Hello', start_time: 5 }],
      },
    }));
    setComposioResponses({
      FIREFLIES_GET_TRANSCRIPTS: [{ data: [{ id: 'ff_1' }] }],
      FIREFLIES_GET_TRANSCRIPT_BY_ID: [{
        successful: true,
        storedInFile: true,
        outputFilePath: outputFile,
      }],
    });

    const rows = await fetchFirefliesMeetings({ start: '2026-06-01', end: '2026-06-29' });
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('fireflies');
    expect(rows[0].date).toBe('2026-06-29');
    expect(rows[0].durationMinutes).toBe(30);
    expect(rows[0].keyDecisions).toEqual(['Ship it']);
    expect(rows[0].transcript[0]).toMatchObject({ speaker: 'Alice Example', text: 'Hello', startSeconds: 5 });
    expect(execCalls[0].args[1]).toBe('FIREFLIES_GET_TRANSCRIPTS');
    expect(execCalls[0].args[3]).toContain('"include_sentences":false');
    expect(execCalls[1].args[1]).toBe('FIREFLIES_GET_TRANSCRIPT_BY_ID');
  });

  test('normalizes Granola listing, batched details, and raw transcript', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    setComposioResponses({
      GRANOLA_MCP_LIST_MEETINGS: [{ data: [{ text: `Meeting id=${id}` }] }],
      GRANOLA_MCP_GET_MEETINGS: [{
        meetings: [{
          id,
          title: 'Weekly Team Sync',
          created_at: '2026-06-29T15:00:00Z',
          web_url: 'https://notes.granola.ai/d/example',
          calendar_event: {
            scheduled_start_time: '2026-06-29T15:00:00Z',
            scheduled_end_time: '2026-06-29T15:30:00Z',
            location: 'Google Meet',
          },
          attendees: [{ name: 'Alice Example', email: 'alice@example.com' }],
          summary_markdown: 'Summary',
        }],
      }],
      GRANOLA_MCP_GET_MEETING_TRANSCRIPT: [{
        data: { data: [{ text: JSON.stringify({ transcript: [{ speaker: { source: 'microphone' }, text: 'Hello', start_time: '2026-06-29T15:01:00Z' }] }) }] },
      }],
    });

    const rows = await fetchGranolaMeetings({ start: '2026-06-01', end: '2026-06-29' });
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('granola');
    expect(rows[0].durationMinutes).toBe(30);
    expect(rows[0].location).toBe('Google Meet');
    expect(rows[0].transcript[0]).toMatchObject({ speaker: 'microphone', text: 'Hello', startSeconds: 60 });
    expect(execCalls.map(c => c.args[1])).toEqual([
      'GRANOLA_MCP_LIST_MEETINGS',
      'GRANOLA_MCP_GET_MEETINGS',
      'GRANOLA_MCP_GET_MEETING_TRANSCRIPT',
    ]);
  });

  test('normalizes Granola XML-like details and inline diarized transcript', async () => {
    const id = 'bdbba035-9d04-4220-9836-8dc14f56cb34';
    setComposioResponses({
      GRANOLA_MCP_LIST_MEETINGS: [{
        data: { data: [{ text: `<meetings_data><meeting id="${id}" title=" SVE Workshop" date="Jun 22, 2026 1:30 PM EDT"></meeting></meetings_data>` }] },
      }],
      GRANOLA_MCP_GET_MEETINGS: [{
        data: {
          data: [{
            text: `<meetings_data><meeting id="${id}" title=" SVE Workshop" date="Jun 22, 2026 1:30 PM EDT">
  <known_participants>
  Elman (note creator) from Stanford <elman@example.com>
  </known_participants>
  <summary>
Workshop summary
</summary>
</meeting></meetings_data>`,
          }],
        },
      }],
      GRANOLA_MCP_GET_MEETING_TRANSCRIPT: [{
        data: { data: [{ text: JSON.stringify({ id, title: 'SVE Workshop', transcript: 'Them: Hello there. Me: Good question. Them: Thanks.' }) }] },
      }],
    });

    const rows = await fetchGranolaMeetings({ start: '2026-06-22', end: '2026-06-22' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('SVE Workshop');
    expect(rows[0].date).toBe('2026-06-22');
    expect(rows[0].summaryMarkdown).toBe('Workshop summary');
    expect(rows[0].attendees).toEqual([{ name: 'Elman', email: 'elman@example.com' }]);
    expect(rows[0].transcript).toHaveLength(3);
    expect(rows[0].transcript[1]).toMatchObject({ speaker: 'Me', text: 'Good question.' });
  });

  test('Granola listing honors one-sided start windows with custom ranges', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    setComposioResponses({
      GRANOLA_MCP_LIST_MEETINGS: [{ data: [{ text: `Meeting id=${id}` }] }],
      GRANOLA_MCP_GET_MEETINGS: [{
        meetings: [{
          id,
          title: 'Recent Sync',
          created_at: '2026-06-29T15:00:00Z',
        }],
      }],
      GRANOLA_MCP_GET_MEETING_TRANSCRIPT: [{
        data: { data: [{ text: JSON.stringify({ transcript: [{ speaker: 'Alice', text: 'Hello' }] }) }] },
      }],
    });

    await fetchGranolaMeetings({ start: '2026-06-29' });

    const listPayload = JSON.parse(execCalls[0].args[3]);
    expect(execCalls[0].args[1]).toBe('GRANOLA_MCP_LIST_MEETINGS');
    expect(listPayload.time_range).toBe('custom');
    expect(listPayload.custom_start).toBe('2026-06-29');
    expect(listPayload.custom_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('Granola id parser keeps complete UUIDs only', () => {
    expect(extractGranolaMeetingIds('ok 11111111-1111-4111-8111-111111111111 cut 22222222-2222-4222-8222')).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  test('reports missing Composio CLI', async () => {
    execHandler = (_cmd, _args, _opts, cb) => {
      const err = new Error('spawn composio ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      cb(err, '', '');
    };

    await expect(fetchFirefliesMeetings({ start: '2026-06-29', end: '2026-06-29' })).rejects.toThrow(/composio CLI not found/);
  });

  test('reports non-zero Composio exits', async () => {
    execHandler = (_cmd, _args, _opts, cb) => {
      cb(new Error('exit 1'), '{"data":[]}', 'toolkit not connected');
    };

    await expect(fetchFirefliesMeetings({ start: '2026-06-29', end: '2026-06-29' })).rejects.toThrow(/toolkit not connected/);
  });

  test('continues Fireflies fetch when one detail call fails', async () => {
    setComposioResponses({
      FIREFLIES_GET_TRANSCRIPTS: [{ data: [{ id: 'ff_bad', title: 'Bad Detail' }, { id: 'ff_good', title: 'Good Detail' }] }],
      FIREFLIES_GET_TRANSCRIPT_BY_ID: [
        new Error('detail timeout'),
        {
          data: {
            transcript: {
              id: 'ff_good',
              title: 'Good Detail',
              dateString: '2026-06-29T15:00:00Z',
              sentences: [{ speaker_name: 'Alice Example', text: 'Hello', start_time: 0 }],
            },
          },
        },
      ],
    });

    const errors: Array<{ sourceId?: string; title?: string; error: string }> = [];
    const rows = await fetchFirefliesMeetings({ start: '2026-06-29', end: '2026-06-29' }, errors);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('ff_good');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ sourceId: 'fireflies:ff_bad', title: 'Bad Detail' });
  });

  test('reports non-JSON Composio stdout', async () => {
    execHandler = (_cmd, _args, _opts, cb) => {
      cb(null, 'not json', '');
    };

    await expect(fetchFirefliesMeetings({ start: '2026-06-29', end: '2026-06-29' })).rejects.toThrow(/non-JSON output/);
  });
});

describe('syncMeetings', () => {
  test('writes Phase 1 meeting markdown and skips missing transcript pages', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-meeting-sync-repo-'));
    setComposioResponses({
      FIREFLIES_GET_TRANSCRIPTS: [{ data: [{ id: 'ff_1' }, { id: 'ff_2' }] }],
      FIREFLIES_GET_TRANSCRIPT_BY_ID: [
        {
          data: {
            transcript: {
              id: 'ff_1',
              title: 'Board Sync',
              dateString: '2026-06-29T15:00:00Z',
              sentences: [{ speaker_name: 'Alice Example', text: 'Hello', start_time: 0 }],
            },
          },
        },
        {
          data: {
            transcript: {
              id: 'ff_2',
              title: 'Summary Only',
              dateString: '2026-06-29T16:00:00Z',
              summary: { overview: 'Not enough' },
              sentences: [],
            },
          },
        },
      ],
    });

    const results = await syncMeetings({
      providers: ['fireflies'],
      repoPath: repo,
      window: { start: '2026-06-29', end: '2026-06-29' },
    });

    const fireflies = results[0];
    expect(fireflies.created).toBe(1);
    expect(fireflies.failed).toBe(1);
    expect(fireflies.errors[0].error).toContain('missing diarized/raw transcript');
    const path = join(repo, 'meetings', '2026-06-29-board-sync.md');
    const md = readFileSync(path, 'utf8');
    expect(md).toContain('source_id: "fireflies:ff_1"');
    expect(md).toContain('ingestion_status: pending_propagation');
    expect(md).toContain('## Transcript\n\n**Alice Example** (00:00): Hello');

    const transcriptBlock = md.slice(md.indexOf('---\n\n## Transcript'));
    setComposioResponses({
      FIREFLIES_GET_TRANSCRIPTS: [{ data: [{ id: 'ff_1' }, { id: 'ff_2' }] }],
      FIREFLIES_GET_TRANSCRIPT_BY_ID: [
        {
          data: {
            transcript: {
              id: 'ff_1',
              title: 'Board Sync',
              dateString: '2026-06-29T15:00:00Z',
              sentences: [{ speaker_name: 'Alice Example', text: 'Changed text should not rewrite', start_time: 0 }],
            },
          },
        },
        {
          data: {
            transcript: {
              id: 'ff_2',
              title: 'Summary Only',
              dateString: '2026-06-29T16:00:00Z',
              summary: { overview: 'Not enough' },
              sentences: [],
            },
          },
        },
      ],
    });
    const second = await syncMeetings({
      providers: ['fireflies'],
      repoPath: repo,
      window: { start: '2026-06-29', end: '2026-06-29' },
    });
    expect(second[0].skipped).toBe(1);
    expect(readFileSync(path, 'utf8').slice(md.indexOf('---\n\n## Transcript'))).toBe(transcriptBlock);
  });
});

describe('meeting sync Minion orchestration', () => {
  test('registered meeting-sync handler runs Phase 1 collection through the orchestrator', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-meeting-sync-minion-'));
    setComposioResponses({
      FIREFLIES_GET_TRANSCRIPTS: [{ data: [{ id: 'ff_minion' }] }],
      FIREFLIES_GET_TRANSCRIPT_BY_ID: [{
        data: {
          transcript: {
            id: 'ff_minion',
            title: 'Minion Board Sync',
            dateString: '2026-06-29T15:00:00Z',
            sentences: [{ speaker_name: 'Alice Example', text: 'Hello from orchestrator.', start_time: 0 }],
          },
        },
      }],
    });

    const handler = await captureMeetingSyncHandler();
    const result = await handler({
      data: {
        mode: 'collect',
        providers: ['fireflies'],
        repoPath: repo,
        window: { start: '2026-06-29', end: '2026-06-29' },
      },
    });

    expect(result.status).toBe('ok');
    expect(result.results[0]).toMatchObject({ provider: 'fireflies', fetched: 1, created: 1, failed: 0 });
    const file = join(repo, 'meetings', '2026-06-29-minion-board-sync.md');
    const md = readFileSync(file, 'utf8');
    expect(md).toContain('source_id: "fireflies:ff_minion"');
    expect(md).toContain('ingestion_status: pending_propagation');
    expect(md).toContain('## Transcript\n\n**Alice Example** (00:00): Hello from orchestrator.');
  });

  test('registered meeting-sync handler fails the job when all providers fail', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-meeting-sync-minion-fail-'));
    execHandler = (_cmd, _args, _opts, cb) => cb(new Error('exit 1'), '', 'toolkit not connected');

    const handler = await captureMeetingSyncHandler();
    await expect(handler({
      data: {
        mode: 'collect',
        providers: ['fireflies'],
        repoPath: repo,
        window: { start: '2026-06-29', end: '2026-06-29' },
      },
    })).rejects.toThrow(/meeting-sync: all providers failed/);
  });
});

describe('meeting Phase 2 propagation', () => {
  beforeEach(async () => {
    await truncateEngine();
  });

  test('propagates one pending meeting and preserves the transcript block', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-meeting-propagation-'));
    mkdirSync(join(repo, 'meetings'), { recursive: true });
    mkdirSync(join(repo, 'companies'), { recursive: true });
    writeFileSync(join(repo, 'companies', 'acme.md'), [
      '---',
      'type: company',
      'title: Acme',
      '---',
      '',
      'Existing company page.',
      '',
    ].join('\n'));
    await engine.putPage('companies/acme', {
      type: 'company',
      title: 'Acme',
      compiled_truth: 'Existing company page.',
      timeline: '',
      frontmatter: {},
    });

    const meetingPath = join(repo, 'meetings', '2026-06-29-board-sync.md');
    const content = [
      '---',
      'type: meeting',
      'title: Board Sync',
      'date: "2026-06-29"',
      'source_id: "granola:11111111-1111-4111-8111-111111111111"',
      'ingestion_status: pending_propagation',
      'attendees:',
      '  - name: Alice Example',
      '    email: alice@example.com',
      '---',
      '',
      '# Board Sync',
      '',
      '## Summary',
      'Discussed Acme rollout.',
      '',
      '## Key Decisions',
      'None',
      '',
      '## Action Items',
      '- [ ] Alice Example: send Acme rollout notes',
      '',
      '## Discussion Notes / Key Points',
      '- Acme rollout is ready.',
      '',
      '## Attendees',
      '- Alice Example',
      '',
      '---',
      '',
      '## Transcript',
      '',
      '**Alice Example** (00:00): Acme rollout is ready.',
      '',
    ].join('\n');
    writeFileSync(meetingPath, content);
    const before = readFileSync(meetingPath, 'utf8');
    const transcriptBlock = before.slice(before.indexOf('\n---\n\n## Transcript'));

    const result = await propagatePendingMeetings(engine, { repoPath: repo, sourceId: 'default' });

    expect(result.completed).toBe(0);
    expect(result.pending).toBe(1);
    expect(result.failed).toBe(0);
    const meetingResult = result.meetings[0];
    expect(meetingResult.status).toBe('pending');
    expect(meetingResult.attendees).toEqual([{ name: 'Alice Example', slug: 'people/alice-example', created: true }]);
    expect(meetingResult.entities).toEqual([{ title: 'Acme', slug: 'companies/acme', type: 'company' }]);
    expect(meetingResult.actionItems).toHaveLength(1);
    expect(meetingResult.verificationErrors).toEqual([]);

    const updated = readFileSync(meetingPath, 'utf8');
    expect(updated).toContain('ingestion_status: pending_propagation');
    expect(updated).toContain('propagation_status: deterministic_propagated_pending_agent_review');
    expect(updated.slice(updated.indexOf('\n---\n\n## Transcript'))).toBe(transcriptBlock);
    expect(updated).toContain('[Alice Example](people/alice-example)');
    expect(updated).toContain('[Acme](companies/acme)');

    const meetingLinks = await engine.getLinks('meetings/2026-06-29-board-sync', { sourceId: 'default' });
    expect(new Set(meetingLinks.map(l => l.to_slug))).toEqual(new Set([
      'people/alice-example',
      'companies/acme',
      'tasks/2026-06-29-board-sync-action-items',
    ]));
    const personLinks = await engine.getLinks('people/alice-example', { sourceId: 'default' });
    expect(personLinks.some(l => l.to_slug === 'meetings/2026-06-29-board-sync')).toBe(true);
    const personTimeline = await engine.getTimeline('people/alice-example', { sourceId: 'default' });
    expect(personTimeline.some(t => t.source === 'meeting-sync:meetings/2026-06-29-board-sync')).toBe(true);
    const companyFile = readFileSync(join(repo, 'companies', 'acme.md'), 'utf8');
    expect(companyFile).toContain('[Board Sync](meetings/2026-06-29-board-sync)');
    expect(companyFile).toContain('\n---\n\n## Timeline\n\n');
    expect(companyFile).not.toContain('<!-- timeline -->');
  });

  test('finalizer refuses completion without explicit agent review', async () => {
    const { repo, meetingPath } = await setupPropagatedMeeting({ readyForReview: true });
    const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default' });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.meetings[0].verificationErrors).toContain('missing --agent-reviewed; guidelines require explicit agent review before completion');
    expect(readFileSync(meetingPath, 'utf8')).toContain('ingestion_status: pending_propagation');
  });

  test('finalizer refuses unresolved candidate entity review markers', async () => {
    const { repo } = await setupPropagatedMeeting({ includeCandidateSkip: true });
    const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default', agentReviewed: true });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.meetings[0].verificationErrors.some(e => e.includes('needs agent review'))).toBe(true);
  });

  test('finalizer refuses missing attendee timeline entries', async () => {
    const { repo } = await setupPropagatedMeeting({ readyForReview: true });
    await engine.executeRaw(
      `DELETE FROM timeline_entries
       WHERE page_id IN (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)`,
      ['default', 'people/alice-example'],
    );

    const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default', agentReviewed: true });

    expect(result.completed).toBe(0);
    expect(result.meetings[0].verificationErrors).toContain('missing timeline entry on people/alice-example');
  });

  test('finalizer refuses missing entity backlinks', async () => {
    const { repo, slug } = await setupPropagatedMeeting({ readyForReview: true });
    await engine.removeLink('companies/acme', slug, undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });

    const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default', agentReviewed: true });

    expect(result.completed).toBe(0);
    expect(result.meetings[0].verificationErrors).toContain(`missing link companies/acme -> ${slug}`);
  });

  test('finalizer refuses untracked action items', async () => {
    const { repo, meetingPath } = await setupPropagatedMeeting({ readyForReview: true });
    const content = readFileSync(meetingPath, 'utf8').replace(/### Action Items\n[\s\S]*?\n### Skip Reasons/, '### Action Items\nNone\n\n### Skip Reasons');
    writeFileSync(meetingPath, content);

    const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default', agentReviewed: true });

    expect(result.completed).toBe(0);
    expect(result.meetings[0].verificationErrors).toContain('action items are present but no tracked action-item page is linked');
  });

  test('finalizer refuses when search does not return the meeting', async () => {
    const { repo } = await setupPropagatedMeeting({ readyForReview: true });
    const original = engine.searchKeyword.bind(engine);
    (engine as any).searchKeyword = async () => [];
    try {
      const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default', agentReviewed: true });
      expect(result.completed).toBe(0);
      expect(result.meetings[0].verificationErrors.some(e => e.includes('searchability check failed'))).toBe(true);
    } finally {
      (engine as any).searchKeyword = original;
    }
  });

  test('finalizer marks complete when strict checks pass and preserves transcript block', async () => {
    const { repo, meetingPath, transcriptBlock } = await setupPropagatedMeeting({ readyForReview: true });

    const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default', agentReviewed: true });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.meetings[0].status).toBe('complete');
    const updated = readFileSync(meetingPath, 'utf8');
    expect(updated).toContain('ingestion_status: complete');
    expect(updated).toContain('propagation_status: complete');
    expect(updated).toContain('propagation_reviewed_at:');
    expect(updated).toContain('propagation_verified_at:');
    expect(updated.slice(updated.indexOf('\n---\n\n## Transcript'))).toBe(transcriptBlock);
  });

  test('finalizer dry-run reports pass without writing', async () => {
    const { repo, meetingPath } = await setupPropagatedMeeting({ readyForReview: true });

    const result = await verifyCompleteMeetings(engine, { repoPath: repo, sourceId: 'default', agentReviewed: true, dryRun: true });

    expect(result.completed).toBe(1);
    expect(readFileSync(meetingPath, 'utf8')).toContain('ingestion_status: pending_propagation');
  });
});
