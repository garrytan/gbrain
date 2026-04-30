/**
 * Friction reporter — JSONL-backed signal capture for the claw-test feedback loop.
 *
 * The friction CLI (`gbrain friction log/render/list/summary`) writes here.
 * The claw-test harness reads here. The agent calls `gbrain friction log`
 * directly when it hits something confusing, missing, or wrong.
 *
 * Storage shape: append-only JSONL files under `$GBRAIN_HOME/friction/`.
 *   - `<run-id>.jsonl` for each harness run (run-id from $GBRAIN_FRICTION_RUN_ID)
 *   - `standalone.jsonl` for entries logged outside a harness run
 *
 * Schema is a flat extension of StructuredAgentError fields (per D20). Render
 * reads one level. Readers tolerate malformed lines (skip + warn) so partial
 * runs don't break later analysis.
 *
 *  ┌──────────┐  appendFileSync     ┌─────────────────────────┐
 *  │ writer() │ ──────────────────▶ │ <runId>.jsonl (one     │
 *  │          │  (atomic if line    │  entry per line)       │
 *  └──────────┘   ≤ PIPE_BUF/4KB)   └─────────────────────────┘
 *                                              │
 *                                              ▼
 *                                       reader() / render()
 *                                       skip malformed + warn
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { gbrainPath } from './config.ts';
import { VERSION } from '../version.ts';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type FrictionKind = 'friction' | 'delight' | 'phase-marker' | 'interrupted';
export type FrictionSeverity = 'confused' | 'error' | 'blocker' | 'nit';
export type FrictionSource = 'claw' | 'harness';
export type PhaseMarker = 'start' | 'end';

/** One JSONL entry. Flat extension of StructuredAgentError per D20. */
export interface FrictionEntry {
  schema_version: '1';
  ts: string;                      // ISO 8601
  run_id: string;
  phase: string;
  kind: FrictionKind;
  /** Required for kind=friction|delight. Optional for phase-marker (purely informational). */
  severity?: FrictionSeverity;
  message: string;
  hint?: string;
  /** StructuredAgentError envelope fields, flattened. */
  class?: string;
  code?: string;
  docs_url?: string;
  source: FrictionSource;
  cwd: string;
  gbrain_version: string;
  agent?: string;
  /** Byte offset into the run's transcript.jsonl (live mode). */
  transcript_offset?: number;
  /** For phase-marker entries only. */
  marker?: PhaseMarker;
}

export interface FrictionLogInput {
  severity?: FrictionSeverity;
  phase: string;
  message: string;
  hint?: string;
  runId?: string;
  kind?: FrictionKind;
  source?: FrictionSource;
  agent?: string;
  transcriptOffset?: number;
  marker?: PhaseMarker;
  /** When the writer is called from the harness wrapping a child error. */
  errorClass?: string;
  errorCode?: string;
  docsUrl?: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve the directory all friction JSONL files live under. */
export function frictionDir(): string {
  return gbrainPath('friction');
}

/** Resolve the JSONL file path for a given run-id. */
export function frictionFile(runId: string): string {
  return join(frictionDir(), `${sanitizeRunId(runId)}.jsonl`);
}

/** Resolve the active run-id, falling back to 'standalone' (D19). */
export function activeRunId(): string {
  const env = process.env.GBRAIN_FRICTION_RUN_ID?.trim();
  return env && env.length > 0 ? env : 'standalone';
}

/** Sanitize: only [a-zA-Z0-9._-]; reject anything else to keep filenames sane. */
function sanitizeRunId(runId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error(`invalid run-id ${JSON.stringify(runId)} (allowed: [a-zA-Z0-9._-])`);
  }
  return runId;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Maximum message length; truncated to keep each line under PIPE_BUF for atomic appends. */
const MAX_MESSAGE_CHARS = 3500;

/** Append one friction entry to the run's JSONL. */
export function logFriction(input: FrictionLogInput): void {
  const runId = input.runId ?? activeRunId();
  const dir = frictionDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const message = truncate(input.message, MAX_MESSAGE_CHARS);
  const entry: FrictionEntry = {
    schema_version: '1',
    ts: new Date().toISOString(),
    run_id: runId,
    phase: input.phase,
    kind: input.kind ?? 'friction',
    message,
    source: input.source ?? 'claw',
    cwd: process.cwd(),
    gbrain_version: VERSION,
  };
  if (input.severity) entry.severity = input.severity;
  if (input.hint) entry.hint = input.hint;
  if (input.errorClass) entry.class = input.errorClass;
  if (input.errorCode) entry.code = input.errorCode;
  if (input.docsUrl) entry.docs_url = input.docsUrl;
  if (input.agent) entry.agent = input.agent;
  if (input.transcriptOffset !== undefined) entry.transcript_offset = input.transcriptOffset;
  if (input.marker) entry.marker = input.marker;

  const line = JSON.stringify(entry) + '\n';
  appendFileSync(frictionFile(runId), line, 'utf-8');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 14) + '…[truncated]';
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface ReadResult {
  entries: FrictionEntry[];
  /** Count of malformed JSONL lines that were skipped. */
  malformed: number;
}

/** Read all entries from a run's JSONL, skipping malformed lines. */
export function readFriction(runId: string): ReadResult {
  const path = frictionFile(runId);
  if (!existsSync(path)) {
    throw new Error(`run-id "${runId}" not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const entries: FrictionEntry[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // Light shape check: must have ts + kind + phase + message
      if (typeof parsed.ts === 'string' && typeof parsed.kind === 'string' && typeof parsed.phase === 'string' && typeof parsed.message === 'string') {
        entries.push(parsed as FrictionEntry);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

/** List run-ids with summary counts. Returns most-recent-first. */
export interface RunSummary {
  runId: string;
  path: string;
  mtime: Date;
  counts: { friction: number; delight: number; interrupted: boolean; bySeverity: Record<string, number> };
}

export function listRuns(): RunSummary[] {
  const dir = frictionDir();
  if (!existsSync(dir)) return [];
  const out: RunSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const runId = file.slice(0, -'.jsonl'.length);
    const path = join(dir, file);
    const stat = statSync(path);
    let read: ReadResult;
    try {
      read = readFriction(runId);
    } catch {
      continue;
    }
    const counts = { friction: 0, delight: 0, interrupted: false, bySeverity: {} as Record<string, number> };
    for (const e of read.entries) {
      if (e.kind === 'friction') counts.friction++;
      if (e.kind === 'delight') counts.delight++;
      if (e.kind === 'interrupted') counts.interrupted = true;
      if (e.severity) counts.bySeverity[e.severity] = (counts.bySeverity[e.severity] ?? 0) + 1;
    }
    out.push({ runId, path, mtime: stat.mtime, counts });
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface RenderOpts {
  format?: 'md' | 'json';
  redact?: boolean;
  /** When true, transcript_offset values are resolved against this transcript file. */
  transcriptPath?: string;
}

/** Render entries grouped by severity then phase. Returns the rendered string. */
export function renderReport(runId: string, opts: RenderOpts = {}): string {
  const { entries, malformed } = readFriction(runId);
  const format = opts.format ?? 'md';
  const redact = opts.redact ?? (format === 'md');

  const transformed = entries.map(e => redact ? redactEntry(e) : e);

  if (format === 'json') {
    return JSON.stringify({ run_id: runId, malformed, entries: transformed }, null, 2);
  }

  // Markdown grouping: severity (blocker > error > confused > nit > none) → phase
  const sevOrder: (FrictionSeverity | 'none')[] = ['blocker', 'error', 'confused', 'nit', 'none'];
  const bySev = new Map<string, FrictionEntry[]>();
  for (const e of transformed) {
    if (e.kind !== 'friction' && e.kind !== 'delight') continue;
    const k = e.severity ?? 'none';
    if (!bySev.has(k)) bySev.set(k, []);
    bySev.get(k)!.push(e);
  }

  const lines: string[] = [];
  lines.push(`# Friction report — \`${runId}\``);
  lines.push('');
  const totalFriction = entries.filter(e => e.kind === 'friction').length;
  const totalDelight = entries.filter(e => e.kind === 'delight').length;
  lines.push(`**${totalFriction} friction · ${totalDelight} delight**${malformed > 0 ? ` · ${malformed} malformed line(s) skipped` : ''}`);
  lines.push('');

  if (entries.some(e => e.kind === 'interrupted')) {
    lines.push('> ⚠ **Run was interrupted.** Some phases may not have completed.');
    lines.push('');
  }

  for (const sev of sevOrder) {
    const bucket = bySev.get(sev);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`## ${sev === 'none' ? '(no severity)' : sev}`);
    lines.push('');
    // Group by phase within severity
    const byPhase = new Map<string, FrictionEntry[]>();
    for (const e of bucket) {
      if (!byPhase.has(e.phase)) byPhase.set(e.phase, []);
      byPhase.get(e.phase)!.push(e);
    }
    for (const [phase, phaseEntries] of byPhase) {
      lines.push(`### \`${phase}\``);
      lines.push('');
      for (const e of phaseEntries) {
        lines.push(`- ${e.kind === 'delight' ? '✨' : '·'} ${e.message}`);
        if (e.hint) lines.push(`  - hint: ${e.hint}`);
        if (e.code) lines.push(`  - code: \`${e.code}\``);
        if (e.docs_url) lines.push(`  - docs: ${e.docs_url}`);
        if (opts.transcriptPath && e.transcript_offset !== undefined) {
          const snippet = readTranscriptAt(opts.transcriptPath, e.transcript_offset);
          if (snippet) lines.push(`  - transcript: \`${snippet}\``);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** Render a friction + delight summary as two columns. */
export function renderSummary(runId: string, opts: { format?: 'md' | 'json' } = {}): string {
  const { entries } = readFriction(runId);
  const friction = entries.filter(e => e.kind === 'friction');
  const delight = entries.filter(e => e.kind === 'delight');

  if (opts.format === 'json') {
    return JSON.stringify({ run_id: runId, friction, delight }, null, 2);
  }

  const lines: string[] = [];
  lines.push(`# ${runId}`);
  lines.push('');
  const max = Math.max(friction.length, delight.length);
  lines.push(`| friction (${friction.length}) | delight (${delight.length}) |`);
  lines.push('|---|---|');
  for (let i = 0; i < max; i++) {
    const l = friction[i] ? friction[i].message.replace(/\|/g, '\\|') : '';
    const r = delight[i] ? delight[i].message.replace(/\|/g, '\\|') : '';
    lines.push(`| ${l} | ${r} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Replace homedir/cwd segments in user-visible string fields with placeholders. */
export function redactEntry(entry: FrictionEntry): FrictionEntry {
  const home = homedir();
  const cwd = entry.cwd;
  const transform = (s: string | undefined): string | undefined => {
    if (!s) return s;
    let out = s;
    if (cwd && cwd.length > 1) out = out.split(cwd).join('<CWD>');
    if (home && home.length > 1) out = out.split(home).join('<HOME>');
    return out;
  };
  return {
    ...entry,
    message: transform(entry.message) ?? entry.message,
    hint: transform(entry.hint),
    cwd: '<CWD>',
  };
}

// ---------------------------------------------------------------------------
// Transcript snippet resolution (for --transcripts)
// ---------------------------------------------------------------------------

function readTranscriptAt(path: string, offset: number): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    if (offset < 0 || offset >= raw.length) return null;
    // Find the line that contains this offset. Transcript is JSONL.
    const lineStart = raw.lastIndexOf('\n', offset) + 1;
    const lineEnd = raw.indexOf('\n', offset);
    const line = raw.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.bytes_b64 === 'string') {
        const text = Buffer.from(parsed.bytes_b64, 'base64').toString('utf-8');
        // Truncate snippet for readability
        return text.replace(/\n/g, '\\n').slice(0, 200);
      }
    } catch { /* fall through */ }
    return line.slice(0, 200);
  } catch {
    return null;
  }
}
