/**
 * Brain-audience classification for the ambient-writeback consent nudge
 * (WP8): personal brains get a one-time relayed ASK to enable
 * `memory.auto_writeback`; company/team/shared brains get silence.
 *
 * DECLARATION BEATS HEURISTICS. The declared axis is the `brain.audience`
 * config key ('personal' | 'shared'), set by the operator, by
 * company-brainify's Phase-5 handoff (shared), or from the bootstrap
 * interview's SURFACE_MULTIUSER answer. The heuristic exists only for
 * undeclared brains and counts people, not clients (GST-3180): the
 * non-automation MCP clients active in the last 30 days that are bound to the
 * same member count once, and a client bound to nobody counts by itself, so
 * 2 members or 3 people read as shared evidence — and
 * `reasons[]` always names what decided, so doctor can surface a
 * misclassification and the one-line fix (`gbrain config set brain.audience
 * personal|shared`).
 *
 * Fail direction: a config read failure → 'unknown' (nudge surfaces stay
 * SILENT — fail-quiet); a usage-heuristic failure with a reachable DB →
 * 'personal' (a plain personal PGLite brain has none of the multi-client
 * infra; missing tables are not evidence of sharing).
 *
 * Suppression (mounts, thin clients, ctx.remote) is the CALLER's job — those
 * are "don't ask here" conditions, not audience classifications.
 *
 * This module never enables anything: classification feeds ask-vs-silence
 * decisions only.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { readClientOpUsage } from '../mcp-usage.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { HOST_BRAIN_ID } from '../brain-registry.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';

export const BRAIN_AUDIENCE_KEY = 'brain.audience';
/** Distinct non-automation clients active in 30d that count as shared evidence. */
export const SHARED_CLIENT_THRESHOLD = 3;

export type BrainAudience = 'personal' | 'shared' | 'unknown';
export interface BrainAudienceResult {
  audience: BrainAudience;
  /** Human-readable evidence, surfaced verbatim by doctor + the config caution. */
  reasons: string[];
  /** Set when 'personal' is a fallback because the client-usage read failed, not evidence: callers that widen access read it as not personal. */
  unproven?: true;
}

export async function classifyBrainAudience(
  engine: BrainEngine,
  fileCfg?: GBrainConfig | null,
): Promise<BrainAudienceResult> {
  let declared: string | null;
  try {
    // DB plane authoritative; the file mirror (dual-written by `config set
    // brain.audience`) fills a gap — e.g. a fresh DB that lost its config
    // rows while the machine-local declaration survived. The mirror is
    // MACHINE-GLOBAL while DB rows are per-brain, so it only speaks for the
    // HOST brain: a mounted/selected team brain must never inherit the host
    // operator's declaration (adversarial review, this wave) — its own DB
    // row or its own heuristic decides.
    let fileDeclared: string | null = null;
    try {
      if (resolveBrainId(undefined) === HOST_BRAIN_ID) {
        fileDeclared = fileCfg?.brain?.audience ?? null;
      }
    } catch { /* mount resolution failed — the mirror is not this brain's voice */ }
    declared = (await engine.getConfig(BRAIN_AUDIENCE_KEY)) ?? fileDeclared;
  } catch {
    return { audience: 'unknown', reasons: ['brain.audience unreadable (config read failed)'] };
  }
  const d = declared == null ? '' : declared.trim().toLowerCase();
  if (d === 'shared') return { audience: 'shared', reasons: ['declared: brain.audience=shared'] };
  if (d === 'personal') return { audience: 'personal', reasons: ['declared: brain.audience=personal'] };
  const reasons: string[] = [];
  if (d) reasons.push(`brain.audience='${d}' unrecognized (expected personal|shared) — falling back to the heuristic`);

  try {
    const usage = await readClientOpUsage(engine, { days: 30 });
    const humans = usage.filter((u) => !u.likely_automation);
    const names = humans.map((u) => u.token_name);
    // A failed binding read counts every credential as its own person (no merge); an engine that refuses the read
    // (engine_capability_missing) refuses the caller instead of reading as "no bindings".
    const bindings = names.length === 0 ? [] : await engine.listCredentialMemberBindings(names).catch((err: unknown) => { rethrowCapabilityRefusal(err); return null; });
    const membersOf = new Map<string, Set<string | null>>();
    for (const b of bindings ?? []) membersOf.set(b.name, (membersOf.get(b.name) ?? new Set()).add(b.member_id ?? null));
    const members = new Set<string>();
    let unbound = 0;
    for (const name of names) {
      const found = [...(membersOf.get(name) ?? [])];
      if (found.length === 1 && found[0] !== null) members.add(found[0]);
      else unbound++;
    }
    const people = members.size + unbound;
    const counted = `${people} ${people === 1 ? 'person' : 'people'} (${members.size} member(s), ${unbound} unbound client(s)${bindings === null ? ', member bindings unreadable' : ''})`;
    if (members.size >= 2 || people >= SHARED_CLIENT_THRESHOLD) {
      return {
        audience: 'shared',
        reasons: [
          ...reasons,
          `heuristic: ${humans.length} distinct non-automation MCP clients active in 30d, ${counted} (shared at 2 members or ${SHARED_CLIENT_THRESHOLD} people) — declare the truth with: gbrain config set brain.audience personal|shared`,
        ],
      };
    }
    return {
      audience: 'personal',
      reasons: [...reasons, `no shared declaration; ${humans.length} non-automation client(s) active in 30d, ${counted}`],
    };
  } catch (err) {
    // An engine that refuses a read here refuses the caller: "personal" would be a guess, not evidence.
    rethrowCapabilityRefusal(err);
    // The declaration read above already proved the DB reachable — a failed
    // usage read here means the multi-client infra isn't there (fresh or
    // pre-OAuth brain), which is itself personal-shaped evidence.
    return { audience: 'personal', unproven: true, reasons: [...reasons, 'no shared declaration; client-usage heuristic unavailable'] };
  }
}
