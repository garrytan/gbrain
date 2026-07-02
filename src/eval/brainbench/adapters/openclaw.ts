/**
 * BrainBench OpenClaw adapter — seam: 'production'.
 *
 * Drives the exact pipeline the shipped OpenClaw context engine runs per turn
 * (src/core/context-engine.ts → buildReflexAddition → extractCandidates →
 * resolveEntitiesToPointers), with production defaults: 3-pointer budget,
 * prior-context suppression, markdown pointer-block wire shape. What this row
 * scores is what an OpenClaw user's reflex actually does.
 */

import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import { DEFAULT_MAX_POINTERS } from '../../../core/context/retrieval-reflex.ts';
import type {
  AdapterFixtureView,
  HarnessAdapter,
  HarnessTurnResult,
  PublicTurn,
} from '../types.ts';
import { runReflexPipeline, toTurnResult } from './shared.ts';

export class OpenClawAdapter implements HarnessAdapter {
  readonly name = 'openclaw' as const;
  readonly seam = 'production' as const;

  private engine: PGLiteEngine | null = null;
  private sourceId = 'default';

  async beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void> {
    this.engine = engine;
    this.sourceId = fixture.active_source;
  }

  async replayTurn(turn: PublicTurn, priorContextText: string): Promise<HarnessTurnResult> {
    if (!this.engine) throw new Error('openclaw adapter: beginConversation not called');
    const started = performance.now();
    const block = await runReflexPipeline(this.engine, this.sourceId, turn, priorContextText, {
      maxPointers: DEFAULT_MAX_POINTERS,
      suppression: 'prior-context',
    });
    const latencyMs = performance.now() - started;
    return toTurnResult(block, block?.text ?? null, latencyMs);
  }

  async endConversation(): Promise<void> {
    this.engine = null;
  }
}
