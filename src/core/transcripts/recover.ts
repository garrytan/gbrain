/**
 * D15 recovery for #5163: Codex sessions imported before the parser read
 * codex >= 0.153's `item_completed` UserMessage turns landed as
 * assistant-only conversation pages. The fixed parser restores them only if
 * something re-reads the rollout, and the `--since last` watermark never
 * will: the session is older than the watermark.
 *
 * planCodexRecovery reads the brain (one source) for codex sessions with no
 * `**User**` turn, parses the retained rollouts (discovery roots, the
 * archived store, or the paths given) with the fixed adapter and sorts each
 * session into recoverable (the rollout now yields user turns), still
 * without user turns, or unrecoverable (the rollout is gone).
 * applyCodexRecovery re-imports exactly the recoverable rollouts through the
 * ordinary ingest path: content-hash dedup rewrites each page in place, a
 * rerun finds nothing to do, the watermark is never touched and no facts are
 * extracted (paid extraction stays an explicit, separate step).
 */

import { existsSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { codexArchivedSessionsDir } from '../bootstrap/host-specs.ts';
import { codexAdapter } from './codex.ts';
import { discoverTranscriptFiles } from './discover.ts';
import { runTranscriptsIngest, type TranscriptsIngestOpts, type TranscriptsIngestResult } from './ingest.ts';

export interface CodexRecoveryEntry {
  session_id: string;
  slug: string;
}

export interface CodexRecoveryPlan {
  source_id: string;
  /** Codex sessions in the source whose pages carry no user turn. */
  userless_sessions: number;
  /** The rollout still exists and the fixed parser finds user turns in it. */
  recoverable: Array<CodexRecoveryEntry & { rollout_path: string; user_turns: number }>;
  /** The rollout exists but still yields no user turn (a genuinely assistant-only session, or a newer format). */
  still_userless: Array<CodexRecoveryEntry & { rollout_path: string }>;
  /** No retained rollout carries this session id: its user turns cannot be restored. */
  unrecoverable: CodexRecoveryEntry[];
  rollouts_scanned: number;
}

/** A codex page whose body has no `**User** (` anchor line (render.ts speaker label; hostile body lines are escaped). */
async function userlessCodexSessions(engine: BrainEngine, sourceId: string): Promise<CodexRecoveryEntry[]> {
  const rows = await engine.executeRaw<{ session_id: string; slug: string | null; has_user: boolean }>(
    `SELECT frontmatter->'transcript_import'->>'session_id' AS session_id,
            MIN(slug) AS slug,
            bool_or(compiled_truth ~ '(^|\\n)\\*\\*User\\*\\* \\(') AS has_user
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND frontmatter->'transcript_import'->>'harness' = 'codex'
      GROUP BY 1`,
    [sourceId],
  );
  return rows
    .filter((r) => r.session_id && !r.has_user)
    .map((r) => ({ session_id: r.session_id, slug: r.slug ?? '' }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Retained codex rollouts: the discovery root plus the archived store. */
function defaultCodexRollouts(): string[] {
  const paths = discoverTranscriptFiles().filter((d) => d.format === 'codex').map((d) => d.path);
  const archived = codexArchivedSessionsDir();
  if (existsSync(archived)) {
    paths.push(...discoverTranscriptFiles([{ format: 'codex', root: archived, extension: '.jsonl' }]).map((d) => d.path));
  }
  return [...new Set(paths)];
}

export async function planCodexRecovery(
  engine: BrainEngine,
  opts: { sourceId: string; rolloutPaths?: string[] },
): Promise<CodexRecoveryPlan> {
  const userless = await userlessCodexSessions(engine, opts.sourceId);
  const plan: CodexRecoveryPlan = {
    source_id: opts.sourceId,
    userless_sessions: userless.length,
    recoverable: [],
    still_userless: [],
    unrecoverable: [],
    rollouts_scanned: 0,
  };
  if (userless.length === 0) return plan;
  const wanted = new Set(userless.map((s) => s.session_id));
  const found = new Map<string, { path: string; userTurns: number }>();
  for (const path of opts.rolloutPaths ?? defaultCodexRollouts()) {
    plan.rollouts_scanned++;
    try {
      for await (const session of codexAdapter.parse(path)) {
        if (!wanted.has(session.meta.sessionId)) continue;
        const userTurns = session.messages.filter((m) => m.role === 'user').length;
        const prev = found.get(session.meta.sessionId);
        if (!prev || userTurns > prev.userTurns) found.set(session.meta.sessionId, { path, userTurns });
      }
    } catch {
      /* an unreadable rollout simply restores nothing */
    }
  }
  for (const s of userless) {
    const hit = found.get(s.session_id);
    if (!hit) plan.unrecoverable.push(s);
    else if (hit.userTurns > 0) plan.recoverable.push({ ...s, rollout_path: hit.path, user_turns: hit.userTurns });
    else plan.still_userless.push({ ...s, rollout_path: hit.path });
  }
  return plan;
}

/** Re-import the recoverable rollouts (no facts, no watermark). Null when there is nothing to restore. */
export async function applyCodexRecovery(
  engine: BrainEngine,
  plan: CodexRecoveryPlan,
  ingestOpts: Omit<TranscriptsIngestOpts, 'paths' | 'sourceId' | 'format'> = {},
): Promise<TranscriptsIngestResult | null> {
  if (plan.recoverable.length === 0) return null;
  return runTranscriptsIngest(engine, {
    ...ingestOpts,
    paths: [...new Set(plan.recoverable.map((r) => r.rollout_path))],
    sourceId: plan.source_id,
    format: 'codex',
  });
}
