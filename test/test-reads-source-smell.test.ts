/**
 * #3665 — source-text-assertion smell gate.
 *
 * A test whose assertions run over `readFileSync`'d src/ TEXT pins spelling,
 * not behavior: it keeps passing when the behavior breaks in a way that
 * preserves the grepped token, and it breaks when a harmless rename lands.
 * Sometimes that is exactly the right tool (structural guards over generated
 * files, comment-contract pins, guards for code that cannot run in a unit
 * test) — but it must be a deliberate choice, not the default.
 *
 * Rule: a line in a test file that readFileSync's a literal src/ path needs a
 * `test-reads-source-ok: <why>` comment on the line or within the 3 lines
 * above. Files that predate the rule are in FROZEN_ALLOWLIST below; the list
 * must only SHRINK (stale entries fail the suite so pruning is forced).
 *
 * Limitation (documented): only literal same-line `src/` paths are caught —
 * a path built from variables slips through. That keeps false positives at
 * zero, which is what lets this run in CI at all.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const TEST_DIR = import.meta.dir;

/** Same-line literal read into src/ (or ../src/, or a URL/join ending there). */
const READS_SRC = /readFileSync[^;\n]*['"`(/][^;\n]*\bsrc\//;
const MARKER = 'test-reads-source-ok';

/**
 * Files with unannotated src-text reads that predate the rule. FROZEN:
 * never add an entry — annotate the read with `test-reads-source-ok: <why>`
 * (or assert runtime behavior instead). Prune entries as files get cleaned;
 * a stale entry fails the suite.
 */
const FROZEN_ALLOWLIST = new Set([
  'admin-sse-eventsource.test.ts',
  'agent-register.test.ts',
  'apply-migrations.test.ts',
  'archived-source-scoping.test.ts',
  'autopilot-auto-drain-wiring.test.ts',
  'autopilot-install.test.ts',
  'autopilot-pause-marker.test.ts',
  'autopilot-self-upgrade.test.ts',
  'backlinks-job-default.test.ts',
  'cli-force-exit-teardown-arming.test.ts',
  'cli.test.ts',
  'connection-resilience.test.ts',
  'conversation-facts-type-allowlist-drift.test.ts',
  'cycle-abort.test.ts',
  'cycle-drain-renewal.test.ts',
  'cycle-patterns-deadline-budget.test.ts',
  'destructive-guard.test.ts',
  'doctor-orphan-ratio.test.ts',
  'dream-cli-flags.test.ts',
  'exit-classification.test.ts',
  'extract-atoms-drain.test.ts',
  'fence-extraction.test.ts',
  'fix-wave-structural.test.ts',
  'integrations.test.ts',
  'migrate-stdout-clean.test.ts',
  'migrate.test.ts',
  'migrations-v0_22_4.test.ts',
  'pglite-engine.test.ts',
  'pglite-wal-repair.serial.test.ts',
  'phantom-redirect-per-source-lock.test.ts',
  'register-client-source-normalize.test.ts',
  'regression-strict-source-id.test.ts',
  'reindex-code-recovery.test.ts',
  'schema-cli-contract.test.ts',
  'schema-pack-unify-types-handler.test.ts',
  'scripts/classify-tests.test.ts',
  'serve-http-github-webhook.test.ts',
  'serve-http-mcp-transport-cleanup.test.ts',
  'timing-safe.test.ts',
  'transcription-injection.test.ts',
]);

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* testFiles(p);
    else if (p.endsWith('.test.ts')) yield p;
  }
}

function offendingFiles(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const f of testFiles(TEST_DIR)) {
    const rel = relative(TEST_DIR, f);
    if (rel === 'test-reads-source-smell.test.ts') continue; // this file names the pattern in prose
    const lines = readFileSync(f, 'utf-8').split('\n');
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!READS_SRC.test(lines[i]!)) continue;
      const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (context.includes(MARKER)) continue;
      hits.push(i + 1);
    }
    if (hits.length > 0) out.set(rel, hits);
  }
  return out;
}

describe('#3665 — tests that read src/ text need a justification', () => {
  test('no NEW test file readFileSyncs src/* without a test-reads-source-ok comment', () => {
    const offenders = offendingFiles();
    const fresh = [...offenders.entries()].filter(([rel]) => !FROZEN_ALLOWLIST.has(rel));
    const msg = fresh
      .map(([rel, lines]) => `test/${rel}:${lines.join(',')}`)
      .join('\n');
    expect(
      fresh.map(([rel]) => rel),
      `New source-text reads in tests without justification:\n${msg}\n` +
      `Either assert runtime behavior instead, or add a comment within 3 lines above the read:\n` +
      `  // ${MARKER}: <why grepping source text is the right tool here>\n` +
      `Do NOT add entries to FROZEN_ALLOWLIST — it only shrinks.`,
    ).toEqual([]);
  });

  test('the frozen allowlist only shrinks (stale entries must be pruned)', () => {
    const offenders = offendingFiles();
    const stale = [...FROZEN_ALLOWLIST].filter((rel) => !offenders.has(rel));
    expect(
      stale,
      `Allowlist entries whose files no longer have unannotated src reads (or were deleted) — prune them:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});
