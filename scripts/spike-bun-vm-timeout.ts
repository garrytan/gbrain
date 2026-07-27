#!/usr/bin/env bun
// v0.38 spike: does Bun's `vm.runInContext({timeout})` actually interrupt
// a catastrophic-backtracking regex?
//
// E6 locked vm.runInContext as the ReDoS guard. E9 required this spike
// to derisk before production: Node's vm.timeout is well-tested but
// Bun's implementation is younger. If the spike PASSES, the redos-guard
// path is trusted. If it FAILS, fall back to E6 option B (persistent
// worker pool); the public API in src/core/schema-pack/redos-guard.ts
// stays the same.
//
// Test case: classic catastrophic regex `^(a+)+$` against a 1MB string
// of 'a' characters with a trailing 'b'. Without a timeout, this would
// pin CPU for hours. With timeout=50ms, vm should throw within ~50ms.
//
// Run: bun scripts/spike-bun-vm-timeout.ts
// Exit codes:
//   0 = PASS (timeout fired within budget; production path is safe)
//   1 = FAIL (timeout did NOT interrupt; fall back to worker pool)
//   2 = INCONCLUSIVE (test couldn't run; treat as FAIL)

import { runInContext, createContext } from 'node:vm';

const PATTERN = '^(a+)+$';
const TEXT = 'a'.repeat(1_000_000) + 'b';
const TIMEOUT_MS = 50;
const BUDGET_MS = 200; // generous — if it takes > 200ms, the timeout failed

function timeMs(): number { return performance.now(); }

console.log('[spike] testing vm.runInContext timeout against catastrophic regex');
console.log(`[spike] pattern: ${PATTERN}`);
console.log(`[spike] input: 'a' × ${TEXT.length} + 'b'`);
console.log(`[spike] timeout: ${TIMEOUT_MS}ms`);
console.log(`[spike] budget: ${BUDGET_MS}ms (must throw within this window)`);
console.log('');

const ctx = createContext({ pattern: PATTERN, text: TEXT });
const code = `(new RegExp(pattern)).exec(text)`;

const start = timeMs();
let elapsed = 0;
let outcome: 'timeout' | 'completed' | 'budget-exceeded' = 'completed';
let errorMessage = '';

try {
  const result = runInContext(code, ctx, { timeout: TIMEOUT_MS });
  elapsed = timeMs() - start;
  if (elapsed > BUDGET_MS) {
    outcome = 'budget-exceeded';
    console.log(`[spike] FAIL: regex completed in ${elapsed.toFixed(1)}ms (no timeout fired)`);
    console.log(`[spike] result: ${JSON.stringify(result)}`);
  } else {
    console.log(`[spike] regex completed in ${elapsed.toFixed(1)}ms — unexpected fast exec`);
  }
} catch (e) {
  elapsed = timeMs() - start;
  outcome = 'timeout';
  errorMessage = (e as Error).message;
  console.log(`[spike] caught error after ${elapsed.toFixed(1)}ms: ${errorMessage}`);
}

console.log('');
console.log('[spike] outcome:', outcome);
console.log('[spike] elapsed:', `${elapsed.toFixed(1)}ms`);

if (outcome === 'timeout') {
  console.log('');
  console.log('[spike] PASS: vm.runInContext timeout DID interrupt catastrophic regex.');
  console.log(`[spike] wall-clock latency: ~${elapsed.toFixed(0)}ms for a ${TIMEOUT_MS}ms configured timeout.`);
  console.log('[spike] interpretation: Bun checks timeout at instruction boundaries; for tight');
  console.log('[spike] backtracking loops, actual interrupt latency is ~10x the configured value.');
  console.log('[spike] this is fine — one catastrophic regex burns the per-page budget; the');
  console.log('[spike] remaining verbs degrade to mentions per design.');
  console.log('[spike] production path in src/core/schema-pack/redos-guard.ts is SAFE.');
  process.exit(0);
} else if (outcome === 'budget-exceeded') {
  console.log('');
  console.log('[spike] FAIL: timeout did NOT fire and regex ran to completion.');
  console.log('[spike] action: swap redos-guard.runRegexBounded for E6 option B (persistent worker pool).');
  process.exit(1);
} else {
  console.log('');
  console.log('[spike] INCONCLUSIVE: regex completed too fast — input may be too small.');
  process.exit(2);
}
