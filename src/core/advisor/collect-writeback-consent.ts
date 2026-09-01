/**
 * collect-writeback-consent — the ambient-writeback nudge's RECURRING pull
 * surface (WP8). Reminder role only: it emits nothing until the one-time
 * init/post-upgrade ask has fired (the sentinel), so the advisor never
 * becomes the FIRST place a consent question appears. Personal brains only
 * (declaration > heuristic), local-only (`ctx.remote` drops it), and
 * deliberately NOT `--apply`-able: consent must never be automated, so there
 * is no `dispatch_id` and `command_argv` is null — the render footer's "ask
 * before running any fix" plus `ask_user: true` carry the posture.
 */

import type { AdvisorCollector } from './types.ts';
import { AUTO_WRITEBACK_KEY, AUTO_WRITEBACK_NOTICE_KEY } from '../facts/writeback-config.ts';
import { classifyBrainAudience } from '../facts/writeback-audience.ts';
import { isThinClient } from '../config.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { HOST_BRAIN_ID } from '../brain-registry.ts';

export const collectWritebackConsent: AdvisorCollector = {
  id: 'writeback-consent',
  collect: async (ctx) => {
    if (ctx.remote) return [];
    if (isThinClient(ctx.config)) return [];
    try {
      if (resolveBrainId(undefined) !== HOST_BRAIN_ID) return [];
    } catch {
      return [];
    }
    const [shown, mode] = await Promise.all([
      ctx.engine.getConfig(AUTO_WRITEBACK_NOTICE_KEY),
      ctx.engine.getConfig(AUTO_WRITEBACK_KEY),
    ]);
    if (shown !== 'true' || mode) return []; // first ask pending, or already decided
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
        '`gbrain bootstrap harness --yes`. Off switch: `gbrain config set memory.auto_writeback off`.',
      fix: { command_argv: null },
      collector: 'writeback-consent',
      ask_user: true,
    }];
  },
};
