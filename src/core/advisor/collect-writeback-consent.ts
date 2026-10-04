/**
 * collect-writeback-consent — the ambient-writeback ask's RECURRING pull
 * surface (WP8). It stays until the user ANSWERS (any memory.auto_writeback
 * value, `off` included — agent contract F7), and it reaches MCP callers too
 * (the advisor is published on stdio by default), so an agent that never saw
 * the init/post-upgrade print still learns the decision is pending. Personal
 * brains only (declaration > heuristic) and deliberately NOT `--apply`-able: consent must never be automated, so there
 * is no `dispatch_id` and `command_argv` is null — the render footer's "ask
 * before running any fix" plus `ask_user: true` carry the posture.
 */

import type { AdvisorCollector } from './types.ts';
import { AUTO_WRITEBACK_KEY } from '../facts/writeback-config.ts';
import { classifyBrainAudience } from '../facts/writeback-audience.ts';
import { isThinClient } from '../config.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { HOST_BRAIN_ID } from '../brain-registry.ts';

export const collectWritebackConsent: AdvisorCollector = {
  id: 'writeback-consent',
  collect: async (ctx) => {
    if (isThinClient(ctx.config)) return [];
    try {
      if (resolveBrainId(undefined) !== HOST_BRAIN_ID) return [];
    } catch {
      return [];
    }
    if (await ctx.engine.getConfig(AUTO_WRITEBACK_KEY)) return []; // the user answered
    const audience = await classifyBrainAudience(ctx.engine, ctx.config);
    if (audience.audience !== 'personal') return [];
    return [{
      id: 'writeback_consent_pending',
      severity: 'info',
      title: 'Ambient memory writeback is available for this personal brain and still off',
      detail:
        'Agents would save durable facts the user states directly (preferences, decisions, ' +
        'commitments) with provenance; transient facts get a short TTL. Ask the user before ' +
        'anything: enable with `gbrain config set memory.auto_writeback salient`, then ' +
        '`gbrain bootstrap harness --yes`. If they decline, record it with ' +
        '`gbrain config set memory.auto_writeback off` (this finding then stops).',
      fix: { command_argv: null },
      collector: 'writeback-consent',
      ask_user: true,
    }];
  },
};
