/**
 * capture-consent.ts — #6091: `memory.auto_writeback off` applied to session
 * text captured by the harness hooks, durably and per brain.
 *
 * Capture side (engine-free; the PreCompact and SessionEnd hooks and the
 * OpenClaw compaction spool): when the brain's own file plane says an explicit
 * `off`, the hook writes `<file>.capture-off.json` BEFORE the corpus file is
 * renamed into place. The record names the brain (its config directory, which
 * the hook command's GBRAIN_HOME selects) and the hashes of every turn banked
 * under off. A resumed session that later rewrites `<sid>.txt` under `on`
 * keeps the record, so those turns stay retired and only the new turns
 * extract; a later `on` never revives them.
 *
 * Extraction side (serve harvest, OpenClaw rung 3, the sweep): under the claim,
 * before any provider call, `applyCaptureGate` takes the current decision
 * (`captureGateDecision`) and the stricter capture-time record together:
 *   - hold: nothing is touched;
 *   - retire: `.progress` finished at the current turns plus a `writeback_off`
 *     sidecar (`retireCorpusFile`);
 *   - extract: this brain's record folds its turns into `.progress`; a file
 *     whose every turn was captured under off is retired, otherwise extraction
 *     resumes past the retired turns. A record written by another brain (a
 *     shared corpus directory) is ignored.
 *
 * Publication side: `assertAmbientCaptureAdmissible` (facts/capture-sources.ts) re-checks the gate when a
 * capture-lane fact request is admitted, so `off` applies to every ambient
 * request admitted after `config set` commits, including one whose provider
 * call was already in flight. Requests admitted before it publish.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { configDir, loadConfig } from '../config.ts';
import { captureGateDecision, fileCaptureIsOff, resolveWritebackConfig, type CaptureGateDecision, type CaptureGateLane, type WritebackMode } from '../facts/writeback-config.ts';
import { parseCorpusTurns } from './corpus-turns.ts';
import { CAPTURE_OFF_INFIX, CAPTURE_OFF_SUFFIX, CORPUS_PROGRESS_SUFFIX, parseSegmentFileName, parseWbFileName, writebackOffSidecarJson } from './corpus-segments.ts';

export { CAPTURE_OFF_INFIX, CAPTURE_OFF_SUFFIX };

interface CaptureOffRecord {
  version: 1;
  brain: string;
  source: string | null;
  at: string;
  turns: string[];
}

/** This process's brain: a hash of its resolved config directory. */
export function brainIdentity(): string {
  const dir = configDir();
  let resolved = dir;
  try { resolved = realpathSync(dir); } catch { /* not created yet: the configured path is the identity */ }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 24);
}

/** The capture gate lane of a corpus file, from its name. */
export function captureLaneForFile(name: string): CaptureGateLane {
  if (parseWbFileName(name)) return 'writeback';
  if (parseSegmentFileName(name)) return 'compact';
  return 'session_end';
}

/** A record file: absent, unreadable/invalid (never "no record": it holds), or this shape. */
function readRecord(path: string): CaptureOffRecord | null | 'unreadable' {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const r = JSON.parse(raw) as CaptureOffRecord;
    return r && r.version === 1 && typeof r.brain === 'string' && Array.isArray(r.turns) && r.turns.every((t) => typeof t === 'string') ? r : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** W4.2: this brain's own record file for corpus file `file` (two brains sharing a corpus directory never write the same file). */
export function captureOffRecordPath(file: string, brain: string = brainIdentity()): string {
  return `${file}${CAPTURE_OFF_INFIX}${brain}.json`;
}

/**
 * The turns this brain captured under off for `file`: its own record plus a
 * pre-wave-12 single-file record (`<file>.capture-off.json`) when that one
 * names this brain. `unreadable` when either file exists but cannot be read
 * or parsed, so callers hold instead of treating it as "no record".
 */
function offTurns(file: string, brain: string): string[] | 'unreadable' {
  const own = readRecord(captureOffRecordPath(file, brain));
  const legacy = readRecord(file + CAPTURE_OFF_SUFFIX);
  if (own === 'unreadable' || legacy === 'unreadable') return 'unreadable';
  return [...(own?.turns ?? []), ...(legacy && legacy.brain === brain ? legacy.turns : [])];
}

/**
 * Capture side: when `cfg` (the brain's own file plane) says an explicit off,
 * record every turn of `text` as captured under off for `file`. Call it before
 * the corpus file is renamed into place. Throws on a write failure, so the
 * caller banks nothing rather than banking text without its record.
 */
export function recordCaptureIfOff(cfg: GBrainConfig | null | undefined, file: string, text: string, source?: string | null): boolean {
  if (!fileCaptureIsOff(cfg)) return false;
  const brain = brainIdentity();
  const path = captureOffRecordPath(file, brain);
  // W4.2: the first namespaced write unions a legacy record of this brain; an unreadable record throws (bank nothing).
  const prior = offTurns(file, brain);
  if (prior === 'unreadable') throw new Error(`capture-off record for ${basename(file)} is unreadable; nothing was banked`);
  const turns = new Set(prior);
  for (const t of parseCorpusTurns(text)) turns.add(t.sha256);
  const record: CaptureOffRecord = { version: 1, brain, source: source ?? null, at: new Date().toISOString(), turns: [...turns] };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return true;
}

/** The engine's gate decision for each lane, resolved once (DB plane authoritative, file mirror for drift). */
export async function resolveCaptureGate(engine: BrainEngine): Promise<Record<CaptureGateLane, CaptureGateDecision> & { mode: WritebackMode }> {
  const cfg = await resolveWritebackConfig(engine, loadConfig(), { gate: true });
  return {
    mode: cfg.mode,
    writeback: captureGateDecision(cfg, 'writeback'),
    compact: captureGateDecision(cfg, 'compact'),
    session_end: captureGateDecision(cfg, 'session_end'),
  };
}

export interface AppliedCaptureGate {
  action: 'extract' | 'retire' | 'hold';
  reason: string;
}

/**
 * Extraction side, under the caller's claim and before any provider call:
 * applies `decision` and this brain's capture-time record to `full`.
 */
export async function applyCaptureGate(full: string, decision: CaptureGateDecision): Promise<AppliedCaptureGate> {
  if (decision.action === 'hold') return decision;
  const name = basename(full);
  const { retireCorpusFile, retireCorpusTurns } = await import('./corpus-windows.ts');
  if (decision.action === 'retire') {
    if (parseWbFileName(name)) {
      await writeFile(full + '.ingested', writebackOffSidecarJson());
      return decision;
    }
    return await retireCorpusFile(full) ? decision : { action: 'hold', reason: 'retire_deferred' };
  }
  const off = offTurns(full, brainIdentity());
  if (off === 'unreadable') return { action: 'hold', reason: 'capture_record_unreadable' };
  if (off.length === 0) return decision;
  const retired = new Set(off);
  const current = parseCorpusTurns(await readFile(full, 'utf8'));
  if (current.every((t) => retired.has(t.sha256))) {
    return await retireCorpusFile(full) ? { action: 'retire', reason: 'captured_under_off' } : { action: 'hold', reason: 'retire_deferred' };
  }
  return await retireCorpusTurns(full, [...retired]) ? decision : { action: 'hold', reason: 'retire_deferred' };
}

/** `resolveCaptureGate` + `applyCaptureGate` for one file of one lane. */
export async function gateCorpusFile(engine: BrainEngine, full: string, lane: CaptureGateLane): Promise<AppliedCaptureGate> {
  return applyCaptureGate(full, (await resolveCaptureGate(engine))[lane]);
}

/**
 * Readers outside fact extraction (dream synthesis): `content` of corpus file
 * `full` without the turns captured or retired under writeback off (this
 * brain's capture record plus `.progress` `retired_turns`). Null when nothing
 * is left. Content with no off-period turns comes back unchanged.
 */
export function withoutOffPeriodTurns(full: string, content: string): string | null {
  const recorded = offTurns(full, brainIdentity());
  if (recorded === 'unreadable') return null;
  let retired: string[] = [];
  try { retired = (JSON.parse(readFileSync(full + CORPUS_PROGRESS_SUFFIX, 'utf8')) as { retired_turns?: string[] }).retired_turns ?? []; } catch { /* no progress */ }
  const off = new Set([...recorded, ...retired]);
  if (off.size === 0) return content;
  const turns = parseCorpusTurns(content);
  const kept = turns.filter((t) => !off.has(t.sha256));
  if (kept.length === turns.length) return content;
  if (kept.length === 0) return null;
  const bytes = Buffer.from(content, 'utf8');
  return kept.map((t) => bytes.subarray(t.start, t.end).toString('utf8').trimEnd()).join('\n\n') + '\n';
}
