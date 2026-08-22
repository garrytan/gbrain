/**
 * #2556 — persist a take row from a think synthesis (`gbrain think --take`).
 *
 * The `--take` flag has been documented since v0.28 ("appends a take row to
 * the anchor page") but `RunThinkOpts.take` was never read anywhere in the
 * pipeline: the CLI parsed it, the MCP op gated it (`safeTake`), and both
 * forwarded it into runThink where it died silently. This module is the
 * missing execution half, wired by commands/think.ts and the `think` op.
 *
 * Semantics:
 *   - synthesisOk === false → warn-skip (never persist a stub/empty answer;
 *     same gate persistSynthesis uses).
 *   - claim = the first substantive line of stripGapsSection(answer),
 *     markdown markers stripped, sanitized to a single fence-safe cell
 *     (control chars collapsed, fence-marker text removed, bounded length).
 *   - holder = resolveOwnerHolder (config emotional_weight.user_holder,
 *     else 'self') — the take is the OWNER's synthesized position.
 *   - persistence goes md-first through addTakeToPage (the same canonical
 *     write-through every takes verb uses: fence row on disk, DB mirrored,
 *     mirror failure downgraded to a warning).
 *   - no brain repo (resolveTakesRepoDir null) → TAKE_MIRROR_UNAVAILABLE
 *     warning, nothing written (md is canonical; a DB-only take would be
 *     clobbered by the next reconcile).
 *
 * Remote (MCP) callers never reach this — the `think` op forces
 * safeTake=false for ctx.remote !== false, unchanged.
 */

import type { BrainEngine } from '../engine.ts';
import { stripGapsSection, type ThinkResult } from './index.ts';
import { resolveOwnerHolder } from '../owner-holder.ts';
import { resolveTakesRepoDir, addTakeToPage, TakesWriteError } from '../takes-write.ts';

/** Max claim length for a fence cell — one readable line, not an essay. */
export const TAKE_CLAIM_MAX_CHARS = 300;

export interface PersistTakeResult {
  /** Appended fence row number, or null when nothing was written. */
  take_row: number | null;
  /** Markdown file the row landed in (set iff take_row is non-null). */
  path?: string;
  /** Machine-stable warning codes (mirrors the think warnings channel). */
  warnings: string[];
}

/**
 * Extract the claim line: first substantive line of the gaps-stripped answer,
 * heading/bullet/quote markers removed, sanitized to a single fence-safe
 * cell. Returns null when the answer has no substantive line. Pure — the
 * unit-test surface.
 */
export function claimFromAnswer(answer: string): string | null {
  const stripped = stripGapsSection(answer ?? '');
  for (const raw of stripped.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+>]\s+/, '').trim();
    if (!line) continue;
    // Fence-cell safety (assertSafeCellText would THROW on these; sanitizing
    // here keeps --take best-effort instead of failing the whole think run):
    // collapse control chars to spaces, drop the fence-marker substring.
    line = line
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\n\r\t]+/g, ' ')
      .replaceAll('gbrain:takes', '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!line) continue;
    if (line.length > TAKE_CLAIM_MAX_CHARS) {
      line = `${line.slice(0, TAKE_CLAIM_MAX_CHARS - 1).trimEnd()}…`;
    }
    // A wholly-strikethrough claim round-trips as active:false — unwrap it.
    const struck = /^~~([\s\S]*)~~$/.exec(line);
    if (struck) line = struck[1].trim();
    if (!line) continue;
    return line;
  }
  return null;
}

/**
 * Append the synthesis claim as a take row on the anchor page. Never throws
 * for the expected refusal shapes (no repo, empty answer, failed synthesis) —
 * those return take_row:null with a machine-stable warning so both callers
 * (CLI + op) surface the same story.
 */
export async function persistTakeFromSynthesis(
  engine: BrainEngine,
  result: Pick<ThinkResult, 'answer' | 'synthesisOk'>,
  opts: { anchor: string; sourceId?: string; lockTimeoutMs?: number },
): Promise<PersistTakeResult> {
  const warnings: string[] = [];

  // Same persistence gate as persistSynthesis: an explicit false means the
  // stub/malformed/empty path — a take asserting nothing must not be minted.
  if (result.synthesisOk === false) {
    warnings.push('TAKE_SKIPPED_SYNTHESIS_FAILED');
    return { take_row: null, warnings };
  }

  const claim = claimFromAnswer(result.answer);
  if (!claim) {
    warnings.push('TAKE_SKIPPED_EMPTY_ANSWER');
    return { take_row: null, warnings };
  }

  const brainDir = await resolveTakesRepoDir(engine);
  if (!brainDir) {
    // md is canonical for takes — with no repo there is nothing durable to
    // write (a DB-only row would be deleted by the next fence reconcile).
    warnings.push('TAKE_MIRROR_UNAVAILABLE');
    return { take_row: null, warnings };
  }

  const holder = resolveOwnerHolder({
    configValue: await engine.getConfig('emotional_weight.user_holder'),
  });

  try {
    const { rowNum, mirror } = await addTakeToPage(
      {
        engine,
        slug: opts.anchor,
        brainDir,
        sourceId: opts.sourceId,
        ...(opts.lockTimeoutMs !== undefined ? { lockTimeoutMs: opts.lockTimeoutMs } : {}),
      },
      { claim, kind: 'take', holder, source: 'think' },
    );
    if (mirror.mirror_warning) {
      warnings.push(`TAKE_DB_MIRROR_WARNING: ${mirror.mirror_warning}`);
    }
    return { take_row: rowNum, path: mirror.path, warnings };
  } catch (e) {
    // Typed write refusals (page not found, lock timeout, fence malformed)
    // become a loud warning + null row — think's answer already printed and
    // must not be lost to a persistence failure.
    const detail = e instanceof TakesWriteError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e));
    warnings.push(`TAKE_WRITE_FAILED: ${detail}`);
    return { take_row: null, warnings };
  }
}
