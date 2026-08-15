/**
 * v0.41.26.1 — source-shape behavioral pins for the lock-renewal
 * cathedral wave.
 *
 * These tests grep the actual worker.ts source for the patterns the
 * locked decisions promised. They're not behavioral in the
 * "run-the-code" sense — they're structural-regression guards that
 * fail loud if a future refactor strips a load-bearing piece.
 *
 * Why source-shape pins instead of runtime integration tests:
 * bun:test's serial runner has an unresolved interaction with PGLite
 * + multiple MinionWorker-driven tests in the same file (the second
 * test's queue.add hangs indefinitely). The headline regression (gap
 * H) lives in its own single-test file
 * (test/worker-lock-renewal-e2e.serial.test.ts); A, B, C, E, G are
 * pinned here via source-shape grep.
 *
 * These pins are bug-pattern-specific, not implementation-specific —
 * a future refactor that changes the SHAPE of how each guarantee is
 * provided (e.g., AbortController.signal events → a different
 * notification mechanism) would need to update both the source AND
 * this test, which is the right level of friction. A refactor that
 * accidentally REMOVES the guarantee would fail this test loudly.
 *
 * Companion files:
 *   - test/worker-lock-renewal.test.ts          — pure state machine (18 unit tests)
 *   - test/worker-lock-renewal-e2e.serial.test.ts — H gold-standard E2E (1 test)
 *   - test/audit/lock-renewal-audit.test.ts     — audit primitive (11 tests)
 *   - test/audit/redact-connection-info.test.ts — privacy redactor (15 tests)
 *   - test/audit/batch-retry-redaction.test.ts  — sibling privacy backfill (3 tests)
 *   - test/scripts/check-worker-lock-renewal-shape.test.ts — CI guard meta (5 tests)
 *
 * Coverage map:
 *   - A. launchJob wires runLockRenewalTick  → pinned here + the CI guard
 *   - B. executeJob skip-failJob on infra abort → pinned here
 *   - C. .catch() on stored executeJob.finally promise → pinned here
 *   - D. INFRASTRUCTURE_ABORT_REASONS export → pinned here + pure unit tests
 *   - E. universal grace-evict listener → pinned here
 *   - F. logExecuteJobRejected end-to-end → folded into C pin (call site)
 *   - G. tickInFlight re-entrancy guard → pinned here
 *   - H. gold-standard regression → behavioral E2E (sibling file)
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { INFRASTRUCTURE_ABORT_REASONS } from '../src/core/minions/worker.ts';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const WORKER_PATH = path.join(REPO_ROOT, 'src/core/minions/worker.ts');

// Read once at module load — failure to find the file is a strong signal
// the test file was moved without updating the path.
let workerSource: string;
try {
  workerSource = fs.readFileSync(WORKER_PATH, 'utf8');
} catch (err) {
  throw new Error(`Cannot read ${WORKER_PATH}: ${(err as Error).message}`);
}

// Helper: scope text to a single function body. Looks for `private launchJob(`
// (or whatever signature) and returns everything from that line to the next
// top-level `}` (heuristic — works for the project's bracing style).
function extractFunctionBody(source: string, signatureMarker: string): string {
  const startIdx = source.indexOf(signatureMarker);
  if (startIdx === -1) {
    throw new Error(`Marker not found: ${signatureMarker}`);
  }
  // Find the opening brace of the function body.
  const braceIdx = source.indexOf('{', startIdx);
  if (braceIdx === -1) {
    throw new Error(`No opening brace after marker: ${signatureMarker}`);
  }
  // Walk forward counting braces.
  let depth = 1;
  let i = braceIdx + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
    if (depth === 0) break;
  }
  return source.slice(braceIdx, i);
}

// =============================================================================
// D — INFRASTRUCTURE_ABORT_REASONS export contract (also covered in pure tests)
// =============================================================================

describe('D: INFRASTRUCTURE_ABORT_REASONS export contract', () => {
  test('exported Set contains exactly lock-renewal-failed + lock-lost', () => {
    // Named-constant regression: any change to this set is a deliberate
    // two-line edit (the constant + this test).
    expect(INFRASTRUCTURE_ABORT_REASONS).toBeInstanceOf(Set);
    expect(INFRASTRUCTURE_ABORT_REASONS.size).toBe(2);
    expect(INFRASTRUCTURE_ABORT_REASONS.has('lock-renewal-failed')).toBe(true);
    expect(INFRASTRUCTURE_ABORT_REASONS.has('lock-lost')).toBe(true);
  });

  test('source exports the constant (so executeJob.catch can import it)', () => {
    // Without the `export const` shape, executeJob's infrastructure-
    // abort guard can't reach the set; the import would fail at compile
    // time but pinning the export site here documents the contract.
    expect(workerSource).toMatch(/export const INFRASTRUCTURE_ABORT_REASONS/);
  });
});

// =============================================================================
// A — launchJob wires runLockRenewalTick
// =============================================================================

describe('A: launchJob wires the pure tick function', () => {
  let launchJobBody: string;
  test('extracts launchJob function body for further assertions', () => {
    launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    expect(launchJobBody.length).toBeGreaterThan(0);
  });

  test('launchJob calls runLockRenewalTick (the extracted pure function)', () => {
    expect(launchJobBody).toMatch(/runLockRenewalTick\s*\(/);
  });

  test('launchJob constructs the LockRenewalState via the documented helper', () => {
    // resolveLockRenewalKnobs reads the env knobs (D2). If it disappears
    // from launchJob, operators can't tune via env vars.
    expect(launchJobBody).toMatch(/resolveLockRenewalKnobs\s*\(/);
  });

  test('launchJob uses the lockRenewalAudit sink (not a fake / inline)', () => {
    expect(launchJobBody).toMatch(/lockRenewalAudit/);
  });
});

// =============================================================================
// G — tickInFlight re-entrancy guard at the worker layer
// =============================================================================

describe('G: tickInFlight re-entrancy guard', () => {
  test('launchJob declares the tickInFlight flag', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    expect(launchJobBody).toMatch(/let\s+tickInFlight\s*=\s*false/);
  });

  test('the setInterval callback checks tickInFlight and bails on re-entry', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    // The pattern is `if (tickInFlight) return;` — minor whitespace
    // variation tolerated.
    expect(launchJobBody).toMatch(/if\s*\(\s*tickInFlight\s*\)\s*return/);
  });

  test('the setInterval callback sets tickInFlight=true before scheduling work', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    expect(launchJobBody).toMatch(/tickInFlight\s*=\s*true/);
  });

  test('the post-tick finally clears tickInFlight back to false', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    expect(launchJobBody).toMatch(/tickInFlight\s*=\s*false/);
  });
});

// =============================================================================
// C + F — .catch() on stored executeJob.finally promise +
//         logExecuteJobRejected end-to-end via the catch
// =============================================================================

describe('C + F: .catch() on stored executeJob promise + logExecuteJobRejected', () => {
  test('the stored executeJob promise has a .catch() handler', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    // The pattern is `.executeJob(...).finally(...).catch(...)` — the
    // catch closes the SECOND unhandledRejection vector codex caught.
    // Match any `.catch(` after `.finally(` within launchJob's body.
    const finallyIdx = launchJobBody.indexOf('.finally(');
    expect(finallyIdx).toBeGreaterThan(-1);
    // Search for .catch( after the .finally(
    const tail = launchJobBody.slice(finallyIdx);
    expect(tail).toMatch(/\.catch\s*\(/);
  });

  test('the .catch() handler calls lockRenewalAudit.logExecuteJobRejected', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    expect(launchJobBody).toMatch(/logExecuteJobRejected\s*\(/);
  });

  test('the .catch() handler also logs to stderr (operator visibility)', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    // The implementation uses console.error for the human-visible trail.
    // Pin the call so a future refactor that drops it leaves the operator
    // with audit JSONL only (which is harder to grep live during an
    // incident).
    expect(launchJobBody).toMatch(/console\.error[^)]*executeJob unhandled/);
  });
});

// =============================================================================
// E — Universal grace-evict listener fires on any abort reason
// =============================================================================

describe('E: universal grace-evict listener (D8b)', () => {
  test('launchJob registers an abort.signal.addEventListener for grace-evict', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    // The pre-v0.41.26.1 form lived inside `if (job.timeout_ms != null)`.
    // Now it's at launchJob top level and listens to the abort signal
    // directly. Pin the listener registration.
    expect(launchJobBody).toMatch(/abort\.signal\.addEventListener\s*\(\s*['"]abort['"]/);
  });

  test('the grace-evict path consults INFRASTRUCTURE_ABORT_REASONS before failJob', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    // The infrastructure-reason guard ensures lock-renewal aborts don't
    // burn job attempts even if the handler is still wedged at the 30s
    // force-evict deadline.
    expect(launchJobBody).toMatch(/INFRASTRUCTURE_ABORT_REASONS/);
  });

  test('the 30s grace timer fires for any abort, not just timeout_ms', () => {
    const launchJobBody = extractFunctionBody(workerSource, 'private launchJob(');
    // The 30_000 literal must appear OUTSIDE the `if (job.timeout_ms != null)`
    // branch. Check the addEventListener block contains the 30_000 literal.
    // Find the addEventListener and look in its function body.
    const listenerIdx = launchJobBody.indexOf("abort.signal.addEventListener('abort'");
    expect(listenerIdx).toBeGreaterThan(-1);
    // Grab ~1500 chars after the listener to capture its body.
    const listenerWindow = launchJobBody.slice(listenerIdx, listenerIdx + 1500);
    expect(listenerWindow).toMatch(/30_000|30000/);
  });
});

// =============================================================================
// B — executeJob skips failJob on infrastructure aborts
// =============================================================================

describe('B: executeJob skip-failJob on infrastructure abort (D8a)', () => {
  test('executeJob detects the infrastructure abort reason and returns early', () => {
    const executeJobBody = extractFunctionBody(workerSource, 'private async executeJob(');
    // The skip-failJob branch checks abort.signal.reason against
    // INFRASTRUCTURE_ABORT_REASONS and returns BEFORE the failJob call
    // path. Pin both the constant reference AND the early-return shape.
    expect(executeJobBody).toMatch(/INFRASTRUCTURE_ABORT_REASONS\.has/);
    // The return-early shape: after the INFRASTRUCTURE_ABORT_REASONS
    // check there must be a `return;` to skip the rest of catch.
    // Pin the structural shape by locating the check + finding `return;`
    // within ~500 chars after.
    const idx = executeJobBody.indexOf('INFRASTRUCTURE_ABORT_REASONS.has');
    expect(idx).toBeGreaterThan(-1);
    const window = executeJobBody.slice(idx, idx + 500);
    expect(window).toMatch(/return\s*;/);
  });

  test('executeJob still calls failJob for non-infrastructure errors', () => {
    const executeJobBody = extractFunctionBody(workerSource, 'private async executeJob(');
    // Regression guard for the negative side: a future refactor that
    // accidentally removes failJob entirely would make handler defects
    // silently disappear. Pin that failJob remains in the catch path.
    expect(executeJobBody).toMatch(/this\.queue\.failJob\s*\(/);
  });
});
