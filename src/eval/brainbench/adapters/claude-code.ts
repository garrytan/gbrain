/**
 * BrainBench Claude Code adapter — seam: 'contract'.
 *
 * Defines the UserPromptSubmit hook contract a future integration PR
 * implements, and grades gbrain's memory primitives through it. The exported
 * wire types are THE contract: the real hook script will read
 * `UserPromptSubmitHookInput` JSON on stdin and write
 * `UserPromptSubmitHookOutput` JSON on stdout, so the bench is test-first for
 * the integration — when the real hook lands, this adapter swaps its in-process
 * transport for an exec of the hook script and flips seam to 'production' with
 * continuous bench numbers.
 *
 * Contract deltas vs the openclaw seam (the deltas ARE what the row measures):
 *   - NO conversation memory: a hook sees only the current prompt, so
 *     prior-context suppression is off → expect a higher re-injection rate.
 *   - Smaller injection budget (2 pointers): hooks compete with everything
 *     else feeding additionalContext.
 *
 * Every turn round-trips through JSON.stringify/parse of the wire shapes so a
 * contract-breaking change fails loudly here, not in a future integration.
 */

import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import type {
  AdapterFixtureView,
  HarnessAdapter,
  HarnessTurnResult,
  PublicTurn,
} from '../types.ts';
import { runReflexPipeline, toTurnResult } from './shared.ts';

/** stdin JSON the real UserPromptSubmit hook will receive. */
export interface UserPromptSubmitHookInput {
  prompt: string;
  session_id: string;
  cwd: string;
}

/** stdout JSON the real UserPromptSubmit hook will emit. */
export interface UserPromptSubmitHookOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export const CLAUDE_CODE_MAX_POINTERS = 2;

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = 'claude-code' as const;
  readonly seam = 'contract' as const;

  private engine: PGLiteEngine | null = null;
  private sourceId = 'default';
  private sessionId = '';

  async beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void> {
    this.engine = engine;
    this.sourceId = fixture.active_source;
    this.sessionId = `brainbench-${fixture.fixture_id}`;
  }

  async replayTurn(turn: PublicTurn, _priorContextText: string): Promise<HarnessTurnResult> {
    if (!this.engine) throw new Error('claude-code adapter: beginConversation not called');
    const started = performance.now();

    // Serialize to the hook's stdin wire shape, then parse back — the
    // contract boundary is exercised on every turn.
    const wireIn: UserPromptSubmitHookInput = {
      prompt: turn.text,
      session_id: this.sessionId,
      cwd: '/',
    };
    const parsedIn = JSON.parse(JSON.stringify(wireIn)) as UserPromptSubmitHookInput;

    const block = await runReflexPipeline(
      this.engine,
      this.sourceId,
      { ...turn, text: parsedIn.prompt },
      '', // a hook has no prior-turn memory — deliberate contract delta
      { maxPointers: CLAUDE_CODE_MAX_POINTERS, suppression: 'none' },
    );

    const wireOut: UserPromptSubmitHookOutput = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: block?.text ?? '',
      },
    };
    const parsedOut = JSON.parse(JSON.stringify(wireOut)) as UserPromptSubmitHookOutput;
    const injected = parsedOut.hookSpecificOutput.additionalContext || null;

    const latencyMs = performance.now() - started;
    return toTurnResult(block, injected, latencyMs);
  }

  async endConversation(): Promise<void> {
    this.engine = null;
  }
}
