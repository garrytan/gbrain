/**
 * #6393: the pack gate for pack-declared paid phases (extract_atoms,
 * synthesize_concepts). Resolves through the same tiers `gbrain schema active`
 * uses (DB config and per-source DB config included). A paid phase that only
 * the DB tiers declare, and that the file-plane resolution this gate used
 * before did not, stays skipped until the operator sets `cycle.<phase>.enabled`.
 */
import type { BrainEngine } from '../engine.ts';
import type { CyclePhase, PhaseResult } from '../cycle.ts';

export interface PackPhaseGate {
  declared: boolean;
  resolved_pack?: string;
  source_tier?: string;
  reason?: 'pack_resolution_failed';
  /** #6393 (T4): a DB-config pack newly runs this paid phase; it waits for `cycle.<phase>.enabled true`. */
  consent_required?: boolean;
}

export async function resolvePackPhaseGate(
  engine: BrainEngine,
  phase: CyclePhase,
  sourceId?: string,
): Promise<PackPhaseGate> {
  try {
    const { engineSchemaInput } = await import('../schema-pack/engine-resolution.ts');
    const { loadActivePack, resolveActivePackNameOnly } = await import('../schema-pack/load-active.ts');
    const input = await engineSchemaInput(engine, { remote: false, ...(sourceId ? { sourceId } : {}) });
    const resolved = await loadActivePack(input);
    const gate: PackPhaseGate = {
      declared: (resolved.manifest.phases ?? []).includes(phase),
      resolved_pack: resolved.manifest.name,
      source_tier: resolveActivePackNameOnly(input).source,
    };
    if (!gate.declared || (gate.source_tier !== 'db-config' && gate.source_tier !== 'per-source-db')) return gate;
    const { loadConfig } = await import('../config.ts');
    const filePlane = await loadActivePack({ cfg: loadConfig(), remote: false }).catch(() => null);
    if ((filePlane?.manifest.phases ?? []).includes(phase)) return gate;
    if ((await engine.getConfig(`cycle.${phase}.enabled`))?.trim() === 'true') return gate;
    return { ...gate, consent_required: true };
  } catch {
    return { declared: false, reason: 'pack_resolution_failed' };
  }
}

const NOT_DECLARED: Partial<Record<CyclePhase, string>> = {
  extract_atoms: 'extract_atoms: active pack does not declare this phase in its phases: list — add it or activate a lens pack that ships it (gbrain-creator / gbrain-everything); run `gbrain dream --phase extract_atoms --drain` to drain a backlog',
  synthesize_concepts: 'synthesize_concepts: active pack does not declare this phase in its phases: list — add it or activate a lens pack that ships it (gbrain-creator / gbrain-everything)',
};

/** The skipped phase result when the pack gate keeps `phase` off, else null (the phase runs). */
export async function packGateSkip(engine: BrainEngine, phase: CyclePhase, sourceId?: string): Promise<PhaseResult | null> {
  const gate = await resolvePackPhaseGate(engine, phase, sourceId);
  if (gate.declared && !gate.consent_required) return null;
  return {
    phase,
    status: 'skipped',
    duration_ms: 0,
    summary: gate.consent_required
      ? `${phase}: the active pack ${gate.resolved_pack} (from ${gate.source_tier}) declares this paid phase, which did not run before; run \`gbrain config set cycle.${phase}.enabled true\` to let the cycle run it`
      : NOT_DECLARED[phase] ?? `${phase}: active pack does not declare this phase`,
    details: {
      reason: gate.consent_required ? 'consent_required' : gate.reason ?? 'not_in_active_pack',
      pack_gated: true,
      ...(gate.resolved_pack ? { resolved_pack: gate.resolved_pack, source_tier: gate.source_tier } : {}),
    },
  };
}
