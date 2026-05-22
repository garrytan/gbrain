/**
 * Fail-improve loop: deterministic-first, LLM-fallback pattern.
 *
 * Tries deterministic code first (regex, parser). If it fails, falls back
 * to LLM. Logs every fallback as a JSONL entry for future improvement.
 * Over time, failure patterns reveal which regex rules are missing.
 *
 * Each operation writes to its own JSONL file (~/.gbrain/fail-improve/{operation}.jsonl).
 * Atomic append assumption: individual log entries are <1KB, well under OS page size.
 * No cross-operation file conflicts since each operation has its own file.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { gbrainPath } from './config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureEntry {
  timestamp: string;
  operation: string;
  input: string;
  deterministic_result: string | null;
  llm_result: string | null;
  metadata?: Record<string, any>;
}

export interface FailureAnalysis {
  operation: string;
  total_failures: number;
  failures_by_pattern: Map<string, number>;
  total_improvements: number;
  last_improvement?: string;
  total_calls: number;
  deterministic_hits: number;
  deterministic_rate: number;
}

export interface TestCase {
  name: string;
  input: string;
  expected: string;
  source: 'fail-improve-loop';
}

// Lazy: GBRAIN_HOME may be set after module load, so resolve at call time.
const getLogDir = () => gbrainPath('fail-improve');
const MAX_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// AbortSignal helpers
// ---------------------------------------------------------------------------

/**
 * Construct a DOM-style AbortError. Matches what fetch() throws on
 * AbortController.abort(), so downstream callers that already branch on
 * `err.name === 'AbortError'` work without change.
 */
function makeAbortError(where: string): Error {
  const err = new Error(`Aborted at ${where}`);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' &&
    ('name' in err && (err as { name: string }).name === 'AbortError');
}

// ---------------------------------------------------------------------------
// Core class
// ---------------------------------------------------------------------------

export class FailImproveLoop {
  private logDir: string;

  constructor(logDir?: string) {
    this.logDir = logDir || getLogDir();
  }

  /**
   * Try deterministic first, fall back to LLM, log mismatches.
   * When both fail, throws the LLM error and logs both failures.
   *
   * Optional `opts.signal` threads an AbortSignal through the flow:
   *   - Checked before the deterministic call and again before the LLM call.
   *   - Forwarded to both callbacks as an optional second arg. Existing
   *     callbacks that take only `(input: string)` are structurally compatible
   *     and ignore the extra arg (TypeScript widens on call).
   *   - When aborted, throws an Error with name='AbortError' (standard Web
   *     AbortController semantics). Does not write a failure log entry for
   *     aborted runs since they're not informative.
   */
  async execute<T>(
    operation: string,
    input: string,
    deterministicFn: (input: string, signal?: AbortSignal) => T | null,
    llmFallbackFn: (input: string, signal?: AbortSignal) => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<T> {
    // Pre-flight abort check
    if (opts?.signal?.aborted) throw makeAbortError('fail-improve:before-start');

    // Track call
    this.incrementCallCount(operation, 'total');

    // Try deterministic first
    const deterResult = deterministicFn(input, opts?.signal);
    if (deterResult !== null && deterResult !== undefined) {
      this.incrementCallCount(operation, 'deterministic');
      return deterResult;
    }

    // Abort check between deterministic miss and LLM call
    if (opts?.signal?.aborted) throw makeAbortError('fail-improve:before-fallback');

    // Deterministic failed, try LLM
    let llmResult: T;
    try {
      llmResult = await llmFallbackFn(input, opts?.signal);
    } catch (llmError: any) {
      // Abort propagates unlogged — not a useful failure record
      if (isAbortError(llmError)) throw llmError;

      // Both failed — log both, throw LLM error
      this.logFailure({
        timestamp: new Date().toISOString(),
        operation,
        input: input.slice(0, 1000),
        deterministic_result: null,
        llm_result: `error: ${llmError.message || String(llmError)}`,
        metadata: { cascade_failure: true },
      });
      throw llmError;
    }

    // Log the failure (deterministic failed, LLM succeeded)
    this.logFailure({
      timestamp: new Date().toISOString(),
      operation,
      input: input.slice(0, 1000),
      deterministic_result: null,
      llm_result: JSON.stringify(llmResult).slice(0, 1000),
    });

    return llmResult;
  }

  /** Append a failure entry to the operation's JSONL file. */
  logFailure(entry: FailureEntry): void {
    const filePath = this.getLogPath(entry.operation);
    this.ensureDir(filePath);
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(filePath, line, 'utf-8');
    this.rotateIfNeeded(entry.operation);
  }

  /** Read all failures for an operation. */
  getFailures(operation: string): FailureEntry[] {
    const filePath = this.getLogPath(operation);
    if (!existsSync(filePath)) return [];
    try {
      return readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); }
          catch { return null; }
        })
        .filter(Boolean) as FailureEntry[];
    } catch {
      return [];
    }
  }

  /** Group failures by a key derived from the input (first 50 chars). */
  getFailuresByPattern(operation: string): Map<string, FailureEntry[]> {
    const failures = this.getFailures(operation);
    const groups = new Map<string, FailureEntry[]>();
    for (const f of failures) {
      const key = f.input.slice(0, 50).replace(/\s+/g, ' ').trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    return groups;
  }

  /** Analyze failures and compute metrics. */
  analyzeFailures(operation: string): FailureAnalysis {
    const failures = this.getFailures(operation);
    const patterns = this.getFailuresByPattern(operation);
    const stats = this.getCallCounts(operation);
    const improvements = this.getImprovements(operation);

    return {
      operation,
      total_failures: failures.length,
      failures_by_pattern: new Map([...patterns.entries()].map(([k, v]) => [k, v.length])),
      total_improvements: improvements.length,
      last_improvement: improvements.length > 0 ? improvements[improvements.length - 1].timestamp : undefined,
      total_calls: stats.total,
      deterministic_hits: stats.deterministic,
      deterministic_rate: stats.total > 0 ? stats.deterministic / stats.total : 0,
    };
  }

  /** Generate test cases from failure logs where LLM produced good results. */
  generateTestCases(operation: string): TestCase[] {
    const failures = this.getFailures(operation);
    return failures
      .filter(f => f.llm_result && !f.llm_result.startsWith('error:') && !f.metadata?.cascade_failure)
      .map((f, i) => ({
        name: `auto_${operation}_${i + 1}`,
        input: f.input,
        expected: f.llm_result!,
        source: 'fail-improve-loop' as const,
      }));
  }

  /** Log an improvement (when a new deterministic pattern is added). */
  logImprovement(operation: string, description: string): void {
    const filePath = join(this.logDir, operation, 'improvements.json');
    this.ensureDir(filePath);
    let improvements: any[] = [];
    if (existsSync(filePath)) {
      try { improvements = JSON.parse(readFileSync(filePath, 'utf-8')); } catch {}
    }
    improvements.push({ timestamp: new Date().toISOString(), description });
    writeFileSync(filePath, JSON.stringify(improvements, null, 2), 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getLogPath(operation: string): string {
    return join(this.logDir, `${operation}.jsonl`);
  }

  private getCallCountPath(operation: string): string {
    return join(this.logDir, `${operation}.counts.json`);
  }

  private ensureDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private incrementCallCount(operation: string, type: 'total' | 'deterministic'): void {
    const filePath = this.getCallCountPath(operation);
    this.ensureDir(filePath);
    let counts = { total: 0, deterministic: 0 };
    if (existsSync(filePath)) {
      try { counts = JSON.parse(readFileSync(filePath, 'utf-8')); } catch {}
    }
    counts[type]++;
    writeFileSync(filePath, JSON.stringify(counts), 'utf-8');
  }

  private getCallCounts(operation: string): { total: number; deterministic: number } {
    const filePath = this.getCallCountPath(operation);
    if (!existsSync(filePath)) return { total: 0, deterministic: 0 };
    try { return JSON.parse(readFileSync(filePath, 'utf-8')); }
    catch { return { total: 0, deterministic: 0 }; }
  }

  private getImprovements(operation: string): Array<{ timestamp: string; description: string }> {
    const filePath = join(this.logDir, operation, 'improvements.json');
    if (!existsSync(filePath)) return [];
    try { return JSON.parse(readFileSync(filePath, 'utf-8')); }
    catch { return []; }
  }

  private rotateIfNeeded(operation: string): void {
    const filePath = this.getLogPath(operation);
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_ENTRIES) {
      // Keep last MAX_ENTRIES entries
      const kept = lines.slice(-MAX_ENTRIES);
      writeFileSync(filePath, kept.join('\n') + '\n', 'utf-8');
    }
  }
}
