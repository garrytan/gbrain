/**
 * v0.29 — Recent transcripts: read raw `.txt` transcript files from the dream
 * cycle's corpus directories and return one-line summaries (or full content)
 * filtered by mtime.
 *
 * Reuses the same corpus-dir resolution + dream-output guard as the v0.23
 * synthesize phase. Specifically does NOT depend on or call into the dream
 * cycle — this is a simple read-only filesystem walk for human / CLI / MCP-
 * via-local-CLI consumption.
 *
 * Trust: the calling op (`get_recent_transcripts`) gates on `ctx.remote === false`
 * so MCP/HTTP can't reach this function with attacker-controlled inputs. CLI
 * callers are trusted; the cycle calls `discoverTranscripts` directly.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { isDreamOutput } from './cycle/transcript-discovery.ts';

export interface RecentTranscriptOpts {
  /** Window in days. Default 7. */
  days?: number;
  /** When true (default), return ~300-char summary. When false, full content (capped at 100 KB). */
  summary?: boolean;
  /** Max transcripts (default 50). */
  limit?: number;
}

export interface RecentTranscript {
  /** Filename basename (no directory). */
  path: string;
  /** Inferred date if filename matches `YYYY-MM-DD...`, else null. */
  date: string | null;
  /** Modified time (ISO). */
  mtime: string;
  /** Full file size in bytes (regardless of summary mode). */
  length: number;
  /**
   * When summary=true: first non-empty line + next ~250 chars. Cheap, deterministic.
   * When summary=false: file content capped at 100 KB.
   */
  summary: string;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const FULL_READ_CAP = 100 * 1024;
const SUMMARY_HEAD_CHARS = 250;

/**
 * Walk the corpus directories configured for the dream cycle, filter to `.txt`
 * files modified within `days`, skip dream-generated outputs, and return
 * summaries sorted newest first.
 *
 * Returns [] (not error) when no corpus dir is configured or the dir is empty.
 */
export async function listRecentTranscripts(
  engine: BrainEngine,
  opts: RecentTranscriptOpts = {},
): Promise<RecentTranscript[]> {
  const days = Math.max(0, opts.days ?? 7);
  const summary = opts.summary !== false;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));

  const dirs: string[] = [];
  const sessionDir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  const meetingDir = await engine.getConfig('dream.synthesize.meeting_transcripts_dir');
  if (sessionDir) dirs.push(sessionDir);
  if (meetingDir) dirs.push(meetingDir);
  if (dirs.length === 0) return [];

  const cutoffMs = Date.now() - days * 86400000;

  const candidates: { path: string; mtimeMs: number; size: number }[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Missing dir or permission error → skip silently. The op deliberately
      // doesn't surface filesystem-level diagnostics; users running into this
      // path should `gbrain doctor` to debug.
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.txt')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoffMs) continue;
      candidates.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    }
  }

  // Newest first.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: RecentTranscript[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    let raw: string;
    try {
      raw = readFileSync(c.path, 'utf-8');
    } catch {
      continue;
    }
    // Skip dream-generated outputs (would re-feed the synthesize loop).
    if (isDreamOutput(raw)) continue;

    const name = basename(c.path);
    const dateMatch = DATE_RE.exec(name);
    out.push({
      path: name,
      date: dateMatch ? dateMatch[1] : null,
      mtime: new Date(c.mtimeMs).toISOString(),
      length: c.size,
      summary: summary ? buildSummary(raw) : raw.slice(0, FULL_READ_CAP),
    });
  }
  return out;
}

/**
 * First non-empty line + next ~250 chars (cap on the summary body).
 * Strips leading whitespace; preserves internal newlines truncated by the cap.
 */
function buildSummary(raw: string): string {
  const trimmed = raw.replace(/^[\s​﻿]+/, '');
  // First non-empty line.
  const firstLineEnd = trimmed.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
  const after = firstLineEnd === -1 ? '' : trimmed.slice(firstLineEnd + 1, firstLineEnd + 1 + SUMMARY_HEAD_CHARS);
  if (!after) return firstLine;
  return `${firstLine}\n${after}`.trim();
}
