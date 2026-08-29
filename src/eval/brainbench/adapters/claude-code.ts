/**
 * BrainBench Claude Code adapter — seam: 'production' (v0.46.15, TODOS:556 P1).
 *
 * Drives the REAL shipped integration end-to-end: the fixture turn becomes
 * `UserPromptSubmit` hook stdin JSON, `runHook(['user-prompt'], io)` executes
 * the production hook (stdin parse → transcript-window parse → IPC
 * turn_context → additionalContext), and a run-scoped resolve-IPC server —
 * the SAME `startResolveIpcServer` + `assembleTurnContext` pair `gbrain
 * serve` registers — answers over a real unix socket with the real shared
 * secret. What used to be an in-process contract simulation is now the
 * shipped wire, transcript window, cross-turn dedupe, and IPC auth path.
 *
 * Production-fidelity notes:
 *   - The transcript for each turn is synthesized in the Claude Code JSONL
 *     shape (prior turns + our OWN previously-injected blocks as
 *     `hook_additional_context` attachments), so the hook's 4-turn window
 *     and cross-turn dedupe are exercised for real — the old contract row's
 *     `suppression: 'none'` re-injection cost is replaced by the shipped
 *     dedupe behavior.
 *   - `HookIo.configOverride` + `disablePushBanner` are documented TEST
 *     SEAMS: they point the hook at the bench brain without mutating
 *     process-global GBRAIN_HOME (parallel-test safe) and keep the
 *     operator's push-status files out of the measurement.
 *   - `userPromptDeadlineMs` is pinned generous (10s): the production 800ms
 *     deadline on a loaded CI runner would read as intermittent know-to-ask
 *     misses (flake, not signal). Deadline behavior itself is hook-suite
 *     territory (test/hook-user-prompt.test.ts).
 *   - injectedSlugs = the `→ \`slug\`` references in the rendered block
 *     (reflex pointers + volunteered pages — both are per-turn injection
 *     decisions). Hot-fact entity refs (`[slug]`) are deliberately NOT
 *     counted: hot memory fires on every turn regardless of the prompt, so
 *     counting it would saturate false_fire with a signal the know-to-ask
 *     metric doesn't own.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import type { GBrainConfig } from '../../../core/config.ts';
import { runHook } from '../../../commands/hook.ts';
import {
  ensureIpcSecret,
  resolveSocketPath,
  startResolveIpcServer,
} from '../../../core/context/resolve-ipc.ts';
import { assembleTurnContext } from '../../../core/context/turn-context.ts';
import { resolveEntitiesToPointers } from '../../../core/context/retrieval-reflex.ts';
import type {
  AdapterFixtureView,
  HarnessAdapter,
  HarnessTurnResult,
  PublicTurn,
} from '../types.ts';
import { estimateTokens } from './shared.ts';

/** stdin JSON the real UserPromptSubmit hook receives. */
export interface UserPromptSubmitHookInput {
  prompt: string;
  session_id: string;
  cwd: string;
  transcript_path?: string;
}

/** stdout JSON the real UserPromptSubmit hook emits. */
export interface UserPromptSubmitHookOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

/**
 * Kept for scoreboard continuity: the production hook path has no per-seam
 * pointer budget knob (the server's DEFAULT_MAX_POINTERS governs); this
 * constant now only documents the historical contract-row budget.
 */
export const CLAUDE_CODE_MAX_POINTERS = 2;

/** Generous bench deadline — see the header's flake-class note. */
export const BENCH_USER_PROMPT_DEADLINE_MS = 10_000;

/** `→ \`slug\`` references in a rendered block (pointers + volunteered). */
const INJECTED_SLUG_RE = /→ `([^`\n]+)`/g;

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = 'claude-code' as const;
  readonly seam = 'production' as const;

  private engine: PGLiteEngine | null = null;
  private sourceId = 'default';
  private sessionId = '';
  private fixtureSeq = 0;

  // ── run-scoped state (setupRun/teardownRun own the server + temp home) ──
  private tmpHome: string | null = null;
  private transcriptRoot: string | null = null;
  private server: Server | null = null;
  private dbPath = '';
  private secret = '';

  // ── per-conversation state ──
  private turns: PublicTurn[] = [];
  private injectionByTurnId = new Map<number, string>();

  async setupRun(): Promise<void> {
    this.tmpHome = mkdtempSync(join(tmpdir(), 'brainbench-cc-'));
    this.transcriptRoot = join(this.tmpHome, 'projects');
    mkdirSync(this.transcriptRoot, { recursive: true });
    // database_path is the IPC data dir: socket + secret live beside it,
    // exactly where the hook's resolveSocketPath/readIpcSecret look.
    this.dbPath = join(this.tmpHome, 'brain.pglite');
    mkdirSync(this.dbPath, { recursive: true });
    this.secret = ensureIpcSecret(this.dbPath);
    this.server = await startResolveIpcServer(
      resolveSocketPath(this.dbPath),
      {
        // The resolve kind mirrors the serve wiring; the hook lane uses
        // turn_context, but a v1 client probing the socket must not crash it.
        // Null-engine guards (adversarial F13b): endConversation nulls the
        // engine while the socket server stays up for the next fixture — a
        // deadline-abandoned in-flight request must degrade to empty, not
        // crash the server on `this.engine!`.
        resolve: (req) =>
          this.engine
            ? resolveEntitiesToPointers(this.engine, this.sourceId, req.candidates ?? [], {
                priorContextText: req.priorContextText,
                maxPointers: req.maxPointers,
                suppression: req.suppression,
                lexicalArms: req.lexicalArms,
              })
            : Promise.resolve(null),
        // The SAME handler shape gbrain serve registers (mcp/server.ts):
        // always assembles against the adapter's active source.
        turn_context: (req) =>
          this.engine
            ? assembleTurnContext(this.engine, {
                sourceId: this.sourceId,
                window: req.window ?? [],
                priorContextText: req.priorContextText,
                sessionId: req.sessionId,
                maxBytes: req.maxBytes,
              })
            : Promise.resolve(null),
      },
      { secret: this.secret },
    );
    if (!this.server) {
      throw new Error('claude-code adapter: could not start the resolve IPC server');
    }
  }

  async teardownRun(): Promise<void> {
    if (this.server) {
      await new Promise<void>((res) => this.server!.close(() => res()));
      this.server = null;
    }
    if (this.tmpHome) {
      rmSync(this.tmpHome, { recursive: true, force: true });
      this.tmpHome = null;
    }
  }

  async beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void> {
    if (!this.server) {
      // Legacy single-fixture construction (tests) — own the run lifecycle.
      await this.setupRun();
    }
    this.engine = engine;
    this.sourceId = fixture.active_source;
    this.fixtureSeq += 1;
    this.sessionId = `brainbench-${fixture.fixture_id}-${this.fixtureSeq}`;
    this.turns = fixture.turns;
    this.injectionByTurnId = new Map();
  }

  /**
   * Synthesize the session transcript in the Claude Code JSONL shape: every
   * fixture turn BEFORE the one being replayed (user AND assistant — the
   * harness only replays user turns, but the shipped 4-turn window sees
   * both), with our own prior injections recorded as
   * hook_additional_context attachments right after their user turn.
   */
  private writeTranscript(beforeTurnId: number): string {
    const path = join(this.transcriptRoot!, `${this.sessionId}.jsonl`);
    let body = '';
    for (const t of this.turns) {
      if (t.turn_id >= beforeTurnId) break;
      body += JSON.stringify({ type: t.role, message: { role: t.role, content: t.text } }) + '\n';
      const injected = this.injectionByTurnId.get(t.turn_id);
      if (injected) {
        body += JSON.stringify({
          type: 'attachment',
          attachment: { type: 'hook_additional_context', content: [injected] },
        }) + '\n';
      }
    }
    writeFileSync(path, body);
    return path;
  }

  async replayTurn(turn: PublicTurn, _priorContextText: string): Promise<HarnessTurnResult> {
    if (!this.engine || !this.tmpHome) {
      throw new Error('claude-code adapter: beginConversation not called');
    }
    const started = performance.now();

    const transcriptPath = this.writeTranscript(turn.turn_id);
    const wireIn: UserPromptSubmitHookInput = {
      prompt: turn.role === 'user' ? turn.text : '',
      session_id: this.sessionId,
      cwd: this.tmpHome,
      transcript_path: transcriptPath,
    };

    let stdout = '';
    const cfg = { engine: 'pglite', database_path: this.dbPath } as GBrainConfig;
    const exit = await runHook(['user-prompt'], {
      stdin: JSON.stringify(wireIn),
      write: (s) => {
        stdout += s;
      },
      cwd: this.tmpHome,
      transcriptRoot: this.transcriptRoot!,
      userPromptDeadlineMs: BENCH_USER_PROMPT_DEADLINE_MS,
      configOverride: cfg,
      disablePushBanner: true,
      // Telemetry paths resolve from GBRAIN_HOME/homedir, not configOverride
      // — without this, every fixture turn appends to the OPERATOR's real
      // hook heartbeat history (codex ship-review).
      disableTelemetry: true,
    });
    if (exit !== 0) {
      // The hook is fail-open by design (exit 0 on degraded paths); a nonzero
      // exit is a harness bug — fail loud, not as a silent know-to-ask miss.
      throw new Error(`claude-code adapter: hook exit ${exit}`);
    }

    let injected: string | null = null;
    if (stdout.trim()) {
      const parsed = JSON.parse(stdout) as UserPromptSubmitHookOutput;
      injected = parsed.hookSpecificOutput?.additionalContext || null;
    }

    const injectedSlugs: string[] = [];
    if (injected) {
      for (const m of injected.matchAll(INJECTED_SLUG_RE)) {
        if (!injectedSlugs.includes(m[1])) injectedSlugs.push(m[1]);
      }
    }

    const latencyMs = performance.now() - started;
    // Feed the shipped cross-turn dedupe: what we injected THIS turn appears
    // in later turns' transcripts as a hook_additional_context attachment.
    if (injected) this.injectionByTurnId.set(turn.turn_id, injected);

    return {
      injectedText: injected,
      injectedSlugs,
      // The production wire carries rendered text, not pointer objects —
      // metrics score injectedSlugs; receipts show the wire text.
      pointers: [],
      injectedTokens: estimateTokens(injected),
      latencyMs,
    };
  }

  async endConversation(): Promise<void> {
    this.engine = null;
    this.turns = [];
    this.injectionByTurnId = new Map();
  }
}
