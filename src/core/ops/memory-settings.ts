/**
 * Memory settings over MCP (gbrain.io memory issue, GBRA-219): read the
 * writeback mode and the exact rule text, change the agent-instruction mode
 * (admin scope + the operator's `mcp.publish_memory_settings` grant), and a
 * per-conversation switch that returns the rule to follow for the rest of a
 * conversation. Everything here is database-backed (config table + request
 * log), so a repo-less brain gets all of it.
 *
 * The capture lanes stay operator-only: set_memory_writeback writes
 * `memory.agent_writeback` (src/core/facts/writeback-settings.ts), never
 * `memory.auto_writeback`, and never the host file mirror.
 */
import type { Operation, OperationContext } from './contract.ts';
import { opError, OperationError } from './contract.ts';
import { hostFix } from './op-fix.ts';
import { opAllowedForBoundClient } from './context.ts';
import { hasScope } from '../scope.ts';
import { buildAmbientWritebackSection } from '../facts/writeback-instructions.ts';
import { CAPTURE_GATE_LANES, CAPTURE_LANE_LABELS, captureGateDecision, resolveWritebackConfig, type WritebackMode } from '../facts/writeback-config.ts';
import {
  AGENT_WRITEBACK_KEY, AGENT_WRITEBACK_VALUES, parseAgentWriteback, resolveAgentWriteback, writeAgentWriteback,
  type AgentWritebackResolution, type AgentWritebackValue,
} from '../facts/writeback-settings.ts';

export const MEMORY_SETTINGS_GATE_KEY = 'mcp.publish_memory_settings' as const;
const CONVERSATION_MODES = ['brain', 'off', 'salient', 'all'] as const;
const SET_OP = { name: 'set_memory_writeback', scope: 'admin', mutating: true } as const;
const REMEMBER_OP = { name: 'remember', scope: 'write', mutating: true } as const;
const EXTRACT_FACTS_OP = { name: 'extract_facts', scope: 'write', mutating: true } as const;
const SWITCH_OP = { name: 'memory_conversation_mode', scope: 'write', mutating: false } as const;

const BLOCKER_WHY = {
  gate_off: `The brain operator has not granted remote changes (${MEMORY_SETTINGS_GATE_KEY} is off).`,
  scope: 'Changing the brain-wide mode needs an admin-scope connection.',
  bound_client: 'This connection is bound to specific pages or tools, so it cannot change brain settings.',
  surface: 'This server\'s tool surface does not include set_memory_writeback.',
} as const;

const TAKES_EFFECT = {
  http: 'the next initialize (a new MCP session)',
  stdio: 'after the stdio server restarts',
  conversation_switch: 'immediately, for the rest of the conversation that called it',
};

const EXPLICIT_ONLY_RULE =
  'Memory for the rest of this conversation (the user asked): save only what the user explicitly asks you to keep, with remember and concise provenance. ' +
  'Do not save anything unprompted, even if this brain would otherwise ask you to. ' +
  'This does not stop background capture the brain host runs from session hooks; if the user asks whether this conversation is off the record, say so.';

/** May this caller run `op`? Same predicates dispatch applies: trusted CLI, stdio read-only, token scopes, bound-client fence. */
function callerCan(ctx: OperationContext, op: { name: string; scope: string; mutating: boolean }): boolean {
  if (ctx.remote === false) return true;
  if (ctx.stdioSurface?.readOnly && op.mutating) return false;
  if (ctx.auth && !hasScope(ctx.auth.scopes ?? [], op.scope)) return false;
  return opAllowedForBoundClient(ctx.auth, op as never);
}

async function gateOn(ctx: OperationContext): Promise<boolean> {
  if (ctx.remote === false) return true;
  const { readPublishGate } = await import('../../mcp/publish-gates.ts');
  return readPublishGate(ctx.engine, ctx.config, MEMORY_SETTINGS_GATE_KEY, ctx.transport);
}

function grantFix(ctx: OperationContext) {
  return hostFix(ctx, ['gbrain', 'config', 'set', MEMORY_SETTINGS_GATE_KEY, 'true'],
    'Lets admin-scope connections change the memory writeback mode agents are told to follow. The host capture lanes stay on the operator\'s memory.auto_writeback.');
}

function ruleFor(res: AgentWritebackResolution, mode: WritebackMode, ctx: OperationContext, origin: 'brain' | 'conversation'): string | null {
  if (mode === 'off') return null;
  return buildAmbientWritebackSection({
    mode,
    transientTtl: res.operator.transient_ttl,
    visibility: res.operator.visibility,
    extractFactsAvailable: callerCan(ctx, EXTRACT_FACTS_OP),
    origin,
  });
}

function degradedNote(res: AgentWritebackResolution): string | undefined {
  if (res.status === 'ok') return undefined;
  return `The memory settings could not be read cleanly (${res.reasons.join(', ')}), so agents are told the most conservative mode that applies. This is not proof that writeback is off on purpose; the brain host can check with \`gbrain doctor --only memory_writeback\`.`;
}

const get_memory_settings: Operation = {
  name: 'get_memory_settings',
  mutating: false,
  outputRedaction: 'no_stored_text',
  description: 'Memory writeback settings: the mode agents follow, the exact rule text, every mode\'s rule, background capture state, and whether you may change it.',
  params: {},
  scope: 'read',
  area: 'memory-settings',
  cliHints: { name: 'memory-settings' },
  handler: async (ctx) => {
    const res = await resolveAgentWriteback(ctx.engine, ctx.config);
    const capture = await resolveWritebackConfig(ctx.engine, ctx.config, { gate: true });
    const canRemember = callerCan(ctx, REMEMBER_OP);
    const gate = await gateOn(ctx);
    const bound = Boolean(ctx.auth?.boundSlugPrefixes || ctx.auth?.allowedOperations);
    const blockers: Array<'gate_off' | 'scope' | 'bound_client' | 'surface'> = [];
    if (!gate) blockers.push('gate_off');
    if (ctx.remote !== false && ctx.auth && !hasScope(ctx.auth.scopes ?? [], 'admin')) blockers.push('scope');
    if (ctx.remote !== false && bound && !opAllowedForBoundClient(ctx.auth, SET_OP as never)) blockers.push('bound_client');
    if (ctx.surfaceCeiling && ctx.surfaceCeiling !== 'full') blockers.push('surface');
    const canSwitch = canRemember && callerCan(ctx, SWITCH_OP);
    const note = degradedNote(res);
    return {
      status: res.status,
      ...(res.reasons.length ? { reasons: res.reasons } : {}),
      effective_mode: res.bundle.mode,
      source: res.source,
      operator_mode: { mode: res.operator.mode, explicit: res.operator.raw_mode != null },
      agent_override: res.override ?? 'inherit',
      transient_ttl: res.operator.transient_ttl,
      visibility: res.operator.visibility,
      rule_text: canRemember ? ruleFor(res, res.bundle.mode, ctx, 'brain') : null,
      ...(canRemember ? {} : { rule_text_note: 'This connection cannot call remember, so its instructions carry no writeback rule.' }),
      rule_texts: { salient: ruleFor(res, 'salient', ctx, 'brain'), all: ruleFor(res, 'all', ctx, 'brain') },
      background_capture: Object.fromEntries(CAPTURE_GATE_LANES.map(lane => [lane, {
        label: CAPTURE_LANE_LABELS[lane],
        state: captureGateDecision(capture, lane).action === 'extract' ? 'on' : captureGateDecision(capture, lane).action === 'retire' ? 'off' : 'held',
      }])),
      background_capture_note: 'Background capture runs only where the brain host installed session hooks, and follows the operator\'s memory.auto_writeback; the agent override does not change it.',
      takes_effect: TAKES_EFFECT,
      can_set: blockers.length === 0
        ? { allowed: true }
        : { allowed: false, blocked_by: blockers, ...(blockers.includes('gate_off') ? { fix: grantFix(ctx) } : {}),
            why: blockers.map(b => BLOCKER_WHY[b]).join(' ') },
      conversation_switch: canSwitch ? { available: true } : { available: false, why: 'memory_conversation_mode needs a connection that can call remember and is not bound to specific pages or tools.' },
      ...(note ? { note } : {}),
    };
  },
};

const set_memory_writeback: Operation = {
  name: 'set_memory_writeback',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Change the brain-wide writeback mode agents are told to follow (inherit uses the operator\'s setting). Admin scope and the operator\'s grant required; background capture is not changed.',
  params: {
    mode: { type: 'string', required: true, enum: [...AGENT_WRITEBACK_VALUES], description: 'inherit | off | salient | all.' },
    dry_run: { type: 'boolean', description: 'Preview the change; writes nothing.' },
  },
  scope: 'admin',
  area: 'memory-settings',
  publishGateKey: MEMORY_SETTINGS_GATE_KEY,
  handler: async (ctx, p) => {
    if (!(await gateOn(ctx))) {
      const err = opError('permission_denied',
        'The brain operator has not granted remote changes to the memory writeback mode, so this tool is hidden from your catalog.',
        `Ask whoever runs this brain to enable it with \`gbrain config set ${MEMORY_SETTINGS_GATE_KEY} true\`. Nothing was changed.`,
        { fix: grantFix(ctx) });
      err.detail = `config_key=${MEMORY_SETTINGS_GATE_KEY}`;
      throw err;
    }
    if (!callerCan(ctx, SET_OP)) {
      throw opError('permission_denied', 'Changing the brain-wide memory writeback mode needs an admin-scope connection that is not bound to specific pages or tools.',
        'Ask the brain\'s administrator to make the change. Nothing was changed.');
    }
    const mode = parseAgentWriteback(p.mode);
    if (!mode) throw opError('invalid_params', `mode must be one of: ${AGENT_WRITEBACK_VALUES.join(', ')}.`, 'Pass the mode the user chose. Nothing was changed.');
    const before = await resolveAgentWriteback(ctx.engine, ctx.config);
    const effective: WritebackMode = mode === 'inherit' ? before.operator.mode : mode;
    let caution: string | undefined;
    if (effective !== 'off') {
      try {
        const { classifyBrainAudience } = await import('../facts/writeback-audience.ts');
        const audience = await classifyBrainAudience(ctx.engine, ctx.config);
        if (audience.audience === 'shared') {
          caution = `This brain looks like a team brain (${audience.reasons.join('; ')}): agents on every member's connection will save what people tell them into a store other authorized agents can read.`;
        }
      } catch { /* advisory only */ }
    }
    const common = {
      requested: mode,
      effective_mode: effective,
      background_capture_unchanged: true,
      takes_effect: TAKES_EFFECT,
      ...(effective === 'off' && before.operator.enabled ? { note: 'Agents will stop saving unprompted, but background capture from host session hooks follows the operator\'s memory.auto_writeback and keeps running.' } : {}),
      ...(caution ? { caution } : {}),
    };
    if (ctx.dryRun || p.dry_run === true) return { applied: false, dry_run: true, previous: before.override ?? 'inherit', ...common };
    const transport = ctx.remote === false ? 'cli' as const : ctx.transport ?? 'stdio';
    const actor = ctx.remote === false ? 'operator' : ctx.auth?.clientId ?? 'stdio';
    try {
      const { previous } = await writeAgentWriteback(ctx.engine, mode, { actor, client_id: ctx.auth?.clientId ?? null, transport });
      return { applied: true, previous: previous ?? 'inherit', ...common };
    } catch (e) {
      if (e instanceof OperationError) throw e;
      const cause = ctx.remote === false ? ` (${e instanceof Error ? e.message : String(e)})` : '';
      throw opError('memory_setting_write_outcome_unknown',
        `The change to ${mode} may or may not have been saved: the database write did not confirm${cause}.`,
        'Call get_memory_settings to read the current mode before trying again; do not repeat the change blindly.',
        { fix: { mcp: { tool: 'get_memory_settings', arguments: {} }, consent: [], actor: 'agent', requires_exclusive: false, why: 'Reads the mode actually in effect, so a retry only happens if the change did not land.' } });
    }
  },
};

const memory_conversation_mode: Operation = {
  name: 'memory_conversation_mode',
  outputRedaction: 'no_stored_text',
  description: 'Use when the user says "save everything from here" (all) or "stop saving" (off: explicit saves only): returns the memory rule for the rest of this conversation. Stores nothing.',
  params: {
    mode: { type: 'string', required: true, enum: [...CONVERSATION_MODES], description: 'all | salient | off (only what the user explicitly asks to keep) | brain (this brain\'s mode).' },
  },
  scope: 'write',
  area: 'memory-settings',
  handler: async (ctx, p) => {
    if (!callerCan(ctx, REMEMBER_OP) || !callerCan(ctx, SWITCH_OP)) {
      throw opError('permission_denied', 'memory_conversation_mode needs a connection that can call remember, and this one cannot.',
        'Tell the user this connection cannot save memory; nothing was changed.');
    }
    const mode = String(p.mode ?? '');
    if (!(CONVERSATION_MODES as readonly string[]).includes(mode)) {
      throw opError('invalid_params', `mode must be one of: ${CONVERSATION_MODES.join(', ')}.`, 'Ask the user which they meant; do not pick a mode for them.');
    }
    const res = await resolveAgentWriteback(ctx.engine, ctx.config);
    const effective: WritebackMode = mode === 'brain' ? res.bundle.mode : mode as WritebackMode;
    const rule = mode === 'off' || effective === 'off' ? EXPLICIT_ONLY_RULE : ruleFor(res, effective, ctx, mode === 'brain' ? 'brain' : 'conversation')!;
    const note = degradedNote(res);
    return {
      mode,
      effective_mode: mode === 'off' ? 'off' : effective,
      applies_to: 'this_conversation',
      persisted: false,
      rule_text: rule,
      background_capture_unchanged: true,
      note: 'Follow rule_text for the rest of this conversation. Nothing was stored: a new conversation starts from the brain\'s mode, and if the conversation is compacted, call this again.',
      ...(note ? { degraded_note: note } : {}),
    };
  },
};

export const memorySettingsOperations: Operation[] = [get_memory_settings, set_memory_writeback, memory_conversation_mode];
export const MEMORY_SETTINGS_KEYS = [AGENT_WRITEBACK_KEY, MEMORY_SETTINGS_GATE_KEY] as const;
export type { AgentWritebackValue };
