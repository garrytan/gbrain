/**
 * BrainBench Codex adapter — seam: 'contract'.
 *
 * Models the fragments integration shape: a STATIC entity-index preamble
 * (AGENTS.md-style — computed once at conversation start, slugs + titles only,
 * no per-turn awareness) plus AT MOST ONE per-turn fragment. Grades how much
 * push quality degrades when injection is mostly static.
 *
 * Scoring honesty: the static preamble is an INDEX (it names every page), so
 * its slugs deliberately do NOT count as injectedSlugs — counting them would
 * trivially game push_recall. Only the per-turn fragment is scored; the
 * preamble's size shows up once in turn 1's injectedTokens so the intrusion
 * diagnostics (decision 18) see its cost.
 */

import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import type {
  AdapterFixtureView,
  HarnessAdapter,
  HarnessTurnResult,
  PublicTurn,
} from '../types.ts';
import { estimateTokens, runReflexPipeline, toTurnResult } from './shared.ts';

export const CODEX_MAX_FRAGMENTS = 1;
/** Preamble caps: keep the static index bounded like a real AGENTS.md section. */
const PREAMBLE_MAX_PAGES = 50;

export class CodexAdapter implements HarnessAdapter {
  readonly name = 'codex' as const;
  readonly seam = 'contract' as const;

  private engine: PGLiteEngine | null = null;
  private sourceId = 'default';
  private preamble = '';
  private firstTurn = true;

  async beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void> {
    this.engine = engine;
    this.sourceId = fixture.active_source;
    this.firstTurn = true;
    this.preamble = await this.buildPreamble();
  }

  /** Static entity index: titles + slugs in the active source, alphabetical. */
  private async buildPreamble(): Promise<string> {
    if (!this.engine) return '';
    try {
      const rows = await this.engine.executeRaw<{ slug: string; title: string }>(
        `SELECT slug, title FROM pages
          WHERE deleted_at IS NULL AND source_id = $1
          ORDER BY slug LIMIT $2`,
        [this.sourceId, PREAMBLE_MAX_PAGES],
      );
      if (!rows.length) return '';
      const lines = ['## Brain index', ...rows.map((r) => `- ${r.title} → \`${r.slug}\``)];
      return lines.join('\n');
    } catch (err) {
      // Loud, not silent: an empty preamble skews avg_injected_tokens with
      // no trace otherwise (adversarial hygiene finding).
      process.stderr.write(`[brainbench codex] preamble build failed: ${(err as Error).message}\n`);
      return '';
    }
  }

  async replayTurn(turn: PublicTurn, priorContextText: string): Promise<HarnessTurnResult> {
    if (!this.engine) throw new Error('codex adapter: beginConversation not called');
    const started = performance.now();
    const block = await runReflexPipeline(this.engine, this.sourceId, turn, priorContextText, {
      maxPointers: CODEX_MAX_FRAGMENTS,
      suppression: 'prior-context',
    });
    const latencyMs = performance.now() - started;

    const fragment = block?.text ?? null;
    const result = toTurnResult(block, fragment, latencyMs);
    if (this.firstTurn) {
      // The static preamble's cost lands once, on the first turn, so intrusion
      // diagnostics see it without its slugs polluting push metrics.
      result.injectedTokens += estimateTokens(this.preamble);
      this.firstTurn = false;
    }
    return result;
  }

  async endConversation(): Promise<void> {
    this.engine = null;
    this.preamble = '';
  }
}
