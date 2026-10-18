/**
 * Quote-grounding isolation for the patterns phase (GBRA-130 A-23).
 *
 * After a completed (paid) patterns child, quote grounding rewrites every
 * pattern page the child wrote and every leftover page a crashed run left
 * without \`quote_verified_at\`. One page whose write-back fails is recorded
 * here and the rest still ground; the evidence watermark is stamped as usual,
 * so the failure never buys another child for the same evidence. Run-scoped
 * errors and a systemic run (item-failure.ts \`ItemRun\`) still fail the phase
 * and record nothing.
 *
 * Holds: a leftover page refused with a content-class error on 3 consecutive
 * runs at the same \`content_hash\` and the same producer (the gbrain version,
 * which carries the verifier and the writer) is held out of the leftover
 * query. A held page is never reported as grounded: \`grounding_held\` lists it
 * with the command that retries it. Editing the page or upgrading gbrain
 * releases it on the next run; \`gbrain config unset <key>\` releases every
 * hold of the source at once. Transient failures are never held and reset the
 * count.
 *
 * Timeline appends: the entries a child appended live only in that run, so a
 * page whose append grounding fails is recorded with the entries and the
 * reflections they are grounded against in `dream.patterns.grounding_appends.<source>`
 * before the evidence watermark is stamped. Every later run retries them before
 * its evidence and paid-child gates and drops each entry once its page grounds
 * (or the entry is gone). The same 3-run content rule holds a page's appends
 * (listed in `grounding_held` with `timeline_appends`); editing the page or
 * upgrading gbrain releases them. That key is never unset to release a hold:
 * it is the only copy of the entries still to verify.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { ItemFailure, ItemRun } from '../item-failure.ts';
import type { TaintInput } from '../trust/tier.ts';
import type { TimelineAppend } from './patterns.ts';
import { VERSION } from '../../version.ts';

export const GROUNDING_HOLDS_KEY = 'dream.patterns.grounding_holds';
export const GROUNDING_APPENDS_KEY = 'dream.patterns.grounding_appends';
export const GROUNDING_HOLD_RUNS = 3;

export interface GroundingHold {
  content_hash: string | null;
  producer: string;
  code: string;
  message: string;
  attempts: number;
  held_at: string | null;
  last_failed_at: string;
}

/** Timeline entries still to ground on one page, with the reflections (and their tiers) they are grounded against. */
export interface AppendInputs { appends: TimelineAppend[]; reflections: Array<{ slug: string; taint?: TaintInput }> }
export type PendingAppends = GroundingHold & AppendInputs;

/**
 * One run's grounding: the holds and pending appends it began with, the pages that failed (a timeline-append
 * failure carries its inputs), the pages that grounded, the request ids of appends resolved per page, and the
 * breaker every timeline-append call of the run shares.
 */
export interface GroundingRun {
  sourceId: string;
  holds: Record<string, GroundingHold>;
  pending: Record<string, PendingAppends>;
  failed: Array<ItemFailure & { content_hash: string | null; timelineAppend: boolean; inputs?: AppendInputs }>;
  grounded: Set<string>;
  appendsResolved: Map<string, Set<string>>;
  appendRun?: ItemRun;
}

export interface GroundingReport {
  failedSlugs: Set<string>;
  details: { grounding_failed: Array<{ slug: string; code: string; message: string; held: boolean; fix: string }>;
    grounding_held: Array<{ slug: string; code: string; content_hash: string | null; held_at: string; fix: string; timeline_appends?: number }> };
}

const holdsKey = (sourceId: string) => `${GROUNDING_HOLDS_KEY}.${sourceId}`;
const appendsKey = (sourceId: string) => `${GROUNDING_APPENDS_KEY}.${sourceId}`;

async function readItems<T>(engine: BrainEngine, key: string): Promise<Record<string, T>> {
  try {
    const stored = JSON.parse((await engine.getConfig(key)) ?? '{}') as { version?: number; items?: Record<string, T> };
    if (stored.version === 1 && stored.items && typeof stored.items === 'object') return stored.items;
  } catch { /* an unreadable record holds nothing */ }
  return {};
}

export async function beginGroundingRun(engine: BrainEngine, sourceId: string): Promise<GroundingRun> {
  return { sourceId, holds: await readItems(engine, holdsKey(sourceId)), pending: await readItems(engine, appendsKey(sourceId)),
    failed: [], grounded: new Set(), appendsResolved: new Map() };
}

/** A page (leftover, or one with pending appends) held at its current content and this producer is skipped; any change releases it. */
export function groundingHeld(run: GroundingRun, slug: string, contentHash: string | null, holds: Record<string, GroundingHold> = run.holds): boolean {
  const hold = holds[slug];
  return !!hold?.held_at && hold.content_hash === contentHash && hold.producer === VERSION;
}

function nextHold(prior: GroundingHold | undefined, f: GroundingRun['failed'][number], now: string): GroundingHold {
  const attempts = prior && prior.content_hash === f.content_hash && prior.producer === VERSION && prior.code === f.code ? prior.attempts + 1 : 1;
  return { content_hash: f.content_hash, producer: VERSION, code: f.code, message: f.message.slice(0, 300), attempts,
    held_at: attempts >= GROUNDING_HOLD_RUNS ? prior?.held_at ?? now : null, last_failed_at: now };
}

/** Pending appends after this run: resolved entries leave, failed ones merge in (a transient failure keeps them at 0 attempts). */
function nextPending(run: GroundingRun, now: string): Record<string, PendingAppends> {
  const pending = { ...run.pending };
  for (const [slug, resolved] of run.appendsResolved) {
    const left = pending[slug]?.appends.filter(a => !resolved.has(a.requestId));
    if (!left) continue;
    if (left.length) pending[slug] = { ...pending[slug]!, appends: left };
    else delete pending[slug];
  }
  for (const f of run.failed) {
    if (!f.inputs) continue;
    const prior = pending[f.key];
    const appends = [...(prior?.appends ?? [])];
    for (const a of f.inputs.appends) if (!appends.some(p => p.requestId === a.requestId)) appends.push(a);
    const reflections = [...(prior?.reflections ?? [])];
    for (const r of f.inputs.reflections) if (!reflections.some(p => p.slug === r.slug)) reflections.push(r);
    const hold = f.class === 'content' ? nextHold(prior, f, now) : { ...nextHold(undefined, f, now), attempts: 0 };
    pending[f.key] = { ...hold, appends, reflections };
  }
  return pending;
}

/** Merges this run into the stored holds and pending appends (only when it finished: a systemic or run-scoped stop never reaches here) and reports them. */
export async function finishGroundingRun(engine: BrainEngine, run: GroundingRun): Promise<GroundingReport> {
  const now = new Date().toISOString();
  const holds = { ...run.holds };
  for (const slug of run.grounded) delete holds[slug];
  for (const f of run.failed) {
    if (f.timelineAppend) continue;
    if (f.class !== 'content') { delete holds[f.key]; continue; }
    holds[f.key] = nextHold(holds[f.key], f, now);
  }
  if (JSON.stringify(holds) !== JSON.stringify(run.holds)) await engine.setConfig(holdsKey(run.sourceId), JSON.stringify({ version: 1, items: holds }));
  const pending = nextPending(run, now);
  if (JSON.stringify(pending) !== JSON.stringify(run.pending)) await engine.setConfig(appendsKey(run.sourceId), JSON.stringify({ version: 1, items: pending }));
  const release = `gbrain config unset ${holdsKey(run.sourceId)} && gbrain dream --phase patterns --once --source ${run.sourceId}`;
  const retry = `gbrain dream --phase patterns --once --source ${run.sourceId}`;
  const inspect = (slug: string) => `gbrain get --source ${run.sourceId} -- ${slug}`;
  return {
    failedSlugs: new Set(run.failed.map(f => f.key)),
    details: {
      grounding_failed: run.failed.map(f => ({ slug: f.key, code: f.code, message: f.message.slice(0, 300),
        held: f.timelineAppend ? !!pending[f.key]?.held_at : !!holds[f.key]?.held_at,
        fix: f.timelineAppend ? inspect(f.key) : holds[f.key]?.held_at ? release : retry })),
      grounding_held: [
        ...Object.entries(holds).filter(([, h]) => h.held_at && h.producer === VERSION)
          .map(([slug, h]) => ({ slug, code: h.code, content_hash: h.content_hash, held_at: h.held_at!, fix: release })),
        ...Object.entries(pending).filter(([, h]) => h.held_at && h.producer === VERSION)
          .map(([slug, h]) => ({ slug, code: h.code, content_hash: h.content_hash, held_at: h.held_at!, fix: inspect(slug), timeline_appends: h.appends.length })),
      ],
    },
  };
}

/** A run that failed or held a page warns, even after a clean child: a held page is not a grounded one. */
export function withGroundingStatus(result: PhaseResult, report: GroundingReport): PhaseResult {
  const failed = report.details.grounding_failed.length;
  const held = report.details.grounding_held.length;
  if (!failed && !held) return result;
  return { ...result, status: result.status === 'ok' ? 'warn' : result.status,
    summary: `${result.summary}; quote grounding: ${failed} page(s) failed, ${held} held (details.grounding_failed, details.grounding_held)` };
}
