/**
 * BrainBench shared Reflex pipeline (decision 13).
 *
 * ONE tested pipeline — extractCandidates → resolveEntitiesToPointers → slug
 * normalization — that all three adapters drive with declarative config. This
 * keeps cross-harness comparability STRUCTURAL: the primitives are identical
 * by construction; only the seam config (pointer budget, suppression mode,
 * wire shape) varies per adapter. A Reflex evolution lands here once and every
 * harness's score moves together.
 *
 * Tracks the production resolver ladder in src/core/context/reflex.ts —
 * alias-first via engine.resolveAliases, then title/slug-suffix. The
 * production orchestrator's loadConfig() gate, integration heartbeat, and
 * 1500ms timeout wrapper are deliberately NOT graded (disclosed in
 * docs/eval/BRAINBENCH.md).
 */

import { extractCandidates } from '../../../core/context/entity-salience.ts';
import {
  resolveEntitiesToPointers,
  type PointerBlock,
} from '../../../core/context/retrieval-reflex.ts';
import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import type { HarnessTurnResult, PublicTurn } from '../types.ts';

export interface ReflexPipelineCfg {
  /** Pointer budget for this seam (openclaw 3, claude-code 2, codex 1). */
  maxPointers: number;
  /**
   * 'prior-context' — production suppression (pointers already seen in prior
   * turns are not re-injected). 'none' — the seam has no conversation memory
   * (the claude-code hook contract sees only the current prompt); the higher
   * re-injection rate that results is part of what the bench measures.
   */
  suppression: 'prior-context' | 'none';
}

/** chars/4 heuristic — intrusion diagnostics only, never a gate (decision 18). */
export function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export async function runReflexPipeline(
  engine: PGLiteEngine,
  sourceId: string,
  turn: PublicTurn,
  priorContextText: string,
  cfg: ReflexPipelineCfg,
): Promise<PointerBlock | null> {
  const candidates = extractCandidates(turn.text);
  if (!candidates.length) return null;
  return resolveEntitiesToPointers(engine, sourceId, candidates, {
    maxPointers: cfg.maxPointers,
    priorContextText: cfg.suppression === 'prior-context' ? priorContextText : undefined,
  });
}

/** Build the common turn-result shape from a pointer block + the seam's wire text. */
export function toTurnResult(
  block: PointerBlock | null,
  wireText: string | null,
  latencyMs: number,
): HarnessTurnResult {
  return {
    injectedText: wireText,
    injectedSlugs: block ? block.pointers.map((p) => p.slug) : [],
    pointers: block?.pointers ?? [],
    injectedTokens: estimateTokens(wireText),
    latencyMs,
  };
}
