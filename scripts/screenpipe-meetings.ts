import { resolve } from 'node:path';
import { fetchLocalJson, rejectProxies, stagePages, validateApiUrl } from './screenpipe-export.ts';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const meetingSchema = z.object({
  id: z.number().int().positive().safe(),
  meeting_start: z.string().datetime({ offset: true }),
  meeting_end: z.string().datetime({ offset: true }).nullable(),
  meeting_app: z.string(),
  title: z.string().nullable(),
  attendees: z.string().nullable(),
  note: z.string().nullable(),
});

export interface ExportOptions {
  apiUrl: string;
  token: string;
  device: string;
  ids: number[];
  output: string;
  write: boolean;
}

export function parseOptions(args: string[], token: string | undefined): ExportOptions {
  const { values } = parseArgs({ args, options: {
    'api-url': { type: 'string', default: 'http://127.0.0.1:3030' },
    device: { type: 'string' },
    ids: { type: 'string' },
    output: { type: 'string' },
    write: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  if (!token?.trim()) throw new Error('Set SCREENPIPE_LOCAL_API_KEY in the environment.');
  if (!values.device || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(values.device)) {
    throw new Error('--device must be a stable lowercase device label (1–48 letters, digits, hyphens).');
  }
  if (!values.ids || !/^[1-9]\d*(,[1-9]\d*)*$/.test(values.ids)) {
    throw new Error('--ids must contain selected positive meeting IDs, separated by commas.');
  }
  const ids = [...new Set(values.ids.split(',').map(Number))];
  if (ids.length > 50 || ids.some(id => !Number.isSafeInteger(id))) {
    throw new Error('Select at most 50 safe integer meeting IDs.');
  }
  if (!values.output?.trim()) throw new Error('--output must name a staging directory.');
  validateApiUrl(values['api-url']);
  return { apiUrl: values['api-url'], token, device: values.device, ids,
    output: resolve(values.output), write: values.write };
}

async function fetchMeeting(options: ExportOptions, id: number) {
  const data = await fetchLocalJson(options, `/meetings/${id}`, `Meeting ${id}`);
  const parsed = meetingSchema.safeParse(data);
  if (!parsed.success) throw new Error(`Meeting ${id}: invalid Screenpipe meeting response.`);
  const meeting = parsed.data;
  if (meeting.id !== id) throw new Error(`Meeting ${id}: response ID does not match.`);
  if (!meeting.meeting_end) throw new Error(`Meeting ${id}: still in progress.`);
  if (Date.parse(meeting.meeting_end) < Date.parse(meeting.meeting_start)) {
    throw new Error(`Meeting ${id}: end precedes start.`);
  }
  if (!meeting.note?.trim()) throw new Error(`Meeting ${id}: no saved note; save a note in Screenpipe first.`);
  return meeting;
}

export async function exportMeetings(options: ExportOptions): Promise<{ id: number; path: string; status: string }[]> {
  validateApiUrl(options.apiUrl);
  rejectProxies();
  const pages = [];
  for (const id of options.ids) {
    const meeting = await fetchMeeting(options, id);
    const metadata = {
      type: 'meeting', title: meeting.title || `Screenpipe meeting ${id}`,
      date: meeting.meeting_start.slice(0, 10),
      source_type: 'screenpipe', source_id: `screenpipe:${options.device}:meeting:${id}`,
      screenpipe_device: options.device, screenpipe_meeting_id: id,
      meeting_start: meeting.meeting_start, meeting_end: meeting.meeting_end,
      meeting_app: meeting.meeting_app, attendees: meeting.attendees,
    };
    const text = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n`
      + `Source: [Open in Screenpipe](screenpipe://timeline?timestamp=${encodeURIComponent(meeting.meeting_start)}) on ${options.device}.\n\n`
      + `## Saved meeting note\n\n${meeting.note!.trim()}\n`;
    pages.push({ id, name: `screenpipe-${options.device}-${id}.md`, text });
  }
  return stagePages(pages, options.output, options.write) as Promise<{ id: number; path: string; status: string }[]>;
}

if (import.meta.main) {
  try {
    const result = await exportMeetings(parseOptions(process.argv.slice(2), process.env.SCREENPIPE_LOCAL_API_KEY));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Screenpipe export failed.');
    process.exitCode = 1;
  }
}
