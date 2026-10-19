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
 *     mirror failure downgraded to a warning), with the synthesis-derived
 *     trust on the insert.
 *   - #6982 (D-18): the take is refused (TAKE_WRITE_FAILED) when the page's
 *     file is not its canonical copy (write-through off, `storage.db_only`,
 *     gitignored), when the page has no file, or when the file and the
 *     database differ outside the takes section. Appending there would write
 *     a takes-only or stale file that the next sync imports over the page.
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
import { deriveTrust, derivedMaintenanceTransaction } from '../trust/taint.ts';
import { derivedFileTarget } from '../cycle/derived-write-through.ts';
import { fileDatabaseDriftToken, mirroredBody, readStoredBody } from '../facts/file-body-guard.ts';
import { stripTakesFence, TAKES_FENCE_BEGIN } from '../takes-fence.ts';
import { existsSync, readFileSync } from 'node:fs';

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
  result: Pick<ThinkResult, 'answer' | 'synthesisOk' | 'taint_refs'>,
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

  // #5575 I2: the take restates the synthesis, so it carries the tier of everything in the synthesis prompt.
  const derivation = await deriveTrust(engine, result.taint_refs ?? [], { channel: 'derive:think' });
  try {
    await assertTakeFileCanonical(engine, opts.anchor, opts.sourceId ?? 'default');
    const { rowNum, mirror } = await addTakeToPage(
      {
        engine,
        slug: opts.anchor,
        brainDir,
        sourceId: opts.sourceId,
        trust: derivation.trust,
        ...(opts.lockTimeoutMs !== undefined ? { lockTimeoutMs: opts.lockTimeoutMs } : {}),
      },
      { claim, kind: 'take', holder, source: 'think' },
    );
    if (mirror.mirror_warning) {
      warnings.push(`TAKE_DB_MIRROR_WARNING: ${mirror.mirror_warning}`);
    } else {
      try {
        await derivedMaintenanceTransaction(engine, derivation, async tx => ({ result: undefined, rows: (await tx.executeRaw<{ id: number }>(
          'SELECT k.id FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND p.slug=$2 AND k.row_num=$3',
          [opts.sourceId ?? 'default', opts.anchor, rowNum])).map(take => ({ table: 'takes' as const, id: Number(take.id), sourceId: opts.sourceId ?? 'default' })) }));
      } catch (e) {
        warnings.push(`TAKE_LINEAGE_WARNING: the take was written at its derived trust tier but its input edges were not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
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

/** A page body with its takes section (fence and the heading addTakeToPage adds) removed and whitespace collapsed. */
function bodyOutsideTakes(compiledTruth: string | null, timeline: string | null): string {
  const text = `${compiledTruth ?? ''}\n${timeline ?? ''}`.replace(new RegExp(`(^|\\n)## Takes\\s*\\n(?=${TAKES_FENCE_BEGIN})`), '$1');
  return stripTakesFence(text).replace(/\s+/g, ' ').trim();
}

async function assertTakeFileCanonical(engine: BrainEngine, slug: string, sourceId: string): Promise<void> {
  const stored = await readStoredBody(engine, sourceId, slug);
  if (!stored) return;
  const resolved = await derivedFileTarget(engine, slug, sourceId);
  if (!resolved.ok) {
    throw new TakesWriteError('mirror_unavailable',
      `${slug} has no canonical markdown file (${resolved.skipped}), so the take was not written: a takes file there would be imported over the database page.`,
      `Add it with gbrain takes add ${slug} --source ${sourceId}, which puts a database-only page's take in its database body.`);
  }
  const path = resolved.target.filePath;
  if (!existsSync(path)) {
    throw new TakesWriteError('mirror_unavailable',
      `${slug} has no checkout file, so the take was not written: a takes-only file would be imported over the database page.`,
      `Restore the page's file first (gbrain get ${slug} --source ${sourceId}, then gbrain put ${slug} --source-id ${sourceId} with write-through on), then rerun the take.`);
  }
  const file = mirroredBody(readFileSync(path, 'utf-8'), slug);
  if (bodyOutsideTakes(file.compiled_truth, file.timeline) !== bodyOutsideTakes(stored.compiled_truth, stored.timeline)) {
    throw new TakesWriteError('mirror_unavailable', fileDatabaseDriftToken(slug, sourceId, 'before', 'the take was not written'));
  }
}
