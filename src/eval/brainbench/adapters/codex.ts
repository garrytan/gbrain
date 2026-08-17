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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import { codexAdapter as codexTranscriptAdapter } from '../../../core/transcripts/codex.ts';
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
  private tmpDir: string | null = null;
  private fixtureSeq = 0;
  /** Turn texts the REAL rollout parser selected as user turns. */
  // Multiset keyed on trimmed text (adversarial F14): a Set could not see a
  // parser that DROPS one of two duplicate turns, and exact-equality keying
  // read cosmetic whitespace normalization as total turn loss.
  private parserSelected = new Map<string, number>();

  async setupRun(): Promise<void> {
    this.tmpDir = mkdtempSync(join(tmpdir(), 'brainbench-codex-'));
  }

  async teardownRun(): Promise<void> {
    if (this.tmpDir) {
      rmSync(this.tmpDir, { recursive: true, force: true });
      this.tmpDir = null;
    }
  }

  async beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void> {
    if (!this.tmpDir) await this.setupRun();
    this.engine = engine;
    this.sourceId = fixture.active_source;
    this.firstTurn = true;
    this.preamble = await this.buildPreamble();
    // v0.46.15 (F5, parser integration): the fixture conversation round-trips
    // through the REAL codex rollout format + the REAL shipped parser
    // (src/core/transcripts/codex.ts) for structural TURN SELECTION — a
    // parser drift that loses user turns now tanks the row visibly. The
    // fragment DELIVERY below remains a harness-shaped contract (disclosed
    // in docs/eval/BRAINBENCH.md); the full production flip is a filed TODO.
    this.parserSelected = await this.parseRollout(fixture);
  }

  /** Synthesize the rollout JSONL and run the shipped parser over it. */
  private async parseRollout(fixture: AdapterFixtureView): Promise<Map<string, number>> {
    this.fixtureSeq += 1;
    const path = join(this.tmpDir!, `rollout-${this.fixtureSeq}.jsonl`);
    const ts = '2026-01-01T00:00:00.000Z';
    const lines: string[] = [
      JSON.stringify({
        timestamp: ts,
        type: 'session_meta',
        payload: { session_id: `brainbench-${fixture.fixture_id}`, cwd: '/', timestamp: ts, cli_version: 'bench' },
      }),
    ];
    for (const t of fixture.turns) {
      if (t.role === 'user') {
        lines.push(
          JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: t.text } }),
        );
      } else {
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.text }] },
          }),
        );
      }
    }
    writeFileSync(path, lines.join('\n') + '\n');
    const selected = new Map<string, number>();
    const gen = codexTranscriptAdapter.parse(path);
    for await (const session of gen) {
      for (const m of session.messages) {
        if (m.role !== 'user') continue;
        const key = m.text.trim();
        selected.set(key, (selected.get(key) ?? 0) + 1);
      }
    }
    return selected;
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
    // Parser-selected turns only (F5): a user turn the shipped rollout
    // parser failed to surface never reaches the fragment pipeline — parser
    // drift shows up as missed retrievals, not as a silently-passing bench.
    const selKey = turn.text.trim();
    const remaining = this.parserSelected.get(selKey) ?? 0;
    if (remaining <= 0) {
      return toTurnResult(null, null, performance.now() - started);
    }
    this.parserSelected.set(selKey, remaining - 1);
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
