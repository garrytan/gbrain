import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { slugifyPath } from './sync.ts';

export type MeetingProvider = 'fireflies' | 'granola';
export type IngestionStatus = 'pending_propagation' | 'complete';

export interface MeetingAttendee {
  name?: string;
  email?: string;
}

export interface MeetingTranscriptSegment {
  speaker?: string;
  text: string;
  startSeconds?: number;
  startTime?: string;
  endTime?: string;
}

export interface NormalizedMeeting {
  provider: MeetingProvider;
  id: string;
  title: string;
  date: string;
  updatedAt?: string;
  durationMinutes?: number;
  location?: string;
  url?: string;
  attendees: MeetingAttendee[];
  summaryMarkdown?: string;
  summaryText?: string;
  keyDecisions: string[];
  actionItems: string[];
  discussionNotes: string[];
  transcript: MeetingTranscriptSegment[];
  raw?: unknown;
}

export interface MeetingSyncWindow {
  start?: string;
  end?: string;
}

export interface MeetingSyncResult {
  provider: MeetingProvider;
  fetched: number;
  created: number;
  skipped: number;
  failed: number;
  files: Array<{ path: string; title: string; sourceId: string; ingestionStatus: IngestionStatus }>;
  errors: Array<{ sourceId?: string; title?: string; error: string }>;
  warnings: string[];
}

export interface PendingMeeting {
  path: string;
  sourceId?: string;
  title?: string;
  ingestionStatus?: string;
}

export interface MeetingSyncOptions {
  providers: MeetingProvider[];
  repoPath: string;
  window: MeetingSyncWindow;
  dryRun?: boolean;
  force?: boolean;
}

const FIREFLIES_LIST_TOOL = 'FIREFLIES_GET_TRANSCRIPTS';
const FIREFLIES_DETAIL_TOOL = 'FIREFLIES_GET_TRANSCRIPT_BY_ID';
const GRANOLA_LIST_TOOL = 'GRANOLA_MCP_LIST_MEETINGS';
const GRANOLA_DETAIL_TOOL = 'GRANOLA_MCP_GET_MEETINGS';
const GRANOLA_TRANSCRIPT_TOOL = 'GRANOLA_MCP_GET_MEETING_TRANSCRIPT';

export function dateWindowFromArgs(opts: { all?: boolean; days?: number; start?: string; end?: string; now?: Date }): MeetingSyncWindow {
  if (opts.all) return { start: opts.start, end: opts.end };
  const end = opts.end ?? formatDate(opts.now ?? new Date());
  if (opts.start) return { start: opts.start, end };
  const days = opts.days ?? 2;
  const startDate = new Date(`${end}T00:00:00.000Z`);
  startDate.setUTCDate(startDate.getUTCDate() - Math.max(0, days - 1));
  return { start: formatDate(startDate), end };
}

export function normalizeProviderList(raw: string | undefined): MeetingProvider[] {
  if (!raw || raw === 'all') return ['fireflies', 'granola'];
  const providers = raw.split(',').map(s => s.trim()).filter(Boolean);
  const out: MeetingProvider[] = [];
  for (const p of providers) {
    if (p !== 'fireflies' && p !== 'granola') {
      throw new Error(`Unknown meeting provider "${p}". Expected fireflies, granola, or all.`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out.length > 0 ? out : ['fireflies', 'granola'];
}

export async function syncMeetings(opts: MeetingSyncOptions): Promise<MeetingSyncResult[]> {
  const meetingsDir = join(resolve(opts.repoPath), 'meetings');
  if (!opts.dryRun) mkdirSync(meetingsDir, { recursive: true });

  const results: MeetingSyncResult[] = [];
  for (const provider of opts.providers) {
    const providerResult: MeetingSyncResult = {
      provider,
      fetched: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      files: [],
      errors: [],
      warnings: [],
    };
    try {
      const beforeFetchErrors = providerResult.errors.length;
      const meetings = provider === 'fireflies'
        ? await fetchFirefliesMeetings(opts.window, providerResult.errors)
        : await fetchGranolaMeetings(opts.window, providerResult.errors);
      providerResult.failed += providerResult.errors.length - beforeFetchErrors;
      providerResult.fetched = meetings.length;

      for (const meeting of meetings) {
        const sourceId = externalSourceId(meeting);
        const relPath = meetingMarkdownRelativePath(meeting);
        const outPath = join(resolve(opts.repoPath), relPath);
        const exists = !opts.force && meetingExists(meetingsDir, sourceId, outPath);
        if (exists) {
          providerResult.skipped++;
          continue;
        }
        if (meeting.transcript.length === 0) {
          providerResult.failed++;
          providerResult.errors.push({
            sourceId,
            title: meeting.title,
            error: 'missing diarized/raw transcript; skipped summary-only meeting page',
          });
          continue;
        }
        const markdown = renderMeetingMarkdown(meeting);
        providerResult.files.push({ path: outPath, title: meeting.title, sourceId, ingestionStatus: 'pending_propagation' });
        providerResult.created++;
        if (!opts.dryRun) {
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, markdown);
        }
      }
    } catch (e) {
      providerResult.failed++;
      providerResult.errors.push({ error: e instanceof Error ? e.message : String(e) });
    }
    results.push(providerResult);
  }
  return results;
}

export function listPendingMeetings(repoPath: string): PendingMeeting[] {
  const meetingsDir = join(resolve(repoPath), 'meetings');
  if (!existsSync(meetingsDir)) return [];
  const out: PendingMeeting[] = [];
  for (const path of listMarkdownFiles(meetingsDir)) {
    const content = safeRead(path);
    if (!content) continue;
    const ingestionStatus = extractFrontmatterScalar(content, 'ingestion_status');
    if (ingestionStatus === 'complete') continue;
    out.push({
      path,
      sourceId: extractFrontmatterScalar(content, 'source_id'),
      title: extractFrontmatterScalar(content, 'title'),
      ingestionStatus: ingestionStatus || undefined,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function fetchFirefliesMeetings(window: MeetingSyncWindow, errors: MeetingSyncResult['errors'] = []): Promise<NormalizedMeeting[]> {
  const out: NormalizedMeeting[] = [];
  const limit = 50;
  const seenIds = new Set<string>();
  for (let skip = 0; ; skip += limit) {
    const payload: Record<string, unknown> = {
      skip,
      limit,
      include_summary: false,
      include_sentences: false,
      include_meeting_attendees: true,
    };
    if (window.start) payload.from_date = `${window.start}T00:00:00Z`;
    if (window.end) payload.to_date = `${window.end}T23:59:59Z`;
    const listed = await executeComposioTool(FIREFLIES_LIST_TOOL, payload);
    const rows = normalizeArrayCandidate(listed, ['transcripts', 'data.transcripts', 'response.data.transcripts', 'data']);
    let newIds = 0;
    for (const row of rows) {
      const id = String(row?.id ?? row?.transcript_id ?? '').trim();
      if (!id) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newIds++;
      try {
        const detail = await executeComposioTool(FIREFLIES_DETAIL_TOOL, { id, include_sentences: true });
        const meeting = normalizeFirefliesTranscript(unwrapSingleRecord(detail, ['transcript', 'data.transcript', 'response.data.transcript', 'data']) ?? detail);
        if (meeting) out.push(meeting);
      } catch (e) {
        errors.push({
          sourceId: `fireflies:${id}`,
          title: cleanScalar(row?.title),
          error: `detail fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    if (rows.length < limit || newIds === 0) break;
  }
  return out.filter(m => meetingWithinWindow(m, window));
}

export async function fetchGranolaMeetings(window: MeetingSyncWindow, errors: MeetingSyncResult['errors'] = []): Promise<NormalizedMeeting[]> {
  const out: NormalizedMeeting[] = [];
  const ranges = granolaRanges(window);
  const ids = new Set<string>();
  for (const range of ranges) {
    const listed = await executeComposioTool(GRANOLA_LIST_TOOL, range);
    for (const id of extractGranolaMeetingIds(listed)) ids.add(id);
  }

  const idsArray = Array.from(ids);
  for (let i = 0; i < idsArray.length; i += 10) {
    const batch = idsArray.slice(i, i + 10);
    let details: unknown;
    try {
      details = await executeComposioTool(GRANOLA_DETAIL_TOOL, { meeting_ids: batch });
    } catch (e) {
      for (const id of batch) {
        errors.push({
          sourceId: `granola:${id}`,
          error: `detail fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }
    const byId = extractGranolaMeetingSummaries(details);
    const meetings = normalizeArrayCandidate(details, ['meetings', 'data.meetings', 'response.data.meetings', 'data']);
    for (const meeting of meetings) {
      const id = String(meeting?.id ?? meeting?.meeting_id ?? '').trim();
      if (id) byId.set(id, meeting);
    }
    for (const id of batch) {
      try {
        const transcriptPayload = await executeComposioTool(GRANOLA_TRANSCRIPT_TOOL, { meeting_id: id });
        const normalized = normalizeGranolaMeeting(byId.get(id), id, transcriptPayload);
        if (normalized) out.push(normalized);
      } catch (e) {
        errors.push({
          sourceId: `granola:${id}`,
          title: cleanScalar((byId.get(id) as any)?.title),
          error: `transcript fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }
  return out.filter(m => meetingWithinWindow(m, window));
}

export function renderMeetingMarkdown(meeting: NormalizedMeeting): string {
  const attendees = filterAttendees(meeting.attendees);
  const tags = inferMeetingTags(meeting.title);
  const frontmatter = [
    '---',
    `id: ${yamlScalar(`meeting:${meeting.provider}:${meeting.id}`)}`,
    'type: meeting',
    `title: ${yamlScalar(meeting.title)}`,
    `date: ${yamlScalar(meeting.date)}`,
    `source: ${yamlScalar(meeting.provider)}`,
    `source_type: ${yamlScalar(meeting.provider)}`,
    `source_id: ${yamlScalar(externalSourceId(meeting))}`,
    `provider_id: ${yamlScalar(meeting.id)}`,
    'ingestion_status: pending_propagation',
    ...(meeting.updatedAt ? [`updated_at: ${yamlScalar(meeting.updatedAt)}`] : []),
    ...(meeting.durationMinutes ? [`duration: ${yamlScalar(`${meeting.durationMinutes} min`)}`] : []),
    ...(meeting.location ? [`location: ${yamlScalar(meeting.location)}`] : []),
    ...(meeting.url ? [`source_url: ${yamlScalar(meeting.url)}`] : []),
    'attendees:',
    ...attendees.map(a => `  - name: ${yamlScalar(a.name || 'Unknown')}${a.email ? `\n    email: ${yamlScalar(a.email)}` : ''}`),
    `tags: [${tags.map(yamlScalar).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const summary = (meeting.summaryMarkdown || meeting.summaryText || '').trim();
  const keyDecisions = formatBulletSection(meeting.keyDecisions);
  const actionItems = meeting.actionItems.length > 0
    ? meeting.actionItems.map(item => `- [ ] ${item}`).join('\n')
    : 'None';
  const discussionNotes = formatBulletSection(meeting.discussionNotes);
  const attendeeList = attendees.length > 0
    ? attendees.map(a => `- ${a.name || 'Unknown'}`).join('\n')
    : 'None';
  const transcript = meeting.transcript.map(formatTranscriptSegment).join('\n');

  return [
    frontmatter,
    `# ${meeting.title}`,
    '',
    '## Summary',
    summary || 'None',
    '',
    '## Key Decisions',
    keyDecisions,
    '',
    '## Action Items',
    actionItems,
    '',
    '## Discussion Notes / Key Points',
    discussionNotes,
    '',
    '## Attendees',
    attendeeList,
    '',
    '---',
    '',
    '## Transcript',
    '',
    transcript,
    '',
  ].join('\n');
}

export function meetingMarkdownRelativePath(meeting: NormalizedMeeting): string {
  const title = meeting.title.replace(/[\\/]+/g, ' ');
  const titleSlug = slugifyPath(`${meeting.date}-${title}.md`).split('/').pop() || `${meeting.date}-meeting`;
  return `meetings/${titleSlug}.md`;
}

export function externalSourceId(meeting: NormalizedMeeting): string {
  return `${meeting.provider}:${meeting.id}`;
}

export function meetingExists(meetingsDir: string, sourceId: string, targetPath: string): boolean {
  if (existsSync(targetPath)) return true;
  if (!existsSync(meetingsDir)) return false;
  const needles = [
    `source_id: ${sourceId}`,
    `source_id: "${sourceId}"`,
    `source_id: '${sourceId}'`,
    `id: meeting:${sourceId}`,
    `id: "meeting:${sourceId}"`,
    `id: 'meeting:${sourceId}'`,
  ];
  for (const file of listMarkdownFiles(meetingsDir)) {
    const content = safeRead(file);
    if (content && needles.some(n => content.includes(n))) return true;
  }
  return false;
}

export function filterAttendees(attendees: MeetingAttendee[]): MeetingAttendee[] {
  const seen = new Set<string>();
  const out: MeetingAttendee[] = [];
  for (const a of attendees) {
    const email = cleanEmail(a.email);
    const name = cleanName(a.name) || displayNameFromEmail(email);
    if (!name && !email) continue;
    if (isLikelyResourceOrGroup(name, email)) continue;
    const key = (email ?? name ?? '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || 'Unknown', email });
  }
  return out;
}

export function inferMeetingTags(title: string): string[] {
  const lower = title.toLowerCase();
  const tags: string[] = [];
  if (lower.includes('office hours') || /\boh\b/.test(lower)) tags.push('oh');
  if (lower.includes('standup') || lower.includes('sync')) tags.push('sync');
  if (lower.includes('1:1') || lower.includes('1-on-1') || lower.includes('1on1')) tags.push('1on1');
  if (lower.includes('board')) tags.push('board');
  if (lower.includes('policy') || lower.includes('civic')) tags.push('civic');
  return tags.length > 0 ? tags : ['meeting'];
}

export function extractGranolaMeetingIds(payload: unknown): string[] {
  const text = collectText(payload);
  const ids = new Set<string>();
  for (const match of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)) {
    ids.add(match[0].toLowerCase());
  }
  return Array.from(ids);
}

function extractGranolaMeetingSummaries(payload: unknown): Map<string, unknown> {
  const text = collectText(payload);
  const out = new Map<string, unknown>();
  for (const match of text.matchAll(/<meeting\s+([^>]*\bid="[^"]+"[^>]*)>([\s\S]*?)<\/meeting>/gi)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const id = attrValue(attrs, 'id')?.toLowerCase();
    if (!id) continue;
    const participantBlock = body.match(/<known_participants>([\s\S]*?)<\/known_participants>/i)?.[1] ?? '';
    const summary = body.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim();
    out.set(id, {
      id,
      title: attrValue(attrs, 'title')?.trim(),
      start_time: attrValue(attrs, 'date'),
      attendees: parseGranolaParticipants(participantBlock),
      summary_markdown: summary,
    });
  }
  return out;
}

function attrValue(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match?.[1];
}

function parseGranolaParticipants(text: string): MeetingAttendee[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const email = line.match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1];
    const name = line.replace(/<[^<>]+>/g, '').replace(/\([^)]*\)/g, '').replace(/\s+from\s+.+$/i, '').trim();
    return { name, email };
  });
}

function executeComposioTool(slug: string, payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    execFile('composio', ['execute', slug, '-d', JSON.stringify(payload)], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      if (error) {
        const e = error as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === 'ENOENT') {
          reject(new Error('composio CLI not found on PATH'));
          return;
        }
        const timedOut = (e as any).killed || (e as any).signal === 'SIGTERM';
        const detail = timedOut ? 'timed out after 60000ms' : String(stderr || e.stderr || e.message || e).trim();
        reject(new Error(`composio ${slug} failed${detail ? `: ${detail}` : ''}`));
        return;
      }
      try {
        resolvePromise(parseComposioOutput(String(stdout ?? '')));
      } catch {
        reject(new Error(`composio ${slug} returned non-JSON output`));
      }
    });
  });
}

function parseComposioOutput(stdout: string): unknown {
  const parsed = JSON.parse(stdout);
  if (
    parsed
    && typeof parsed === 'object'
    && (parsed as any).storedInFile === true
    && typeof (parsed as any).outputFilePath === 'string'
  ) {
    return JSON.parse(readFileSync((parsed as any).outputFilePath, 'utf8'));
  }
  return parsed;
}

function normalizeFirefliesTranscript(payload: any): NormalizedMeeting | null {
  const row = unwrapSingleRecord(payload, ['transcript', 'data.transcript', 'response.data.transcript']) ?? payload;
  const id = String(row?.id ?? row?.transcript_id ?? '').trim();
  if (!id) return null;
  const date = normalizeDate(row.dateString ?? row.date ?? row.start_time ?? row.meeting_date) ?? formatDate(new Date());
  const summary = row.summary ?? {};
  const sentences = normalizeArrayCandidate(row, ['sentences', 'transcript.sentences']);
  return {
    provider: 'fireflies',
    id,
    title: String(row.title ?? row.meeting_title ?? 'Untitled meeting'),
    date,
    durationMinutes: normalizeDurationMinutes(row.duration),
    location: cleanScalar(row.location ?? row.meeting_link ?? row.meeting_url),
    url: row.transcript_url || row.meeting_link || row.meeting_url || undefined,
    attendees: [
      ...normalizeFirefliesAttendees(row.meeting_attendees),
      ...normalizeStringList(row.participants).map(name => ({ name })),
      ...normalizeStringList(row.fireflies_users).map(name => ({ name })),
    ],
    summaryText: [summary.overview, summary.short_summary, summary.bullet_gist, summary.gist].filter(Boolean).join('\n\n'),
    keyDecisions: normalizeStringList(summary.key_decisions ?? summary.decisions),
    actionItems: normalizeStringList(summary.action_items),
    discussionNotes: normalizeStringList(summary.topics_discussed ?? summary.notes ?? summary.keywords),
    transcript: sentences.map((s: any) => ({
      speaker: s.speaker_name ?? s.speaker ?? s.name,
      text: String(s.text ?? s.raw_text ?? '').trim(),
      startSeconds: numberOrUndefined(s.start_time ?? s.start_seconds),
      endTime: s.end_time != null ? String(s.end_time) : undefined,
    })).filter((s: MeetingTranscriptSegment) => s.text),
    raw: row,
  };
}

function normalizeGranolaMeeting(meetingPayload: unknown, fallbackId: string, transcriptPayload: unknown): NormalizedMeeting | null {
  const row = unwrapSingleRecord(meetingPayload, ['meeting', 'data.meeting']) ?? meetingPayload ?? {};
  const transcript = normalizeGranolaTranscript(transcriptPayload);
  const id = String((row as any)?.id ?? (row as any)?.meeting_id ?? fallbackId).trim();
  if (!id) return null;
  const start = (row as any)?.calendar_event?.scheduled_start_time ?? (row as any)?.start_time ?? (row as any)?.created_at;
  const date = normalizeDate(start) ?? formatDate(new Date());
  const meetingStartMs = Date.parse(String(start ?? `${date}T00:00:00.000Z`));
  return {
    provider: 'granola',
    id,
    title: String((row as any)?.title || (row as any)?.calendar_event?.event_title || 'Untitled meeting'),
    date,
    updatedAt: (row as any)?.updated_at,
    durationMinutes: durationFromIsoRange((row as any)?.calendar_event?.scheduled_start_time, (row as any)?.calendar_event?.scheduled_end_time),
    location: cleanScalar((row as any)?.calendar_event?.location ?? (row as any)?.location),
    url: (row as any)?.web_url,
    attendees: Array.isArray((row as any)?.attendees)
      ? (row as any).attendees.map((a: any) => ({ name: a.name, email: a.email }))
      : [],
    summaryMarkdown: (row as any)?.summary_markdown ?? undefined,
    summaryText: (row as any)?.summary_text ?? undefined,
    keyDecisions: normalizeStringList((row as any)?.key_decisions ?? (row as any)?.decisions),
    actionItems: normalizeStringList((row as any)?.action_items),
    discussionNotes: normalizeStringList((row as any)?.notes ?? (row as any)?.topics),
    transcript: transcript.map((s) => ({
      ...s,
      startSeconds: s.startSeconds ?? secondsSince(s.startTime, meetingStartMs),
    })),
    raw: { meeting: row, transcript: transcriptPayload },
  };
}

function normalizeGranolaTranscript(payload: unknown): MeetingTranscriptSegment[] {
  const textOrJson = unwrapText(payload);
  const parsed = maybeParseJson(textOrJson);
  const candidate = parsed ?? payload;
  const rows = normalizeArrayCandidate(candidate, ['transcript', 'data.transcript', 'segments', 'sentences']);
  if (rows.length > 0) {
    return rows.map((s: any) => ({
      speaker: normalizeSpeaker(s.speaker ?? s.speaker_name ?? s.diarization_label),
      text: String(s.text ?? s.raw_text ?? '').trim(),
      startTime: s.start_time,
      endTime: s.end_time,
      startSeconds: numberOrUndefined(s.start_seconds ?? s.start),
    })).filter((s: MeetingTranscriptSegment) => s.text);
  }
  const transcriptText = typeof (candidate as any)?.transcript === 'string'
    ? (candidate as any).transcript
    : typeof textOrJson === 'string' ? textOrJson : '';
  return transcriptTextToSegments(transcriptText);
}

function granolaRanges(window: MeetingSyncWindow): Array<Record<string, string>> {
  if (!window.start && !window.end) {
    return chunkDateRanges('2020-01-01', formatDate(new Date())).map(r => ({
      time_range: 'custom',
      custom_start: r.start,
      custom_end: r.end,
    }));
  }
  const start = window.start ?? '2020-01-01';
  const end = window.end ?? formatDate(new Date());
  return chunkDateRanges(start, end).map(r => ({
    time_range: 'custom',
    custom_start: r.start,
    custom_end: r.end,
  }));
}

function chunkDateRanges(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(endDate.getTime()) || cursor > endDate) return out;
  while (cursor <= endDate) {
    const rangeStart = new Date(cursor);
    const rangeEnd = new Date(cursor);
    rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 29);
    if (rangeEnd > endDate) rangeEnd.setTime(endDate.getTime());
    out.push({ start: formatDate(rangeStart), end: formatDate(rangeEnd) });
    cursor = new Date(rangeEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function meetingWithinWindow(meeting: NormalizedMeeting, window: MeetingSyncWindow): boolean {
  if (window.start && meeting.date < window.start) return false;
  if (window.end && meeting.date > window.end) return false;
  return true;
}

function normalizeFirefliesAttendees(rows: any): MeetingAttendee[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(a => ({ name: a.displayName ?? a.name, email: a.email }));
}

function normalizeSpeaker(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return cleanScalar(row.name ?? row.diarization_label ?? row.source);
  }
  return cleanScalar(value);
}

function transcriptTextToSegments(text: string): MeetingTranscriptSegment[] {
  const inline = transcriptInlineSpeakerSegments(text);
  if (inline.length > 0) return inline;
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(?:\*\*)?([^:*()[\]]+?)(?:\*\*)?\s*(?:\(([^)]+)\)|\[([^\]]+)\])?\s*:\s*(.+)$/);
    if (!m) return { speaker: 'Unknown', text: line };
    return {
      speaker: m[1]?.trim(),
      startTime: m[2] || m[3] || undefined,
      text: m[4]?.trim() ?? '',
    };
  }).filter(s => s.text);
}

function transcriptInlineSpeakerSegments(text: string): MeetingTranscriptSegment[] {
  if (text.includes('\n')) return [];
  const marker = /(?:^|\s)(Me|Them):\s*/g;
  const matches = Array.from(text.matchAll(marker));
  if (matches.length === 0) return [];
  const out: MeetingTranscriptSegment[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const next = matches[i + 1];
    const speaker = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = next?.index ?? text.length;
    const segmentText = text.slice(start, end).trim();
    if (segmentText) out.push({ speaker, text: segmentText });
  }
  return out;
}

function normalizeArrayCandidate(value: any, paths: string[]): any[] {
  if (Array.isArray(value)) return value;
  for (const path of paths) {
    const v = getPath(value, path);
    if (Array.isArray(v)) return v;
  }
  return [];
}

function unwrapSingleRecord(value: any, paths: string[]): any | null {
  for (const path of paths) {
    const v = getPath(value, path);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

function getPath(value: any, path: string): any {
  let cur = value;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function unwrapText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const text = getPath(payload as any, 'data.data.0.text')
    ?? getPath(payload as any, 'data.0.text')
    ?? getPath(payload as any, 'content.0.text')
    ?? getPath(payload as any, 'text');
  return typeof text === 'string' ? text : '';
}

function maybeParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload == null) return '';
  if (Array.isArray(payload)) return payload.map(collectText).join('\n');
  if (typeof payload === 'object') return Object.values(payload as Record<string, unknown>).map(collectText).join('\n');
  return String(payload);
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function formatTranscriptSegment(segment: MeetingTranscriptSegment): string {
  const speaker = segment.speaker?.trim() || 'Unknown';
  const timestamp = typeof segment.startSeconds === 'number'
    ? formatTimestamp(segment.startSeconds)
    : segment.startTime ? segment.startTime : '00:00';
  return `**${speaker}** (${timestamp}): ${segment.text}`;
}

function formatTimestamp(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBulletSection(items: string[]): string {
  return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : 'None';
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function normalizeDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') return formatDate(new Date(value));
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return formatDate(new Date(parsed));
  return null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeDurationMinutes(value: unknown): number | undefined {
  const n = numberOrUndefined(value);
  if (n == null || n <= 0) return undefined;
  return Math.max(1, Math.round(n > 600 ? n / 60 : n));
}

function durationFromIsoRange(start: unknown, end: unknown): number | undefined {
  const a = Date.parse(String(start ?? ''));
  const b = Date.parse(String(end ?? ''));
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return undefined;
  return Math.max(1, Math.round((b - a) / 60_000));
}

function secondsSince(value: unknown, startMs: number): number | undefined {
  const ms = Date.parse(String(value ?? ''));
  if (Number.isNaN(ms) || Number.isNaN(startMs)) return undefined;
  return Math.max(0, Math.round((ms - startMs) / 1000));
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/\n|,/).map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  }
  return [];
}

function cleanScalar(value: unknown): string | undefined {
  const s = String(value ?? '').trim();
  return s ? s : undefined;
}

function cleanName(value: unknown): string | undefined {
  const s = String(value ?? '').trim();
  if (!s || s.includes('@')) return undefined;
  return s.replace(/\s+/g, ' ');
}

function cleanEmail(value: unknown): string | undefined {
  const s = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : undefined;
}

function displayNameFromEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  return email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function isLikelyResourceOrGroup(name: string | undefined, email: string | undefined): boolean {
  const n = (name ?? '').toLowerCase();
  const e = (email ?? '').toLowerCase();
  const local = e.split('@')[0] ?? '';
  if (e.endsWith('@resource.calendar.google.com')) return true;
  if (/\b(room|conference|conf|calendar|resource|zoom|meet|webex|teams)\b/.test(n)) return true;
  if (/^(team|all|everyone|staff|office|group|list|calendar|room|conf|no-?reply|noreply)([._-]|$)/.test(local)) return true;
  if (local.includes('+calendar') || local.includes('resource')) return true;
  return false;
}

function extractFrontmatterScalar(content: string, key: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const line = frontmatter[1].split('\n').find(l => l.startsWith(`${key}:`));
  if (!line) return undefined;
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
