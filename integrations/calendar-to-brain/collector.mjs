#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const DEFAULT_BRAIN_DIR = path.join(HOME, 'brain');
const DEFAULT_OUTPUT_ROOT = path.join(DEFAULT_BRAIN_DIR, 'sources', 'google-calendar');
const DEFAULT_STATE_FILE = path.join(HOME, '.gbrain', 'integrations', 'calendar-to-brain', 'state.json');
const DEFAULT_SMOKE_STATE = path.join(HOME, '.gbrain', 'integrations', 'clawvisor', 'smoke-state.json');
const DEFAULT_MAX_RESULTS = 3;
const TASK_TTL_SECONDS = 1800;
const REQUEST_TIMEOUT_MS = 20000;
const APPROVAL_NEEDED_EXIT_CODE = 2;

function usage() {
  return [
    'Usage:',
    '  node integrations/calendar-to-brain/collector.mjs [options]',
    '',
    'Safe defaults:',
    '  - dry-run by default',
    '  - short date window only (today + tomorrow unless overridden)',
    '  - max 3 events by default',
    '',
    'Options:',
    '  --from YYYY-MM-DD        Inclusive local start date',
    '  --to YYYY-MM-DD          Inclusive local end date (defaults to --from if set)',
    '  --max-results N          Max events requested from ClawVisor (default: 3)',
    '  --dry-run                Do not write to ~/brain (default)',
    '  --write                  Write markdown files under ~/brain/sources/google-calendar/',
    '  --task-id ID             Reuse an existing ClawVisor task id',
    '  --create-task            Create a short-lived list_events task before fetching',
    '  --service ID             Override service alias (ex: google.calendar:[redacted])',
    '  --session-id UUID        Pass session_id for standing tasks if needed',
    '  --mock                   Use the local fixture instead of ClawVisor',
    '  --mock-file PATH         Override fixture path for --mock',
    '  --output-root PATH       Override markdown output root',
    '  --state-file PATH        Override local state file path',
    '  --help                   Show this help',
    '',
    'Examples:',
    '  op run --env-file "$HOME/.gbrain/gbrain-op.env" -- node integrations/calendar-to-brain/collector.mjs --mock --dry-run',
    '  op run --env-file "$HOME/.gbrain/gbrain-op.env" -- node integrations/calendar-to-brain/collector.mjs --create-task --dry-run',
    '  op run --env-file "$HOME/.gbrain/gbrain-op.env" -- node integrations/calendar-to-brain/collector.mjs --task-id <task-id> --write --from 2026-05-09 --to 2026-05-10 --max-results 3',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    write: false,
    createTask: false,
    mock: false,
    maxResults: DEFAULT_MAX_RESULTS,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    stateFile: DEFAULT_STATE_FILE,
    smokeStateFile: DEFAULT_SMOKE_STATE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--help':
        args.help = true;
        break;
      case '--from':
        args.from = requireValue(arg, next);
        i += 1;
        break;
      case '--to':
        args.to = requireValue(arg, next);
        i += 1;
        break;
      case '--max-results':
        args.maxResults = parsePositiveInt(requireValue(arg, next), arg);
        i += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        args.write = false;
        break;
      case '--write':
        args.write = true;
        args.dryRun = false;
        break;
      case '--task-id':
        args.taskId = requireValue(arg, next);
        i += 1;
        break;
      case '--create-task':
        args.createTask = true;
        break;
      case '--service':
        args.serviceId = requireValue(arg, next);
        i += 1;
        break;
      case '--session-id':
        args.sessionId = requireValue(arg, next);
        i += 1;
        break;
      case '--mock':
        args.mock = true;
        break;
      case '--mock-file':
        args.mock = true;
        args.mockFile = requireValue(arg, next);
        i += 1;
        break;
      case '--output-root':
        args.outputRoot = expandHome(requireValue(arg, next));
        i += 1;
        break;
      case '--state-file':
        args.stateFile = expandHome(requireValue(arg, next));
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.createTask && args.taskId) {
    throw new Error('--create-task and --task-id are mutually exclusive');
  }

  if (args.from && !args.to) args.to = args.from;
  if (args.to && !args.from) args.from = args.to;

  if (args.from) validateDateOnly(args.from, '--from');
  if (args.to) validateDateOnly(args.to, '--to');

  if (!args.from || !args.to) {
    const defaults = defaultShortRange();
    args.from ??= defaults.from;
    args.to ??= defaults.to;
  }

  if (args.maxResults > 50) {
    throw new Error('--max-results must be <= 50 for this minimal collector');
  }

  return args;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

function validateDateOnly(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${flag} must be YYYY-MM-DD`);
  }
}

function defaultShortRange(now = new Date()) {
  const from = toLocalDateString(now);
  const tomorrow = addDays(from, 1);
  return { from, to: tomorrow };
}

function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateOnly, days) {
  const d = new Date(`${dateOnly}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalDateString(d);
}

function buildRequestedWindow(fromDate, toDateInclusive) {
  const from = new Date(`${fromDate}T00:00:00`);
  const toExclusive = new Date(`${addDays(toDateInclusive, 1)}T00:00:00`);
  return {
    fromDate,
    toDateInclusive,
    fromIso: from.toISOString(),
    toIso: toExclusive.toISOString(),
  };
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return HOME;
  if (value.startsWith('~/')) return path.join(HOME, value.slice(2));
  return value;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function loadSmokeDefaults(smokeStateFile) {
  const data = safeReadJson(smokeStateFile);
  if (!data || typeof data !== 'object') return {};
  return {
    taskId: typeof data.task_id === 'string' ? data.task_id : undefined,
    serviceId: data.services && typeof data.services['google.calendar'] === 'string'
      ? data.services['google.calendar']
      : undefined,
  };
}

function writeFileAtomic(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, { mode });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, mode);
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function clawvisorRequest({ url, token, method = 'GET', body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const raw = await response.text();
    let json;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = { raw };
    }

    if (!response.ok) {
      const error = new Error(`ClawVisor request failed (${response.status})`);
      error.status = response.status;
      error.payload = json;
      throw error;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function createShortTask({ baseUrl, token, serviceId, range, maxResults }) {
  const body = {
    purpose: 'Read Google Calendar events over a short date range for a local calendar-to-brain import. Allowed action is list_events only; no calendar writes, updates, cancellations, or invitations.',
    authorized_actions: [
      {
        service: serviceId,
        action: 'list_events',
        auto_execute: true,
        expected_use: 'List events within a short date range to produce a local markdown snapshot, count events, and support dry-run verification before any write to the brain.',
      },
    ],
    planned_calls: [
      {
        service: serviceId,
        action: 'list_events',
        params: {
          from: range.fromIso,
          to: range.toIso,
          max_results: maxResults,
        },
        reason: 'List events in the requested short date range for a safe local calendar-to-brain collection run.',
      },
    ],
    expires_in_seconds: TASK_TTL_SECONDS,
  };

  return clawvisorRequest({
    url: `${baseUrl}/api/tasks`,
    token,
    method: 'POST',
    body,
  });
}

async function getTaskStatus({ baseUrl, token, taskId }) {
  return clawvisorRequest({
    url: `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`,
    token,
  });
}

async function requestEvents({ baseUrl, token, taskId, serviceId, range, maxResults, sessionId }) {
  const body = {
    service: serviceId,
    action: 'list_events',
    params: {
      from: range.fromIso,
      to: range.toIso,
      max_results: maxResults,
    },
    reason: `Listing calendar events from ${range.fromDate} to ${range.toDateInclusive} for a safe local calendar-to-brain collection run.`,
    request_id: `calendar-to-brain-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    task_id: taskId,
  };
  if (sessionId) body.session_id = sessionId;

  return clawvisorRequest({
    url: `${baseUrl}/api/gateway/request?wait=true`,
    token,
    method: 'POST',
    body,
  });
}

function findEventArray(node, depth = 0) {
  if (depth > 5 || node == null) return null;
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every((item) => isEventLike(item))) {
      return node;
    }
    for (const item of node) {
      const found = findEventArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const directKeys = ['events', 'items'];
  for (const key of directKeys) {
    if (Array.isArray(node[key]) && node[key].length > 0 && node[key].every((item) => isEventLike(item))) {
      return node[key];
    }
  }

  for (const value of Object.values(node)) {
    const found = findEventArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function isEventLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.includes('start') || keys.includes('startTime') || keys.includes('date') || keys.includes('summary') || keys.includes('title');
}

function normalizeEvents(payload) {
  const rawEvents = findEventArray(payload) ?? [];
  return rawEvents
    .map((event) => normalizeEvent(event))
    .filter(Boolean)
    .sort(compareEvents);
}

function normalizeEvent(event) {
  const status = stringOrUndefined(event.status);
  if (status === 'cancelled') return null;

  const start = extractDateTime(event.start ?? event.startTime ?? event.date ?? event.start_date);
  const end = extractDateTime(event.end ?? event.endTime ?? event.end_date);
  const allDay = start ? !String(start.raw).includes('T') : false;
  const day = start?.day ?? (typeof event.date === 'string' ? event.date.slice(0, 10) : undefined);
  if (!day) return null;

  const attendees = normalizeAttendees(event.attendees ?? event.participants ?? []);

  return {
    id: stringOrUndefined(event.id) ?? stringOrUndefined(event.event_id) ?? `event-${crypto.randomUUID()}`,
    day,
    title: stringOrUndefined(event.summary) ?? stringOrUndefined(event.title) ?? '(sans titre)',
    status,
    allDay,
    startRaw: start?.raw,
    endRaw: end?.raw,
    startDisplay: allDay ? 'All day' : start?.time ?? '??:??',
    endDisplay: allDay ? null : end?.time ?? null,
    startSort: allDay ? '00:00' : start?.time ?? '99:99',
    attendees,
    location: stringOrUndefined(event.location),
    calendarLabel: stringOrUndefined(event.calendar_name)
      ?? stringOrUndefined(event.calendar)
      ?? stringOrUndefined(event.organizer?.displayName),
  };
}

function extractDateTime(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return normalizeDateString(value);
  }
  if (typeof value === 'object') {
    if (typeof value.dateTime === 'string') return normalizeDateString(value.dateTime);
    if (typeof value.date === 'string') return normalizeDateString(value.date);
    if (typeof value.value === 'string') return normalizeDateString(value.value);
  }
  return null;
}

function normalizeDateString(raw) {
  const day = raw.slice(0, 10);
  const hasTime = raw.includes('T');
  let time = null;
  if (hasTime) {
    // Preserve the calendar-local wall time returned by Google/ClawVisor.
    // Do not round-trip through Date(), otherwise offsets like +02:00 render
    // as the host timezone/UTC and shift 09:00 to 07:00 on some runtimes.
    const match = raw.match(/T(\d{2}):(\d{2})/);
    time = match ? `${match[1]}:${match[2]}` : null;
  }
  return { raw, day, time };
}

function normalizeAttendees(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const attendees = [];
  for (const attendee of input) {
    if (!attendee || typeof attendee !== 'object') continue;
    if (attendee.resource) continue;
    const name = attendee.displayName || attendee.name || emailPrefix(attendee.email);
    const cleaned = sanitizeInlineText(name);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    attendees.push(cleaned);
  }
  return attendees;
}

function emailPrefix(value) {
  if (typeof value !== 'string' || !value.includes('@')) return undefined;
  return value.split('@')[0].replace(/[._-]+/g, ' ').trim();
}

function compareEvents(a, b) {
  if (a.day !== b.day) return a.day.localeCompare(b.day);
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.startSort !== b.startSort) return a.startSort.localeCompare(b.startSort);
  return a.title.localeCompare(b.title, 'fr');
}

function groupEventsByDay(events) {
  const grouped = new Map();
  for (const event of events) {
    if (!grouped.has(event.day)) grouped.set(event.day, []);
    grouped.get(event.day).push(event);
  }
  return grouped;
}

function sanitizeInlineText(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

function redactServiceIdForMarkdown(serviceId) {
  const cleaned = stringOrUndefined(serviceId);
  if (!cleaned) return '[redacted]';
  const separatorIndex = cleaned.indexOf(':');
  if (separatorIndex === -1) return '[redacted]';
  return `${cleaned.slice(0, separatorIndex)}:[redacted]`;
}

function renderDayMarkdown(day, events, meta) {
  const redactedServiceId = redactServiceIdForMarkdown(meta.serviceId);
  const lines = [
    '---',
    'type: source',
    `title: Google Calendar ${day}`,
    `date: ${day}`,
    'source: clawvisor-google-calendar',
    `collected_at: ${meta.collectedAt}`,
    `event_count: ${events.length}`,
    `service: ${redactedServiceId}`,
    '---',
    '',
    `# Google Calendar — ${day}`,
    '',
    `- Source: ClawVisor Google Calendar (${redactedServiceId})`,
    `- Collected: ${meta.collectedAt}`,
    `- Requested range: ${meta.range.fromDate} → ${meta.range.toDateInclusive}`,
    '',
    '## Calendar',
    '',
  ];

  for (const event of events) {
    const timeLabel = event.allDay ? 'All day' : `${event.startDisplay}${event.endDisplay ? `-${event.endDisplay}` : ''}`;
    const suffix = [];
    if (event.calendarLabel) suffix.push(`(${sanitizeInlineText(event.calendarLabel)})`);
    if (event.location) suffix.push(`📍 ${sanitizeInlineText(event.location)}`);
    lines.push(`- ${timeLabel} **${sanitizeInlineText(event.title)}**${suffix.length ? ` ${suffix.join(' ')}` : ''}`);
    if (event.attendees.length) lines.push(`  - Attendees: ${event.attendees.join(', ')}`);
    if (event.status && event.status !== 'confirmed') lines.push(`  - Status: ${event.status}`);
    lines.push(`  - Event ID: ${event.id}`);
    lines.push(`  - [Source: ClawVisor Google Calendar, collected ${meta.collectedAt}]`);
  }

  lines.push('');
  return lines.join('\n');
}

function buildOutputPath(outputRoot, day) {
  const year = day.slice(0, 4);
  return path.join(outputRoot, year, `${day}.md`);
}

function writeDayFiles(eventsByDay, { outputRoot, collectedAt, serviceId, range }) {
  const writtenFiles = [];
  for (const [day, events] of eventsByDay.entries()) {
    const filePath = buildOutputPath(outputRoot, day);
    const markdown = renderDayMarkdown(day, events, { collectedAt, serviceId, range });
    writeFileAtomic(filePath, `${markdown}\n`, 0o644);
    writtenFiles.push(filePath);
  }
  return writtenFiles.sort();
}

function buildStdoutSummary({ eventsByDay, write, outputRoot, taskId, taskStatus }) {
  const dayLines = [...eventsByDay.entries()].map(([day, events]) => {
    const ids = events.map((event) => event.id).join(', ');
    return `- ${day}: ${events.length} event(s), ids: ${ids}`;
  });
  const lines = [
    `Mode: ${write ? 'write' : 'dry-run'}`,
    `Task: ${taskId ?? 'n/a'}${taskStatus ? ` (${taskStatus})` : ''}`,
    `Days: ${eventsByDay.size}`,
    `Events: ${[...eventsByDay.values()].reduce((sum, events) => sum + events.length, 0)}`,
    ...dayLines,
  ];
  if (!write) {
    lines.push(`No files written. Use --write to save markdown under ${outputRoot}.`);
  }
  return lines.join('\n');
}

function updateState(stateFile, nextState) {
  writeJsonAtomic(stateFile, nextState, 0o600);
}

function buildState({ taskId, serviceId, range, events, writtenFiles, mode, approvalBlocked }) {
  return {
    updated_at: new Date().toISOString(),
    mode,
    approval_blocked: approvalBlocked,
    task_id: taskId ?? null,
    service_id: serviceId ?? null,
    range: {
      from: range.fromDate,
      to: range.toDateInclusive,
    },
    event_count: events.length,
    written_files: writtenFiles,
  };
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatTaskStatusMessage(task) {
  const status = task?.status ?? task?.task_status ?? task?.task?.status ?? 'unknown';
  const taskId = task?.id ?? task?.task_id ?? task?.task?.id ?? 'unknown';
  return `Task ${taskId} is ${status}. Approve it in ClawVisor, then rerun with --task-id ${taskId}.`;
}

function detectApprovalBlock(error) {
  const payload = error?.payload;
  const message = typeof payload?.message === 'string' ? payload.message : '';
  const code = typeof payload?.code === 'string' ? payload.code : '';
  return code === 'MISSING_SESSION_ID'
    || /pending_approval/i.test(message)
    || /approval/i.test(message)
    || /MISSING_SESSION_ID/i.test(message);
}

function approvalBlockMessage(error, fallbackTaskId) {
  const payload = error?.payload ?? {};
  if (payload.code === 'MISSING_SESSION_ID') {
    return 'The task appears to be standing and requires --session-id for gateway requests.';
  }
  if (payload.message) return String(payload.message);
  if (fallbackTaskId) return `Approval required before task ${fallbackTaskId} can be used.`;
  return 'Approval required before this ClawVisor request can proceed.';
}

async function main(rawArgv = process.argv.slice(2)) {
  const args = parseArgs(rawArgv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const range = buildRequestedWindow(args.from, args.to);
  const collectedAt = new Date().toISOString();
  const smokeDefaults = loadSmokeDefaults(args.smokeStateFile);
  const serviceId = args.serviceId ?? smokeDefaults.serviceId;

  let taskId = args.taskId ?? smokeDefaults.taskId;
  let taskStatus = null;
  let events = [];
  let approvalBlocked = false;
  let writtenFiles = [];

  if (args.mock) {
    const fixturePath = expandHome(args.mockFile ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-response.json'));
    const payload = safeReadJson(fixturePath);
    if (!payload) throw new Error(`Mock fixture not found: ${fixturePath}`);
    events = normalizeEvents(payload).slice(0, args.maxResults);
  } else {
    const baseUrl = process.env.CLAWVISOR_URL;
    const token = process.env.CLAWVISOR_AGENT_TOKEN;
    if (!baseUrl || !token) {
      throw new Error('Missing CLAWVISOR_URL or CLAWVISOR_AGENT_TOKEN in env. Run via op run --env-file "$HOME/.gbrain/gbrain-op.env" -- ...');
    }
    if (!serviceId) {
      throw new Error('Missing service id. Pass --service google.calendar:<account> or run the smoke test first so ~/.gbrain/integrations/clawvisor/smoke-state.json exists.');
    }

    if (args.createTask) {
      const created = await createShortTask({ baseUrl, token, serviceId, range, maxResults: args.maxResults });
      taskId = created.id ?? created.task_id ?? created.task?.id ?? taskId;
      taskStatus = created.status ?? created.task_status ?? created.task?.status ?? null;
      if (taskStatus && taskStatus !== 'active') {
        approvalBlocked = true;
        updateState(args.stateFile, buildState({ taskId, serviceId, range, events: [], writtenFiles: [], mode: args.write ? 'write' : 'dry-run', approvalBlocked }));
        console.log(formatTaskStatusMessage({ id: taskId, status: taskStatus }));
        process.exitCode = APPROVAL_NEEDED_EXIT_CODE;
        return;
      }
    }

    if (!taskId) {
      throw new Error('No task id available. Use --create-task or pass --task-id <id>.');
    }

    const task = await getTaskStatus({ baseUrl, token, taskId });
    taskStatus = task.status ?? task.task_status ?? task.task?.status ?? taskStatus;
    if (taskStatus && taskStatus !== 'active') {
      approvalBlocked = true;
      updateState(args.stateFile, buildState({ taskId, serviceId, range, events: [], writtenFiles: [], mode: args.write ? 'write' : 'dry-run', approvalBlocked }));
      console.log(formatTaskStatusMessage({ id: taskId, status: taskStatus }));
      process.exitCode = APPROVAL_NEEDED_EXIT_CODE;
      return;
    }

    try {
      const payload = await requestEvents({
        baseUrl,
        token,
        taskId,
        serviceId,
        range,
        maxResults: args.maxResults,
        sessionId: args.sessionId,
      });
      events = normalizeEvents(payload).slice(0, args.maxResults);
    } catch (error) {
      if (detectApprovalBlock(error)) {
        approvalBlocked = true;
        updateState(args.stateFile, buildState({ taskId, serviceId, range, events: [], writtenFiles: [], mode: args.write ? 'write' : 'dry-run', approvalBlocked }));
        console.log(approvalBlockMessage(error, taskId));
        process.exitCode = APPROVAL_NEEDED_EXIT_CODE;
        return;
      }
      throw error;
    }
  }

  const eventsByDay = groupEventsByDay(events);
  if (args.write && events.length > 0) {
    writtenFiles = writeDayFiles(eventsByDay, {
      outputRoot: args.outputRoot,
      collectedAt,
      serviceId: serviceId ?? 'mock.google.calendar',
      range,
    });
  }

  updateState(args.stateFile, buildState({
    taskId,
    serviceId: serviceId ?? 'mock.google.calendar',
    range,
    events,
    writtenFiles,
    mode: args.write ? 'write' : 'dry-run',
    approvalBlocked,
  }));

  console.log(buildStdoutSummary({
    eventsByDay,
    write: args.write,
    outputRoot: args.outputRoot,
    taskId,
    taskStatus,
  }));

  if (args.write && writtenFiles.length > 0) {
    for (const filePath of writtenFiles) {
      console.log(`Wrote: ${filePath}`);
    }
  }
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryFile && currentFile === entryFile) {
  main().catch((error) => {
    const message = error?.message ?? String(error);
    console.error(`calendar-to-brain: ${message}`);
    process.exitCode = 1;
  });
}

export {
  APPROVAL_NEEDED_EXIT_CODE,
  buildRequestedWindow,
  buildStdoutSummary,
  defaultShortRange,
  groupEventsByDay,
  normalizeEvent,
  normalizeEvents,
  parseArgs,
  renderDayMarkdown,
};
