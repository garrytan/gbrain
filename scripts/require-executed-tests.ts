#!/usr/bin/env bun
/**
 * Require that a lane's tests all ran and passed (GBRA-135 L6).
 *
 * A key-gated test file self-skips when its provider keys or tools are
 * missing, and `bun test` exits 0 on an all-skip run, so a job that ran
 * nothing reads green. The keyed Tier 2 nightly (e2e.yml `tier2`) runs this
 * after its test step: a keyless run, an all-skip run, a partial skip or a
 * missing JUnit report fails the job instead of passing as coverage.
 *
 * Reads the receipts scripts/run-with-receipt.sh writes
 * (docs/TESTING.md#executed-test-receipts).
 *
 * Usage: bun scripts/require-executed-tests.ts <receipt-dir> <lane>
 * Exit: 0 at least one test ran and every test passed; 1 otherwise; 2 usage.
 */
import { existsSync } from 'node:fs';
import { loadReceiptDir } from './ci-executed-counts.ts';

export function executedProblems(dir: string, lane: string): string[] {
  const receipts = existsSync(dir) ? loadReceiptDir(dir).filter(r => r.lane === lane) : [];
  if (!receipts.length) return [`no ${lane} receipt in ${dir}: the test step did not run`];
  const problems: string[] = [];
  let passed = 0;
  for (const receipt of receipts) {
    if (receipt.junit !== 'ok') problems.push(`${receipt.id}: JUnit report ${receipt.junit}${receipt.junitError ? ` (${receipt.junitError})` : ''}`);
    for (const c of receipt.cases) {
      if (c.status === 'pass') passed++;
      else problems.push(`${c.status}: ${c.file} > ${c.test}`);
    }
  }
  if (passed === 0) problems.unshift(`${lane} ran 0 tests`);
  return problems;
}

if (import.meta.main) {
  const [dir, lane] = process.argv.slice(2);
  if (!dir || !lane) {
    console.error('usage: bun scripts/require-executed-tests.ts <receipt-dir> <lane>');
    process.exit(2);
  }
  const problems = executedProblems(dir, lane);
  if (problems.length) {
    console.error(`::error::${lane}: not every test ran and passed, so this run is not coverage`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`${lane}: every test ran and passed`);
}
