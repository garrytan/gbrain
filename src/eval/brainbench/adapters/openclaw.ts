/**
 * BrainBench OpenClaw adapter — seam: 'production'.
 *
 * Drives the exact pipeline the shipped OpenClaw context engine runs per turn
 * (src/core/context-engine.ts → buildReflexAddition), with production
 * defaults: 3-pointer budget, prior-context suppression, markdown pointer
 * block, PLUS the volunteer arm (2026-08 fix wave — Arm 2): a 4-turn window
 * (DEFAULT_WINDOW_TURNS parity) feeds the SAME volunteerStage primitive
 * production runs (via volunteerContext, the engine-bound wrapper), and the
 * wire text composes through the SAME renderReflexAddition. What this row
 * scores is what an OpenClaw user's reflex actually does — the volunteer
 * logic cannot drift between bench and production because both consume one
 * primitive (eng-review E1; decision 13's orchestration differences — config
 * gate, heartbeat, timeout — stay deliberately ungraded, see BRAINBENCH.md).
 */

import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import { DEFAULT_MAX_POINTERS } from '../../../core/context/retrieval-reflex.ts';
import { volunteerContext, VOLUNTEER_DEFAULT_MAX_PAGES } from '../../../core/context/volunteer.ts';
import { DEFAULT_WINDOW_TURNS, renderReflexAddition } from '../../../core/context/reflex.ts';
import type { WindowTurn } from '../../../core/context/entity-salience.ts';
import type {
  AdapterFixtureView,
  HarnessAdapter,
  HarnessTurnResult,
  PublicTurn,
} from '../types.ts';
import { runReflexPipeline, estimateTokens } from './shared.ts';

export class OpenClawAdapter implements HarnessAdapter {
  readonly name = 'openclaw' as const;
  readonly seam = 'production' as const;

  private engine: PGLiteEngine | null = null;
  private sourceId = 'default';
  private window: WindowTurn[] = [];

  async beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void> {
    this.engine = engine;
    this.sourceId = fixture.active_source;
    this.window = [];
  }

  async replayTurn(turn: PublicTurn, priorContextText: string): Promise<HarnessTurnResult> {
    if (!this.engine) throw new Error('openclaw adapter: beginConversation not called');
    const started = performance.now();
    this.window.push({ role: turn.role, text: turn.text });
    if (this.window.length > DEFAULT_WINDOW_TURNS) {
      this.window = this.window.slice(-DEFAULT_WINDOW_TURNS);
    }

    // Arm 1: pointer budget — unchanged row semantics (E3 pins codex and
    // claude-code rows byte-identical; this arm keeps openclaw's pointer
    // behavior identical too, the volunteer arm is strictly additive).
    const block = await runReflexPipeline(this.engine, this.sourceId, turn, priorContextText, {
      maxPointers: DEFAULT_MAX_POINTERS,
      suppression: 'prior-context',
    });
    const pointers = block?.pointers ?? [];

    // Arm 2: the production volunteer primitive, same gate constants.
    const volunteered = await volunteerContext(this.engine, this.window, {
      sourceIds: [this.sourceId],
      priorContext: priorContextText,
      excludeSlugs: new Set(pointers.map((p) => p.slug)),
      maxPages: VOLUNTEER_DEFAULT_MAX_PAGES,
    });

    const wireText = renderReflexAddition(block?.text ?? null, volunteered);
    const latencyMs = performance.now() - started;
    return {
      injectedText: wireText,
      injectedSlugs: [...pointers.map((p) => p.slug), ...volunteered.map((v) => v.slug)],
      pointers,
      injectedTokens: estimateTokens(wireText),
      latencyMs,
    };
  }

  async endConversation(): Promise<void> {
    this.engine = null;
    this.window = [];
  }
}
