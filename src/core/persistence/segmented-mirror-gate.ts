/**
 * A withdrawal mirror of a page stored in segments writes a version 2 recovery record (effect-model.ts): the file is staged
 * by path and digest, never embedded. A gbrain below SEGMENTED_WRITER_FLOOR cannot read that record: v0.60.290.0 reads it
 * as version 1 (`Buffer.from(record.after)` with `after: null`) and fails every attempt with an untyped TypeError
 * (`effect_unavailable`), retrying every 30 seconds without parking, while the record holds every write and effect on
 * the worktree; it never deletes the record or its stage (recovery-version.ts refuses unknown versions from this release
 * on). That binary cannot be changed, so this one does not write such a record while the segmented-storage writer gate
 * (page-body/limits.ts `segmentedWriterBlockers`, the evidence that keeps `pages.segmented_storage` off, read at most
 * once per SEGMENTED_WRITER_GATE_TTL_MS) sees a live writer that cannot read it in its window (segmented-gate-hold.ts:
 * not this host's own pre-upgrade writes that this build has since superseded, which doctor reports as information): the mirror refuses
 * `segmented_mirror_writer_gate` before it streams the file, retries and parks like any failed mirror (writer status and
 * doctor list it), and the file keeps the withdrawn row meanwhile. A version 1 record is no way out: it would hold the
 * whole file in memory and in the record, and v0.60.290.0's recovery of it publishes the file and then refuses forever
 * to materialize a segmented page (`assertInlineBody`). Once the gate clears (the older writer upgraded and outside the
 * window), `resumeGatedMirrors` gives each request whose parked targets all carry this code the one more attempt
 * `gbrain sources writer retry-effects` would authorize.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { SEGMENTED_WRITER_GATE_TTL_MS, SEGMENTED_WRITER_WINDOW_DAYS, segmentedWriterBlockers } from '../page-body/limits.ts';
import { WITHHELD_BY_MIRROR, type PersistenceEffect } from './effect-model.ts';
import type { SegmentedGateWriter } from './writer-versions.ts';
import { liveSegmentedBlockers } from './segmented-gate-hold.ts';

export const SEGMENTED_MIRROR_GATE_CODE = 'segmented_mirror_writer_gate';
const SAMPLE = 5;

function gateFix(hosts: string[]): Action {
  return { argv: ['gbrain', 'upgrade'], consent: [], actor: 'host_admin', requires_exclusive: false,
    why: 'A gbrain that cannot read a large page\'s withdrawal-mirror recovery record wrote to this brain recently, so the mirror waits instead of leaving a record that binary would wedge on.',
    user_message: `Run gbrain upgrade on ${hosts.join('; ')}, and restart its serve, sync or worker processes. The hold clears ${SEGMENTED_WRITER_WINDOW_DAYS} days after the last write of an older gbrain (gbrain doctor's segmented_storage check names when); the parked mirror then runs again by itself.`,
    verify: { argv: ['gbrain', 'doctor', '--json'] } };
}

export function segmentedMirrorWriterGate(effect: Pick<PersistenceEffect, 'source_id'>, slug: string, blockers: SegmentedGateWriter[]): OperationError {
  const byHost = new Map<string, SegmentedGateWriter>();
  for (const row of blockers) {
    const key = row.host_id ?? 'an unidentified host';
    const seen = byHost.get(key);
    if (!seen || (row.last_seen ?? '') > (seen.last_seen ?? '')) byHost.set(key, row);
  }
  const hosts = [...byHost].slice(0, SAMPLE).map(([host, row]) => `host ${host} (${row.version_label}, ${row.principal}, last ${row.last_seen ?? 'unknown'})`);
  const more = byHost.size > SAMPLE ? ` and ${byHost.size - SAMPLE} more` : '';
  return opError(SEGMENTED_MIRROR_GATE_CODE, 'The withdrawal mirror of a page stored in segments waits for older gbrain writers to be upgraded.',
    `Page ${slug} in source ${effect.source_id} is stored in segments, and a gbrain that cannot read the recovery record its mirror writes wrote here in the last ${SEGMENTED_WRITER_WINDOW_DAYS} days: ${hosts.join('; ')}${more}. The withdrawal is committed and nothing was staged; the canonical file keeps the withdrawn row until the mirror runs. Tell the user to upgrade those hosts (fix); the mirror retries, parks, and resumes by itself once the hold clears.`,
    { fix: gateFix([...hosts, ...(more ? [more.trim()] : [])]) });
}

/** Live blockers per gate read: keyed on the TTL-cached blocker list, so a fresh gate read classifies again. */
let liveByRead = new WeakMap<SegmentedGateWriter[], Map<string, SegmentedGateWriter[]>>();

/**
 * The gate blockers that hold the mirror: those doctor `segmented_storage` still warns about (segmented-gate-hold.ts).
 * This host's own writes from before it upgraded, superseded by the same kind of write from this build, do not.
 */
export async function mirrorGateBlockers(engine: BrainEngine, hostId: string): Promise<SegmentedGateWriter[]> {
  const blockers = await segmentedWriterBlockers(engine);
  if (!blockers.length) return blockers;
  const byHost = liveByRead.get(blockers) ?? new Map<string, SegmentedGateWriter[]>();
  liveByRead.set(blockers, byHost);
  let live = byHost.get(hostId);
  if (!live) byHost.set(hostId, live = await liveSegmentedBlockers(engine, blockers, hostId));
  return live;
}

/** Refuses the mirror of a segmented page while a live writer that cannot read its version 2 record may claim it. */
export async function assertSegmentedMirrorGate(engine: BrainEngine, effect: PersistenceEffect, slug: string, hostId: string): Promise<void> {
  const blockers = await mirrorGateBlockers(engine, hostId);
  if (blockers.length) throw segmentedMirrorWriterGate(effect, slug, blockers);
}

let lastResume = new WeakMap<object, number>();
/** Test seam: forget when parked gated mirrors were last looked for. */
export function _resetGatedMirrorResumeForTests(): void { lastResume = new WeakMap(); liveByRead = new WeakMap(); }

/**
 * Once the writer gate is clear, requeues (through `retryParkedEffects`, with its authority, claim and recovery checks)
 * up to 100 requests on worktrees this host owns whose every parked target was parked by the gate, or is a Git or embedding
 * target parked behind that mirror (`WITHHELD_BY_MIRROR`, re-armed once the mirror commits). Looked for at most
 * once per SEGMENTED_WRITER_GATE_TTL_MS per engine; never throws, so an effect pass is never stopped by it.
 */
export async function resumeGatedMirrors(engine: BrainEngine, hostId: string): Promise<number> {
  const last = lastResume.get(engine);
  if (last !== undefined && Date.now() - last < SEGMENTED_WRITER_GATE_TTL_MS) return 0;
  lastResume.set(engine, Date.now());
  let requeued = 0;
  try {
    const requests = await engine.executeRaw<{ id: string; source_id: string; request_id: string }>(
      `SELECT DISTINCT r.id::text AS id,r.source_id,r.request_id::text AS request_id FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id JOIN persistence_worktrees w ON w.id=e.worktree_id
       WHERE e.kind='withdrawal-mirror' AND e.state='failed' AND e.error_code='targets_parked' AND w.owner_host_id=$1::uuid
       AND e.data->'parked' @> $2::text::jsonb
       AND NOT EXISTS (SELECT 1 FROM persistence_effects o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.data->'parked','[]'::jsonb)) AS p(target)
         WHERE o.request_id=e.request_id AND o.state<>'committed' AND COALESCE(p.target->>'error_code','')<>ALL($3::text[]))
       LIMIT 100`, [hostId, JSON.stringify([{ error_code: SEGMENTED_MIRROR_GATE_CODE }]), [SEGMENTED_MIRROR_GATE_CODE, WITHHELD_BY_MIRROR]]);
    if (!requests.length || (await mirrorGateBlockers(engine, hostId)).length) return 0;
    const { retryParkedEffects } = await import('./effect-retry.ts');
    for (const request of requests) {
      try {
        const result = await retryParkedEffects(engine, request.source_id, request.request_id, false, { internalId: request.id });
        if ((result?.effects as { action?: string }[] | undefined)?.some(effect => effect.action === 'retry_queued')) requeued++;
      } catch { /* refused (authority, claim, host identity): it stays parked with its retry command */ }
    }
  } catch { /* the parked effects keep their retry commands */ }
  return requeued;
}
