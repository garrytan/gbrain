#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

type HookEvent = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  transcript?: unknown;
  messages?: unknown;
  [key: string]: unknown;
};

type SessionState = {
  sessionId: string;
  rawPath: string;
  draftPath: string;
  captureSegmentCount: number;
  createdAt: string;
};

type NormalizedEvent = {
  content: string;
  fallbackUsed: boolean;
};

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function envPath(name: string, fallback: string): string {
  return resolve(expandHome(process.env[name] || fallback));
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function safeId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
}

function yamlQuote(input: string): string {
  return JSON.stringify(input);
}

function redact(input: string): string {
  return input
    .replace(/\/Users\/[^\s"'`<>)]*/g, '[redacted-local-path]')
    .replace(/\/home\/[^\s"'`<>)]*/g, '[redacted-local-path]')
    .replace(/\b[A-Za-z0-9_]*(?:DATABASE_URL|DB_URL)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '[redacted-database-url]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`<>]+/gi, '[redacted-database-url]')
    .replace(/\b[A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE_KEY)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '[redacted-secret]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]');
}

function ensurePrivateDir(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to use symlinked directory: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateFile(path: string, content: string): void {
  ensurePrivateDir(dirname(path));
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write symlinked file: ${path}`);
    }
    chmodSync(path, 0o600);
  }
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function messageToText(item: unknown, index: number): string {
  if (typeof item === 'string') return `Entry ${index + 1}: ${item}`;
  if (!item || typeof item !== 'object') return `Entry ${index + 1}: ${JSON.stringify(item)}`;
  const record = item as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role.toUpperCase() : 'ENTRY';
  const content = record.content ?? record.text ?? record.message ?? '';
  return `${role} ${index + 1}: ${typeof content === 'string' ? content : JSON.stringify(content)}`;
}

function normalizeUnknownTranscript(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(messageToText);
  if (typeof value === 'string') return value.split(/\r?\n/).filter(Boolean);
  if (value && typeof value === 'object') return [JSON.stringify(value, null, 2)];
  return [];
}

function summarizeFallbackEvent(event: HookEvent): string {
  const eventName = typeof event.hook_event_name === 'string' ? event.hook_event_name : 'unknown';
  const keys = Object.keys(event)
    .filter((key) => !['cwd', 'transcript_path', 'git_remote', 'repo_name', 'mentioned_projects'].includes(key))
    .sort();
  return [
    `HOOK EVENT: ${eventName}`,
    `Available safe keys: ${keys.join(', ') || 'none'}`,
    'No prompt, transcript, or messages payload was present in this hook event.',
  ].join('\n');
}

function normalizeEvent(event: HookEvent): NormalizedEvent {
  const lines: string[] = [];
  if (typeof event.prompt === 'string' && event.prompt.trim()) {
    lines.push(`USER PROMPT: ${event.prompt.trim()}`);
  }
  lines.push(...normalizeUnknownTranscript(event.transcript));
  lines.push(...normalizeUnknownTranscript(event.messages));
  if (lines.length > 0) {
    return { content: lines.join('\n'), fallbackUsed: false };
  }
  return { content: summarizeFallbackEvent(event), fallbackUsed: true };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sessionStatePath(rawDir: string, sessionId: string): string {
  return join(rawDir, '.state', `${safeId(sessionId)}.json`);
}

function buildPaths(rawDir: string, brainDir: string, sessionId: string, now: Date): SessionState {
  const createdAt = now.toISOString();
  const day = createdAt.slice(0, 10);
  const suffix = sha(sessionId).slice(0, 16);
  return {
    sessionId,
    rawPath: join(rawDir, day, `${day}-${suffix}.raw.md`),
    draftPath: join(brainDir, 'inbox', 'auto', day, `${day}-${suffix}.md`),
    captureSegmentCount: 0,
    createdAt,
  };
}

function frontmatter(state: SessionState, eventName: string, normalizedHash: string): string {
  return [
    '---',
    'type: source-note',
    'title: "Agent session review draft"',
    `created_at: ${yamlQuote(state.createdAt)}`,
    `hook_event: ${yamlQuote(eventName)}`,
    `session_id: ${yamlQuote(state.sessionId)}`,
    `capture_segment_count: ${state.captureSegmentCount}`,
    `content_hash: ${yamlQuote(normalizedHash)}`,
    `latest_content_hash: ${yamlQuote(normalizedHash)}`,
    `latest_hook_event: ${yamlQuote(eventName)}`,
    'review_status: "pending-dreams-review"',
    '---',
    '',
  ].join('\n');
}

function upsertFrontmatterField(content: string, key: string, value: string): string {
  const re = new RegExp(`\\n${key}: .*\\n`);
  if (re.test(content)) {
    return content.replace(re, `\n${key}: ${value}\n`);
  }
  return content.replace(/^---\n/, `---\n${key}: ${value}\n`);
}

function updateDraftFrontmatter(content: string, segmentCount: number, eventName: string, normalizedHash: string): string {
  let next = upsertFrontmatterField(content, 'capture_segment_count', String(segmentCount));
  next = upsertFrontmatterField(next, 'latest_content_hash', yamlQuote(normalizedHash));
  next = upsertFrontmatterField(next, 'latest_hook_event', yamlQuote(eventName));
  return next;
}

function segmentMarkdown(segment: number, event: HookEvent, normalized: NormalizedEvent, now: string, includeCwd: boolean): string {
  const eventName = event.hook_event_name || 'unknown';
  const cwd = includeCwd && typeof event.cwd === 'string' ? redact(event.cwd) : '';
  return [
    `## Capture segment ${segment}`,
    '',
    `- captured_at: ${now}`,
    `- hook_event: ${yamlQuote(eventName)}`,
    cwd ? `- cwd: ${yamlQuote(cwd)}` : null,
    normalized.fallbackUsed ? '- payload_status: "missing content payload"' : null,
    '',
    '### Normalized transcript',
    '',
    '```text',
    redact(normalized.content),
    '```',
    '',
  ].filter((line): line is string => line !== null).join('\n');
}

function appendCapture(event: HookEvent): { rawPath: string; draftPath: string; segment: number; dryRun: boolean } {
  const brainDir = envPath('GBRAIN_CAPTURE_BRAIN_DIR', '~/brain');
  const rawDir = envPath('GBRAIN_CAPTURE_RAW_DIR', '~/.gbrain/inbox/auto');
  const minChars = Number.parseInt(process.env.GBRAIN_CAPTURE_MIN_CHARS || '200', 10);
  const dryRun = process.env.GBRAIN_CAPTURE_DRY_RUN === '1';
  const includeCwd = process.env.GBRAIN_CAPTURE_INCLUDE_CWD === '1';
  const normalized = normalizeEvent(event);
  if (normalized.content.trim().length < minChars) {
    return { rawPath: '', draftPath: '', segment: 0, dryRun };
  }

  const sessionId = event.session_id || `anonymous-${sha(normalized.content).slice(0, 16)}`;
  const statePath = sessionStatePath(rawDir, sessionId);
  const now = new Date();
  const state = readJson<SessionState>(statePath) ?? buildPaths(rawDir, brainDir, sessionId, now);
  state.captureSegmentCount += 1;
  const segment = state.captureSegmentCount;
  const normalizedHash = sha(normalized.content);
  const eventName = event.hook_event_name || 'unknown';

  if (dryRun) {
    return { rawPath: state.rawPath, draftPath: state.draftPath, segment, dryRun };
  }

  ensurePrivateDir(dirname(state.rawPath));
  ensurePrivateDir(dirname(state.draftPath));

  const rawSegment = [
    `## Capture segment ${segment}`,
    '',
    `captured_at: ${now.toISOString()}`,
    `hook_event: ${eventName}`,
    `session_id: ${sessionId}`,
    '',
    '```json',
    JSON.stringify(event, null, 2),
    '```',
    '',
  ].join('\n');
  const oldRaw = existsSync(state.rawPath) ? readFileSync(state.rawPath, 'utf8') : '';
  writePrivateFile(state.rawPath, `${oldRaw}${oldRaw ? '\n' : ''}${rawSegment}`);

  const segmentText = segmentMarkdown(segment, event, normalized, now.toISOString(), includeCwd);
  if (existsSync(state.draftPath)) {
    const existing = updateDraftFrontmatter(readFileSync(state.draftPath, 'utf8'), segment, eventName, normalizedHash);
    writePrivateFile(state.draftPath, `${existing.trimEnd()}\n\n${segmentText}\n`);
  } else {
    const body = [
      frontmatter({ ...state, captureSegmentCount: segment }, eventName, normalizedHash),
      '# Agent session review draft',
      '',
      'This is a redacted review draft created from raw local evidence.',
      'Review it before promoting anything into curated namespaces.',
      '',
      segmentText,
    ].join('\n');
    writePrivateFile(state.draftPath, body.endsWith('\n') ? body : `${body}\n`);
  }

  writeJson(statePath, state);
  return { rawPath: state.rawPath, draftPath: state.draftPath, segment, dryRun };
}

function printConfig(): void {
  const command = `bun ${process.argv[1] || 'recipes/stop-memory-capture/stop-memory-capture.ts'}`;
  const hookSpec = [{ hooks: [{ type: 'command', command }] }];
  console.log(JSON.stringify({
    hooks: {
      UserPromptSubmit: hookSpec,
      Stop: hookSpec,
      SubagentStop: hookSpec,
    },
  }, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(`Usage: ${basename(process.argv[1] || 'stop-memory-capture.ts')} [--print-config]\n\nReads one hook JSON object from stdin.`);
    return;
  }
  if (process.argv.includes('--print-config')) {
    printConfig();
    return;
  }

  const input = await Bun.stdin.text();
  const event = input.trim() ? JSON.parse(input) as HookEvent : {};
  const result = appendCapture(event);
  if (result.segment === 0) return;
  if (result.dryRun) {
    console.error(`[gbrain-stop-capture] dry-run raw=${result.rawPath} draft=${result.draftPath}`);
  } else {
    console.error(`[gbrain-stop-capture] wrote ${result.draftPath}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[gbrain-stop-capture] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
