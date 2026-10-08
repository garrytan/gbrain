/**
 * pi.ts — pi (pi-coding-agent) session-file adapter for `gbrain transcripts
 * ingest`.
 *
 * pi writes one JSONL file per session: a header `{type:"session",version:3,
 * id,cwd,timestamp}`, then `{type,id,parentId,timestamp,...}` entries that
 * form a TREE (`/tree` branching rewinds to an earlier entry and continues;
 * the abandoned branch stays in the file). The import keeps the ACTIVE branch
 * only — the path from the newest entry back to the root, the same selection
 * the hook lane makes (`activeBranch` in pi-hook-lane.ts) — because an
 * abandoned branch is a draft the user rewound away from; interleaving it
 * with the branch they kept would archive a conversation that never
 * happened.
 *
 * Detection: another agent built on pi's session manager writes the same
 * header byte for byte, so the sample cannot tell the two apart. What does is
 * where the file lives: a session-shaped file inside pi's own store
 * (`piSessionsDir()`) is pi's. Elsewhere, `--format pi` is the explicit
 * route. This adapter is registered ahead of that agent's so files in pi's
 * store are never claimed by it.
 *
 * Kept: user and assistant message text (text blocks only; thinking,
 * toolCall arguments and images are dropped), with the entry's own ISO
 * timestamp. Dropped: tool results, bash executions, custom_message entries
 * (including the `gbrain-context` blocks gbrain itself injected — importing
 * those would feed the brain its own retrieval output), branch and
 * compaction summaries, model/thinking changes.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { PI_SPEC_ID, piSessionsDir, type HostSpecTarget } from '../bootstrap/host-specs.ts';
import { activeBranch, textOf } from './pi-hook-lane.ts';
import type { FileDiagnostics, ParsedSession, ParseSessionsOpts, TranscriptAdapter, TranscriptMessage } from './types.ts';
import { TRANSCRIPT_JSONL_HARD_CAP, utcTimestamp } from './types.ts';

export const PI_IMPORT_SPEC_TARGET: HostSpecTarget = {
  id: PI_SPEC_ID,
  status: 'verified',
  verifiedAt: '2026-10-07',
  references: [
    'local ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl (pi 1.0.4)',
    'pi-coding-agent dist/core/session-manager.js (entry shapes, tree via parentId)',
    'test/fixtures/transcripts/pi-session.jsonl',
  ],
  note:
    "Header {type:'session', version:3, id, cwd, timestamp}. Entries carry id + " +
    "parentId (a tree); the import keeps the active branch. Turns: {type:'message', " +
    "timestamp, message:{role:'user'|'assistant', content}}; content is a string or " +
    "(text|thinking|toolCall|image)[] — text blocks only. custom_message " +
    "(gbrain-context) and toolResult/bashExecution rows are not imported.",
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** True when `path` sits inside pi's session store (symlinks resolved on both sides). */
export function isInPiSessionStore(path: string, root: string = piSessionsDir()): boolean {
  const r = real(root);
  const p = real(path);
  return p.startsWith(r.endsWith(sep) ? r : r + sep);
}

function isSessionHeader(sample: Buffer): boolean {
  const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
  if (!firstLine) return false;
  try {
    const obj = JSON.parse(firstLine) as unknown;
    return isRec(obj) && obj.type === 'session' && typeof obj.id === 'string';
  } catch {
    return false;
  }
}

export const piAdapter: TranscriptAdapter = {
  format: 'pi',
  specTarget: PI_IMPORT_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    return path.endsWith('.jsonl') && isSessionHeader(sample) && isInPiSessionStore(path);
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP;
    const size = statSync(path).size;
    if (size > cap) throw new Error(`pi session too large for import: ${size} bytes (cap ${cap})`);
    const raw = readFileSync(path, 'utf8');

    const entries: Rec[] = [];
    let skippedLines = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as unknown;
        if (isRec(e)) entries.push(e);
      } catch {
        skippedLines++;
      }
    }
    const { kept } = activeBranch(entries);

    let sessionId = '';
    let cwd: string | undefined;
    let startedAt = '';
    let model: string | undefined;
    const messages: TranscriptMessage[] = [];
    for (const e of kept) {
      if (e.type === 'session') {
        // First header wins (a fork's file can embed its parent's later).
        if (!sessionId && typeof e.id === 'string') sessionId = e.id;
        if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
        if (!startedAt && typeof e.timestamp === 'string') startedAt = utcTimestamp(e.timestamp);
        continue;
      }
      if (e.type !== 'message' || !isRec(e.message)) continue;
      const m = e.message;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = textOf(m.content).trim();
      if (!text) continue;
      if (m.role === 'assistant' && !model && typeof m.model === 'string') model = m.model;
      messages.push({ role: m.role, timestamp: utcTimestamp(e.timestamp), text });
    }

    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      const sid = sessionId || basename(path, '.jsonl');
      yield {
        meta: {
          harness: 'pi',
          sessionId: sid,
          cwd,
          model,
          startedAt: startedAt || messages[0]!.timestamp || undefined,
          raw: { session_id: sid, cwd: cwd ?? null, source_path: path },
        },
        messages,
      };
    }
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    const hasUser = messages.some((m) => m.role === 'user');
    return {
      bytesRead: size,
      skippedLines,
      truncated: false,
      sessions,
      zeroSessionsReason: sessions === 0 ? 'no text-bearing message lines on the active branch' : undefined,
      ...(hasAssistant && !hasUser ? { userTurnsMissing: true } : {}),
    };
  },
};
