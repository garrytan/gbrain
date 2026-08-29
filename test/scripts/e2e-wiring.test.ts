/**
 * G1 (test-gap wave 1) — CI e2e lane wiring pins.
 *
 * Structural guards over .github/workflows/e2e.yml + scripts/e2e-test-map.ts:
 *   1. The selected-e2e job exists, consumes scripts/select-e2e.ts in its
 *      default file-selection mode, and NOTHING masks the selector's exit
 *      code (exit 2 = git failure must fail the job — fail-loud).
 *   2. Both aggregation consumers (e2e-cache-write, e2e-status) carry the
 *      job in `needs` — a red selected lane can neither seal the content-
 *      hash cache marker nor report E2E green.
 *   3. The job passes NO live provider keys, so it is fork-runnable by
 *      construction (service Postgres only) and can never spend tokens.
 *   4. The job's checkout fetches real history (select-e2e diffs
 *      origin/master...HEAD).
 *   5. Every workflow-side EXCLUDE entry is honest: either a file a named
 *      job in this same workflow already runs, or a live-key token spender.
 *   6. Unmapped-file ratchet: every test/e2e/*.test.ts is mapped in
 *      E2E_TEST_MAP, named in the workflow, or grandfathered in
 *      test/fixtures/e2e-unmapped-baseline.txt (shrink-only). A NEW e2e
 *      file must be mapped (preferred) or consciously baselined. The
 *      baseline itself is enforced both ways: a row naming a deleted file
 *      is stale (remove the line), a row that E2E_TEST_MAP or the workflow
 *      already claims is redundant (remove the line), and total length may
 *      never grow past the seeded literal.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_TEST_MAP } from '../../scripts/e2e-test-map.ts';

const repoRoot = join(import.meta.dir, '..', '..');
const yml = readFileSync(join(repoRoot, '.github/workflows/e2e.yml'), 'utf8');

/** Slice one top-level job block out of the workflow (2-space-indented keys). */
function jobBlock(name: string): string {
  const start = yml.indexOf(`\n  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = yml.slice(start + 1);
  const next = rest.slice(2).search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 2);
}

const LIVE_KEY_FILES = new Set([
  'test/e2e/skills.test.ts',
  'test/e2e/zeroentropy-live.test.ts',
  'test/e2e/voyage-rerank-live.test.ts',
  'test/e2e/voyage-multimodal.test.ts',
]);

describe('selected-e2e job wiring', () => {
  const job = jobBlock('selected-e2e');

  test('consumes select-e2e with nothing masking its exit code', () => {
    expect(job).toContain('bun scripts/select-e2e.ts');
    const selectorLine = job.split('\n').find(l => l.includes('bun scripts/select-e2e.ts'))!;
    expect(selectorLine).not.toContain('|| true');
    expect(selectorLine).not.toContain('|| echo');
    expect(job).not.toContain('continue-on-error');
  });

  test('cache-write and status both gate on the job', () => {
    const cacheWrite = jobBlock('e2e-cache-write');
    const status = jobBlock('e2e-status');
    expect(cacheWrite).toContain('selected-e2e');
    expect(status).toContain('selected-e2e');
    expect(status).toContain('needs.selected-e2e.result');
    // The aggregate loop must actually check the result, not just need it.
    expect(status.includes('"$SELECTED"')).toBe(true);
  });

  test('fork-runnable: no live provider keys anywhere in the job block', () => {
    for (const secret of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZEROENTROPY', 'VOYAGE_API_KEY', 'secrets.']) {
      expect(job).not.toContain(secret);
    }
  });

  test('checkout fetches real history for the master diff', () => {
    expect(job).toContain('fetch-depth: 0');
  });

  test('every EXCLUDE entry is named by another job here or is a live-key spender', () => {
    const m = job.match(/EXCLUDE='([^']+)'/);
    expect(m).not.toBeNull();
    const excluded = m![1].split(/\s+/).filter(Boolean);
    expect(excluded.length).toBeGreaterThan(0);
    const restOfWorkflow = yml.replace(job, '');
    for (const f of excluded) {
      const honest = LIVE_KEY_FILES.has(f) || restOfWorkflow.includes(f);
      if (!honest) throw new Error(`EXCLUDE entry not carried by any named job and not a live-key file: ${f}`);
    }
  });
});

/**
 * The CURRENT number of baseline entries. NEVER raise this number; when the
 * baseline shrinks (a file gets mapped or deleted), lower this constant IN
 * THE SAME COMMIT (the module-size ratchet's no-stale-slack convention).
 */
const BASELINE_SEEDED_LENGTH = 153;

describe('e2e file claim ratchet', () => {
  const mapped = new Set(Object.values(E2E_TEST_MAP).flat());
  const baselineEntries = readFileSync(join(repoRoot, 'test/fixtures/e2e-unmapped-baseline.txt'), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const baseline = new Set(baselineEntries);

  test('every e2e file is mapped, workflow-named, or grandfathered (shrink-only baseline)', () => {
    const files = readdirSync(join(repoRoot, 'test/e2e'))
      .filter(f => f.endsWith('.test.ts'))
      .map(f => `test/e2e/${f}`);
    expect(files.length).toBeGreaterThan(150);
    const orphans = files.filter(f => !mapped.has(f) && !yml.includes(f) && !baseline.has(f));
    if (orphans.length > 0) {
      throw new Error(
        `new e2e file(s) with no PR-time claim — map them in scripts/e2e-test-map.ts ` +
        `(preferred) or consciously add to test/fixtures/e2e-unmapped-baseline.txt:\n` +
        orphans.join('\n'),
      );
    }
    // Map entries must point at real files (typo guard — a registry-walking
    // matrix seeded with wrong names silently matches nothing).
    const real = new Set(files);
    const dangling = [...mapped].filter(f => !real.has(f));
    expect(dangling).toEqual([]);
  });

  test('no stale baseline entries: every row names an existing e2e file', () => {
    const stale = baselineEntries.filter(f => !existsSync(join(repoRoot, f)));
    if (stale.length > 0) {
      throw new Error(
        `baseline row(s) name deleted e2e file(s) — remove the line from ` +
        `test/fixtures/e2e-unmapped-baseline.txt (the ratchet only shrinks):\n` +
        stale.join('\n'),
      );
    }
  });

  test('no redundant baseline entries: a mapped or workflow-named file must leave the baseline', () => {
    const redundant = baselineEntries.filter(f => mapped.has(f) || yml.includes(f));
    if (redundant.length > 0) {
      throw new Error(
        `baseline row(s) already claimed by E2E_TEST_MAP or the workflow — ` +
        `remove the line from test/fixtures/e2e-unmapped-baseline.txt ` +
        `(mapped ⇒ off the baseline):\n` +
        redundant.join('\n'),
      );
    }
  });

  test('baseline is shrink-only (seeded length ratchet)', () => {
    expect(baselineEntries.length).toBeLessThanOrEqual(BASELINE_SEEDED_LENGTH);
  });

  test('select-e2e fail-closed behavior has its own behavioral suite', () => {
    // Cross-reference, not duplication: the ALL-on-uncertainty + exit-2
    // semantics are behaviorally pinned in test/select-e2e.test.ts.
    const behavioral = readFileSync(join(repoRoot, 'test/select-e2e.test.ts'), 'utf8');
    expect(behavioral).toContain('select-e2e');
  });
});
