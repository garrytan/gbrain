/**
 * Agent-instruction writeback override (gbrain.io memory settings, GBRA-219).
 *
 * `memory.agent_writeback = inherit | off | salient | all` changes ONLY what
 * agents are told to save: the ambient-writeback section and the short
 * writeback line in the MCP initialize instructions, and what
 * `get_memory_settings` renders. It is DB-only (no file mirror), so it works
 * the same on a repo-less brain, and it never feeds the host capture lanes:
 * the Stop hook, the compaction harvest and SessionEnd transcripts keep
 * reading the operator's `memory.auto_writeback` through
 * captureGateDecision (writeback-config.ts). That separation is the point: a
 * remote `off` must never retire the operator's banked session text.
 *
 * Kept out of writeback-config.ts on purpose: the engine-free hook children
 * import that module, and this one reads the audience classifier and the
 * request log.
 *
 * Fail direction: an unreadable or unrecognized override resolves to `off`
 * (never back to inherit, which would widen an `off` override on a brain
 * whose operator mode is on), with status `degraded`. A read failure serves
 * the engine's last-known-good override first, matching the operator
 * resolver's mid-session posture.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { resolveWritebackConfig, type WritebackConfig, type WritebackMode } from './writeback-config.ts';

export const AGENT_WRITEBACK_KEY = 'memory.agent_writeback';
export const AGENT_WRITEBACK_VALUES = Object.freeze(['inherit', 'off', 'salient', 'all'] as const);
export type AgentWritebackValue = (typeof AGENT_WRITEBACK_VALUES)[number];

/** The request-log operation name of a settings change (a NON_OP_LOG_ROWS member). */
export const MEMORY_SETTING_AUDIT_OP = 'memory_setting_change';

export interface AgentWritebackResolution {
  /** The operator bundle with mode/enabled replaced by the effective instruction mode. */
  bundle: WritebackConfig;
  /** The operator's own `memory.auto_writeback` resolution (also what the capture lanes follow). */
  operator: WritebackConfig;
  /** The stored override, normalized; null when unset. */
  override: AgentWritebackValue | null;
  /** Where the effective instruction mode came from. */
  source: 'agent_override' | 'operator' | 'fail_closed';
  status: 'ok' | 'degraded';
  /** Machine-readable reasons for a degraded status. */
  reasons: string[];
}

export function parseAgentWriteback(raw: unknown): AgentWritebackValue | null | undefined {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  return (AGENT_WRITEBACK_VALUES as readonly string[]).includes(s) ? s as AgentWritebackValue : undefined;
}

const overrideLkg = new WeakMap<BrainEngine, AgentWritebackValue | null>();

/** Never throws. `fileCfg` is passed through to the operator resolver as drift/LKG input only. */
export async function resolveAgentWriteback(engine: BrainEngine, fileCfg?: GBrainConfig | null): Promise<AgentWritebackResolution> {
  const operator = await resolveWritebackConfig(engine, fileCfg);
  const reasons: string[] = [];
  if (operator.read_error) reasons.push('operator_mode_unreadable');
  if (!operator.mode_valid) reasons.push('operator_mode_invalid');
  if (operator.plane_drift) reasons.push('operator_plane_drift');
  let override: AgentWritebackValue | null | undefined;
  try {
    override = parseAgentWriteback(await engine.getConfig(AGENT_WRITEBACK_KEY));
    if (override !== undefined) overrideLkg.set(engine, override);
  } catch {
    override = overrideLkg.has(engine) ? overrideLkg.get(engine)! : undefined;
    reasons.push(overrideLkg.has(engine) ? 'agent_override_last_known_good' : 'agent_override_unreadable');
  }
  let mode: WritebackMode;
  let source: AgentWritebackResolution['source'];
  if (operator.read_error) {
    // The operator read failed with no last-known-good, so the visibility and
    // TTL posture are defaults, not this brain's: never emit an enabled rule on them.
    mode = 'off';
    source = 'fail_closed';
  } else if (override === undefined) {
    if (!reasons.includes('agent_override_unreadable')) reasons.push('agent_override_invalid');
    mode = 'off';
    source = 'fail_closed';
  } else if (override === null || override === 'inherit') {
    mode = operator.mode;
    source = 'operator';
  } else {
    mode = override;
    source = 'agent_override';
  }
  return {
    bundle: { ...operator, mode, enabled: mode !== 'off' },
    operator,
    override: override ?? null,
    source,
    status: reasons.length ? 'degraded' : 'ok',
    reasons,
  };
}

export interface AgentWritebackChange {
  actor: string;
  client_id: string | null;
  transport: 'cli' | 'stdio' | 'http';
}

/**
 * Write the override and its audit row in ONE transaction: either both land
 * or neither does. Returns the previous stored value. A throw means the
 * outcome is unknown to the caller (a lost acknowledgement looks the same as
 * a rollback), so callers re-read before any retry.
 */
export async function writeAgentWriteback(
  engine: BrainEngine,
  value: AgentWritebackValue,
  change: AgentWritebackChange,
): Promise<{ previous: AgentWritebackValue | null }> {
  const result = await engine.transaction(async (tx) => {
    // Serialize concurrent changes so each audit row's `old` is the value it replaced.
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))', [AGENT_WRITEBACK_KEY]);
    const previous = parseAgentWriteback(await tx.getConfig(AGENT_WRITEBACK_KEY)) ?? null;
    await tx.setConfig(AGENT_WRITEBACK_KEY, value);
    await executeRawJsonb(
      tx,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [change.actor, change.actor, MEMORY_SETTING_AUDIT_OP, 0, 'success'],
      [{ key: AGENT_WRITEBACK_KEY, actor: change.actor, client_id: change.client_id, transport: change.transport, old: previous, new: value }],
    );
    return { previous };
  });
  overrideLkg.set(engine, value);
  return result;
}
