import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

function validateApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--api-url must be a plain HTTP loopback origin (127.0.0.1 or [::1]).');
  }
  return url;
}

async function fetchMeeting(options: ExportOptions, id: number) {
  const url = new URL(`/meetings/${id}`, validateApiUrl(options.apiUrl));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${options.token}`, 'X-Screenpipe-Client': 'api' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Older Bun releases throw synchronously for invalid headers.
    throw new Error(`Meeting ${id}: unable to reach the local Screenpipe API.`);
  }
  if (!response.ok) throw new Error(`Meeting ${id}: Screenpipe returned HTTP ${response.status}.`);
  if (!response.body) throw new Error(`Meeting ${id}: empty response.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error(`Meeting ${id}: response exceeds 2 MB.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (size === 0) throw new Error(`Meeting ${id}: empty response.`);
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error(`Meeting ${id}: invalid JSON response.`);
  }
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
  // Bun can proxy loopback requests; never send the local token through an inherited proxy.
  if (['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
    .some(name => process.env[name]?.trim())) {
    throw new Error('Clear HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, ALL_PROXY, and all_proxy for this local-only command.');
  }
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
  if (!options.write) return pages.map(page => ({ id: page.id, path: join(options.output, page.name), status: 'preview' }));
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const directory = await realpath(options.output);
  const results = [];
  for (const page of pages) {
    const target = join(directory, page.name);
    const temporary = join(directory, `.screenpipe-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(page.text);
      try {
        await link(temporary, target);
        results.push({ id: page.id, path: target, status: 'created' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await lstat(target);
        if (!stat.isFile() || await readFile(target, 'utf8') !== page.text) {
          throw new Error(`Meeting ${page.id}: destination exists with different content; review it manually.`);
        }
        results.push({ id: page.id, path: target, status: 'unchanged' });
      }
    } finally {
      await file.close();
      await unlink(temporary);
    }
  }
  return results;
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
