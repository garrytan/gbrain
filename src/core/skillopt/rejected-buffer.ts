/**
 * SkillOpt rejected-edit buffer.
 *
 * Persists rejected edits across runs so the optimizer doesn't propose
 * the same losing edit twice. Bounded LRU (cap=100) prevents unbounded
 * growth on long-lived skills.
 *
 * Key: SHA-256 (8 hex) of canonical-JSON({skill_text_at_rejection, edits}).
 * The skill_text part makes the key STATE-AWARE: an edit rejected against
 * version A of the skill is allowed to be re-proposed against version B
 * (the optimizer might find it works differently in the new state).
 *
 * File format: JSON object `{schema: 1, entries: [...]}` at
 * `skills/<name>/skillopt/rejected.json`.
 *
 * Atomic writes via .tmp + rename (mirrors gbrain's atomic-write convention).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from './apply-edits.ts';
import type { EditOp } from './types.ts';

/** Bounded LRU cap. Older entries garbage-collect when this many accumulate. */
export const REJECTED_BUFFER_CAP = 100;

export interface RejectedEntry {
  key: string;
  /** SHA-256-prefix-8 of the skill text the edits were proposed against. */
  skill_sha8: string;
  edits: EditOp[];
  reason: string;
  /** ISO-8601 timestamp; used for LRU ordering. */
  ts: string;
}

interface RejectedFile {
  schema: 1;
  entries: RejectedEntry[];
}

/** Compute the file path for a skill's rejected buffer. */
export function rejectedFilePath(skillsDir: string, skillName: string): string {
  return path.join(skillsDir, skillName, 'skillopt', 'rejected.json');
}

/**
 * Compute the dedup key for (skill_text, edits). Two identical edit
 * proposals against the SAME skill text produce the SAME key.
 */
export function rejectedKey(skillText: string, edits: EditOp[]): string {
  const canonical = JSON.stringify({
    skill_sha8: sha8(skillText),
    edits: edits.map(canonicalEdit),
  });
  return sha8(canonical);
}

function canonicalEdit(e: EditOp): unknown {
  // Stable property ordering so semantically-identical edits hash identically.
  switch (e.op) {
    case 'add': return { op: 'add', anchor: e.anchor, content: e.content };
    case 'replace': return { op: 'replace', target: e.target, replacement: e.replacement };
    case 'delete': return { op: 'delete', target: e.target };
  }
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/**
 * Load the rejected buffer. Returns empty array when file is missing
 * (fresh skill) or corrupt (log + start fresh — same posture as
 * import-checkpoint.ts).
 */
export function loadRejectedBuffer(skillsDir: string, skillName: string): RejectedEntry[] {
  const p = rejectedFilePath(skillsDir, skillName);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const obj = parsed as Record<string, unknown>;
    if (obj.schema !== 1 || !Array.isArray(obj.entries)) return [];
    // Type-narrow without full validation — entries from our own writes
    // are trusted; corrupted entries simply replay as rejection attempts
    // when their key fails to match.
    return obj.entries as RejectedEntry[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[skillopt] rejected.json unreadable for ${skillName} (${msg}); starting fresh\n`);
    return [];
  }
}

/**
 * Append rejected entries to the buffer, bounded by LRU cap. Atomic write.
 *
 * Dedup: if an entry with the same key already exists, it's promoted to
 * the head (LRU touch) rather than duplicated.
 */
export function saveRejectedBuffer(
  skillsDir: string,
  skillName: string,
  newEntries: RejectedEntry[],
): void {
  const p = rejectedFilePath(skillsDir, skillName);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const existing = loadRejectedBuffer(skillsDir, skillName);
  const byKey = new Map<string, RejectedEntry>();
  // Existing entries first (so newer entries with same key override).
  for (const e of existing) byKey.set(e.key, e);
  for (const e of newEntries) byKey.set(e.key, e);

  const merged = [...byKey.values()].sort((a, b) => {
    // Newest first by ts so LRU truncation keeps fresh entries.
    return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0;
  });
  const bounded = merged.slice(0, REJECTED_BUFFER_CAP);

  const payload: RejectedFile = { schema: 1, entries: bounded };
  atomicWrite(p, JSON.stringify(payload, null, 2) + '\n');
}

/** Is the proposed edit set already in the rejected buffer? */
export function isRejected(
  buffer: readonly RejectedEntry[],
  skillText: string,
  edits: EditOp[],
): boolean {
  const key = rejectedKey(skillText, edits);
  return buffer.some((e) => e.key === key);
}

/** Build a fresh rejected entry from edits + reason at the current time. */
export function makeRejectedEntry(skillText: string, edits: EditOp[], reason: string): RejectedEntry {
  return {
    key: rejectedKey(skillText, edits),
    skill_sha8: sha8(skillText),
    edits,
    reason,
    ts: new Date().toISOString(),
  };
}
