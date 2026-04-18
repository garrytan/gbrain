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
import { homedir } from 'os';

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

const LOG_DIR = join(homedir(), '.gbrain', 'fail-improve');
const MAX_ENTRIES = 1000;

// Operation names are used verbatim as path segments under LOG_DIR. Every
// caller in-tree passes a hard-coded identifier like "extract_mrr", but
// FailImproveLoop is exported and the signature takes `string`, so nothing
// at the type level prevents a future caller from forwarding a user-
// supplied value. Reject anything that could escape LOG_DIR or change the
// directory layout: path separators, `..`, null bytes, leading dots,
// absolute paths.
//
// The charset uses Unicode categories so non-ASCII scripts — CJK,
// Cyrillic, Arabic, Hebrew, Devanagari, Latin-extended like ñ — work out
// of the box. This matters for callers that derive operation names from
// entity pages, recipe titles, or user labels in languages other than
// English.
//
//   \p{L} — letter (any script)
//   \p{N} — number (any script)
//   \p{M} — combining mark. Required for scripts where vocalization /
//           diacritics are separate code points (Arabic fatha/shadda,
//           Hebrew niqqud, Devanagari matras, Thai tone marks).
//
// Explicitly NOT allowed: \p{Z} whitespace, \p{P} punctuation (other than
// '_' and '-'), \p{C} control + format characters (U+202E RTL override,
// U+200C/D ZW[N]J, U+0000 NUL — these would enable spoofing or break the
// filesystem). The /u flag is required for \p{…} to be recognised.
const VALID_OPERATION = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]{0,63}$/u;

function assertSafeOperation(operation: string): void {
  if (typeof operation !== 'string' || !VALID_OPERATION.test(operation)) {
    throw new Error(
      `FailImproveLoop: invalid operation name '${operation}'. ` +
      `Must be 1-64 characters, starting with a Unicode letter or digit, ` +
      `containing only letters, digits, '_' or '-'. No path separators, ` +
      `no parent-dir segments, no leading dot, no whitespace.`
    );
  }
}

// ---------------------------------------------------------------------------
// Core class
// ---------------------------------------------------------------------------

export class FailImproveLoop {
  private logDir: string;

  constructor(logDir?: string) {
    this.logDir = logDir || LOG_DIR;
  }

  /**
   * Try deterministic first, fall back to LLM, log mismatches.
   * When both fail, throws the LLM error and logs both failures.
   */
  async execute<T>(
    operation: string,
    input: string,
    deterministicFn: (input: string) => T | null,
    llmFallbackFn: (input: string) => Promise<T>,
  ): Promise<T> {
    // Track call
    this.incrementCallCount(operation, 'total');

    // Try deterministic first
    const deterResult = deterministicFn(input);
    if (deterResult !== null && deterResult !== undefined) {
      this.incrementCallCount(operation, 'deterministic');
      return deterResult;
    }

    // Deterministic failed, try LLM
    let llmResult: T;
    try {
      llmResult = await llmFallbackFn(input);
    } catch (llmError: any) {
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
    assertSafeOperation(operation);
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
    assertSafeOperation(operation);
    return join(this.logDir, `${operation}.jsonl`);
  }

  private getCallCountPath(operation: string): string {
    assertSafeOperation(operation);
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
    assertSafeOperation(operation);
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
