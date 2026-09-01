/**
 * Ambient-writeback consent nudge (WP8): the ONE-TIME relayed ASK that fires
 * on PERSONAL brains only — company/team/shared brains stay silent, and
 * nothing is EVER auto-enabled (the only writes here are the fire-once
 * sentinel; enabling is the human's explicit `gbrain config set`, relayed by
 * the agent).
 *
 * Discipline copied from the two proven one-shot surfaces:
 *   - `runPostUpgrade`'s search-mode banner (upgrade.ts): DOUBLE gate
 *     (sentinel + the setting still unset), whole block try/catch
 *     ("cosmetic, never block"), sentinel stamped AFTER printing so a
 *     decline is permanent.
 *   - `runModePicker`'s non-TTY arm (init-mode-picker.ts): `[AGENT]` lines
 *     carry the ask — agents MUST relay them to the operator (AGENTS.md
 *     contract). Unlike runInitNudge this does NOT short-circuit on non-TTY:
 *     the agent-relay block IS the non-TTY path.
 *
 * Suppression (silence, not classification): consumer of a mounted team
 * brain (`resolveBrainId() !== HOST_BRAIN_ID`), thin clients, the
 * GBRAIN_NO_ONBOARD_NUDGE=1 bypass, and any classifier/config read failure
 * (fail-quiet). Audience comes from classifyBrainAudience — declaration
 * beats heuristics; only `personal` gets the ask.
 */

import type { BrainEngine } from '../engine.ts';
import { loadConfig, isThinClient } from '../config.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { HOST_BRAIN_ID } from '../brain-registry.ts';
import { classifyBrainAudience } from '../facts/writeback-audience.ts';
import {
  AUTO_WRITEBACK_KEY,
  AUTO_WRITEBACK_NOTICE_KEY,
  DEFAULT_TRANSIENT_TTL,
} from '../facts/writeback-config.ts';

export async function runWritebackNudge(
  engine: BrainEngine,
  opts: { context?: 'init' | 'post-upgrade' } = {},
): Promise<void> {
  try {
    if (process.env.GBRAIN_NO_ONBOARD_NUDGE === '1') return;
    const cfg = loadConfig();
    if (cfg && isThinClient(cfg)) return;
    try {
      if (resolveBrainId(undefined) !== HOST_BRAIN_ID) return;
    } catch {
      return; // mount resolution failed — fail-quiet
    }

    // Double gate: shown once ever, and never when the operator already
    // decided (a set value — any value, including 'off' — is a decision).
    const [shown, mode] = await Promise.all([
      engine.getConfig(AUTO_WRITEBACK_NOTICE_KEY),
      engine.getConfig(AUTO_WRITEBACK_KEY),
    ]);
    if (shown === 'true' || mode) return;

    const audience = await classifyBrainAudience(engine, cfg);
    if (audience.audience !== 'personal') return;

    const line = console.log;
    line('');
    line('═══════════════════════════════════════════════════════════════');
    line('[gbrain] Ambient memory writeback is available for this brain (off by default).');
    line('[gbrain] What it does, mechanically, once enabled:');
    line('[gbrain]   - agents connected to this brain are instructed to save durable facts');
    line('[gbrain]     you state directly (preferences, decisions, commitments) via the');
    line(`[gbrain]     remember tool, with provenance; transient facts (health, travel,`);
    line(`[gbrain]     mood, near-term schedule) expire after ${DEFAULT_TRANSIENT_TTL} by default.`);
    line('[gbrain]   - on Claude Code, a Stop-hook backstop banks missed turns locally for');
    line('[gbrain]     extraction; greetings, questions, tool output and pastes are skipped.');
    line('[gbrain]     (Backstop-extracted facts carry no expiry yet — only agent-saved');
    line('[gbrain]     transient facts do.)');
    line('[gbrain]   - saved facts are readable by agents authorized on THIS brain — not the');
    line('[gbrain]     public internet. Nothing new leaves your machine beyond your');
    line('[gbrain]     configured model provider calls.');
    line('[gbrain] Off switch (anytime): gbrain config set memory.auto_writeback off,');
    line('[gbrain]   then gbrain bootstrap harness --yes to remove installed instruction blocks.');
    line('═══════════════════════════════════════════════════════════════');
    line('[AGENT] One-time ask — relay to your operator: enable ambient memory');
    line('[AGENT] writeback for this personal brain? Recommended mode: salient.');
    line('[AGENT] If they say yes, run:  gbrain config set memory.auto_writeback salient');
    line('[AGENT] then:                  gbrain bootstrap harness --yes');
    line('[AGENT] If they decline, do nothing — this ask never repeats.');
    line('');

    // Stamp AFTER printing, unconditionally: a decline is permanent (the
    // advisor keeps a quiet, non-applyable reminder; `gbrain config set
    // memory.auto_writeback salient` reopens the door at any time).
    await engine.setConfig(AUTO_WRITEBACK_NOTICE_KEY, 'true');
  } catch {
    /* Nudge is cosmetic — init/upgrade MUST succeed even if it crashes. */
  }
}
