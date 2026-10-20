/** Calendar reader: EventKit via scripts/apple/calendar.swift (read-only). */
import { fileURLToPath } from 'node:url';
import type { AppleCalendarEvent } from '../types.ts';
import { readerError } from './errors.ts';
import { runHelper, type RunHelperOptions } from './run-helper.ts';
import { withHelperScript } from './embedded-scripts.ts';

/** Source-tree path of the helper (tests / `swiftc -typecheck`). Runtime uses the embedded text, see embedded-scripts.ts. */
export const CALENDAR_SCRIPT = fileURLToPath(new URL('../../../../scripts/apple/calendar.swift', import.meta.url));
export const SWIFT_BIN = '/usr/bin/swift';

export type HelperOverrides = Partial<Pick<RunHelperOptions, 'command' | 'timeoutMs' | 'maxStdoutBytes' | 'platform' | 'env'>> & {
  /** Prefix args placed before the script path (tests only). */
  scriptArgs?: string[];
};

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

export function normalizeEvent(raw: unknown): AppleCalendarEvent {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = str(o.id);
  const start = str(o.start);
  const end = str(o.end) ?? start;
  if (!id || !start || !end) {
    throw readerError('malformed_output', 'calendar', 'calendar item missing id/start/end');
  }
  const attendees = (Array.isArray(o.attendees) ? o.attendees : [])
    .map((a) => {
      const p = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      const out: { name?: string; email?: string } = {};
      const n = str(p.name);
      const e = str(p.email);
      if (n) out.name = n;
      if (e) out.email = e;
      return out;
    })
    .filter((a) => a.name || a.email);
  const ev: AppleCalendarEvent = {
    id,
    calendarId: str(o.calendarId) ?? '',
    calendarTitle: str(o.calendarTitle) ?? '',
    title: typeof o.title === 'string' ? o.title : '',
    start,
    end,
    allDay: o.allDay === true,
    attendees,
    recurring: o.recurring === true,
  };
  const location = str(o.location); if (location) ev.location = location;
  const notes = str(o.notes); if (notes) ev.notes = notes;
  const organizer = str(o.organizer); if (organizer) ev.organizer = organizer;
  const status = str(o.status); if (status) ev.status = status;
  const lastModified = str(o.lastModified); if (lastModified) ev.lastModified = lastModified;
  return ev;
}

/** Script argv prefix: a test override, else the embedded script written to a private temp file for this call. */
export async function withScriptArgs<T>(
  name: 'calendar.swift' | 'contacts.swift' | 'mail.js',
  o: HelperOverrides,
  prefix: string[],
  fn: (scriptArgs: string[]) => Promise<T>,
): Promise<T> {
  if (o.scriptArgs) return fn(o.scriptArgs);
  return withHelperScript(name, (path) => fn([...prefix, path, ...(name === 'mail.js' ? [] : ['--'])]));
}

export async function readCalendar(
  opts: { from: Date; to: Date; calendarIds: string[]; signal?: AbortSignal },
  o: HelperOverrides = {},
): Promise<AppleCalendarEvent[]> {
  const items = await withScriptArgs('calendar.swift', o, [], async (scriptArgs) => {
    const args = [...scriptArgs, '--from', opts.from.toISOString(), '--to', opts.to.toISOString()];
    if (opts.calendarIds.length > 0) args.push('--calendar-ids', opts.calendarIds.join(','));
    return runHelper({ service: 'calendar', command: o.command ?? SWIFT_BIN, args, signal: opts.signal, timeoutMs: o.timeoutMs, maxStdoutBytes: o.maxStdoutBytes, platform: o.platform, env: o.env });
  });
  return items.map(normalizeEvent);
}

export async function probeCalendar(o: HelperOverrides = {}): Promise<void> {
  await withScriptArgs('calendar.swift', o, [], (scriptArgs) =>
    runHelper({ service: 'calendar', command: o.command ?? SWIFT_BIN, args: [...scriptArgs, '--probe'], timeoutMs: o.timeoutMs ?? 60_000, platform: o.platform, env: o.env }));
}

/** Ask macOS for Calendar access (shows the permission prompt) without reading any event. */
export async function requestCalendarAccess(o: HelperOverrides = {}): Promise<void> {
  await withScriptArgs('calendar.swift', o, [], (scriptArgs) =>
    runHelper({ service: 'calendar', command: o.command ?? SWIFT_BIN, args: [...scriptArgs, '--request-access'], timeoutMs: o.timeoutMs ?? REQUEST_ACCESS_TIMEOUT_MS, platform: o.platform, env: o.env }));
}

/** The prompt waits for a person; allow longer than a read. */
export const REQUEST_ACCESS_TIMEOUT_MS = 150_000;
