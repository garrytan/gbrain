/**
 * detect.ts — format detection + harness discovery roots for the transcripts
 * import lane (cathedral-4).
 *
 * The ADAPTERS registry is the one place import formats are enumerated;
 * detection order matters (cheap magic bytes first, then first-line JSON
 * shapes, then monolithic-JSON key sniffs). An explicit format flag from the
 * CLI always wins over detection.
 *
 * Trust split: EXPLICIT paths are trusted local-CLI input (extension +
 * byte-cap + lstat checks only). DISCOVERY mode is confined to the static
 * harness roots below — consumer exports have no canonical root and are
 * explicit-path only. `roots` is an injectable parameter so tests never
 * touch the real home directory.
 */

import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptAdapter, TranscriptFormat } from './types.ts';
import { claudeCodeAdapter } from './claude-code.ts';
import { codexAdapter } from './codex.ts';
import { openclawAdapter } from './openclaw.ts';
import { hermesAdapter } from './hermes.ts';
import { chatgptExportAdapter } from './chatgpt-export.ts';
import { claudeExportAdapter } from './claude-export.ts';

// ── Harness discovery roots (discovery mode only) ───────────────────────────

export interface HarnessRoot {
  format: TranscriptFormat;
  /** Directory scanned recursively for session files (or the single store file). */
  root: string;
  /** Glob-ish suffix filter applied during discovery. */
  extension: '.jsonl' | '.db';
}

/** The static discovery surface. Injectable (`overrides`) for tests. */
export function harnessRoots(overrides?: HarnessRoot[]): HarnessRoot[] {
  if (overrides) return overrides;
  const home = homedir();
  return [
    { format: 'claude-code', root: join(home, '.claude', 'projects'), extension: '.jsonl' },
    { format: 'codex', root: join(home, '.codex', 'sessions'), extension: '.jsonl' },
    { format: 'openclaw', root: join(home, '.openclaw', 'agents'), extension: '.jsonl' },
    // Hermes keeps every session in one SQLite store (hermes-agent
    // DEFAULT_DB_PATH = <hermes home>/state.db; HERMES_HOME honored).
    {
      format: 'hermes',
      root: process.env.HERMES_HOME ?? join(home, '.hermes'),
      extension: '.db',
    },
  ];
}

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Detection order: SQLite magic is unambiguous; JSONL first-line shapes are
 * mutually exclusive (session_meta / session-header / claude keys); the two
 * monolithic-JSON exports are sniffed by their distinguishing keys. Every
 * adapter registers here unconditionally; any format-level scoping belongs
 * to callers.
 *
 */
export function transcriptAdapters(): TranscriptAdapter[] {
  return [
    hermesAdapter,
    openclawAdapter,
    codexAdapter,
    claudeCodeAdapter,
    claudeExportAdapter,
    chatgptExportAdapter,
  ];
}

const SAMPLE_BYTES = 64 * 1024;

/** Read the file head for detection without loading the whole file. */
export function readSample(path: string, bytes = SAMPLE_BYTES): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export type DetectResult =
  | { ok: true; adapter: TranscriptAdapter }
  | { ok: false; reason: 'unreadable' | 'symlink' | 'unknown_format'; tried: TranscriptFormat[] };

/**
 * Detect the adapter for a path. `explicitFormat` (from the CLI flag) wins
 * without sniffing; unknown formats report every detector tried so the error
 * is actionable.
 */
export function detectAdapter(
  path: string,
  opts: { explicitFormat?: TranscriptFormat; adapters?: TranscriptAdapter[] } = {},
): DetectResult {
  const adapters = opts.adapters ?? transcriptAdapters();
  if (opts.explicitFormat) {
    const adapter = adapters.find((a) => a.format === opts.explicitFormat);
    if (adapter) return { ok: true, adapter };
    return { ok: false, reason: 'unknown_format', tried: adapters.map((a) => a.format) };
  }
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink', tried: [] };
  } catch {
    return { ok: false, reason: 'unreadable', tried: [] };
  }
  let sample: Buffer;
  try {
    sample = readSample(path);
  } catch {
    return { ok: false, reason: 'unreadable', tried: [] };
  }
  for (const adapter of adapters) {
    if (adapter.detect(path, sample)) return { ok: true, adapter };
  }
  return { ok: false, reason: 'unknown_format', tried: adapters.map((a) => a.format) };
}
