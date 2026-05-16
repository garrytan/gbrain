/**
 * End-to-end integration tests for the `audit-name-links` command.
 *
 * Uses Option A (injected engine) to avoid GBRAIN_HOME manipulation. The
 * PGLiteEngine is spun up in-memory, seeded with fixture person pages, and
 * `runAuditNameLinks` is called with `{ engine }` opts so the
 * config/createEngine path is bypassed entirely.
 *
 * Covers plan Task 1.8 test cases 1-8:
 *   1. [Justin Thompson](people/jthompson-aseva) validates clean (canonical).
 *   2. [Justin](people/jthompson-aseva) validates clean (first-token alias).
 *   3. [Chris](people/cwaytek-aseva) validates clean (linkify_aliases entry).
 *   4. [Calvin Waytek](people/cwaytek-aseva) emits name_mismatch.
 *   5. [Leedy Allen](people/lallen-aseva) (slug missing) emits unknown_target.
 *   6. --fix-display-names rewrites case 4 to canonical name.
 *   7. Re-running --fix-display-names on the fixed file is a no-op.
 *   8. Wikilink form [[people/cwaytek-aseva|Calvin]] validates same as md.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAuditNameLinks } from '../src/commands/audit-name-links.ts';
import type { PageInput } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// stderr capture helper — diagnostics are emitted to stderr in
// --json-diagnostics / --verbose-diagnostics mode and counts-only by default.
// ---------------------------------------------------------------------------

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // @ts-ignore — monkey-patch for test capture
  process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === 'string') chunks.push(chunk);
    else chunks.push(Buffer.from(chunk).toString('utf-8'));
    return orig(chunk, ...(rest as []));
  };
  try {
    const result = await fn();
    return { result, stderr: chunks.join('') };
  } finally {
    // @ts-ignore
    process.stderr.write = orig;
  }
}

// ---------------------------------------------------------------------------
// Shared fixture brain
// ---------------------------------------------------------------------------

describe('audit-name-links integration', () => {
  let tmpDir: string;
  let engine: PGLiteEngine;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-name-links-integration-'));

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Person A: name only — first-token alias "Justin" derived.
    const personA: PageInput = {
      type: 'person',
      title: 'Justin Thompson',
      compiled_truth: '',
      frontmatter: { name: 'Justin Thompson' },
    };
    // Person B: name + explicit linkify_aliases — both canonical "Christopher
    // Waytek" and explicit alias "Chris" validate clean.
    const personB: PageInput = {
      type: 'person',
      title: 'Christopher Waytek',
      compiled_truth: '',
      frontmatter: { name: 'Christopher Waytek', linkify_aliases: ['Chris'] },
    };
    await engine.putPage('people/jthompson-aseva', personA);
    await engine.putPage('people/cwaytek-aseva', personB);
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }, 60_000);

  // -------------------------------------------------------------------------
  // Case 1: canonical name validates clean
  // -------------------------------------------------------------------------

  test('case 1: canonical name [Justin Thompson](people/jthompson-aseva) is clean', async () => {
    const f = join(tmpDir, 'case1-canonical.md');
    const original = 'Met with [Justin Thompson](people/jthompson-aseva) today.\n';
    writeFileSync(f, original);

    const { result: code, stderr } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--json-diagnostics'], { engine }),
    );

    expect(code).toBe(0);
    // No name_mismatch / unknown_target / malformed_target diagnostics.
    expect(stderr).not.toContain('"kind":"name_mismatch"');
    expect(stderr).not.toContain('"kind":"unknown_target"');
    expect(stderr).not.toContain('"kind":"malformed_target"');
    // File unchanged.
    expect(readFileSync(f, 'utf-8')).toBe(original);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Case 2: first-token alias derived from name validates clean
  // -------------------------------------------------------------------------

  test('case 2: derived first-token alias [Justin](people/jthompson-aseva) is clean', async () => {
    const f = join(tmpDir, 'case2-firsttoken.md');
    const original = 'Chatted with [Justin](people/jthompson-aseva) about the deal.\n';
    writeFileSync(f, original);

    const { result: code, stderr } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--json-diagnostics'], { engine }),
    );

    expect(code).toBe(0);
    expect(stderr).not.toContain('"kind":"name_mismatch"');
    expect(readFileSync(f, 'utf-8')).toBe(original);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Case 3: linkify_aliases entry validates clean
  // -------------------------------------------------------------------------

  test('case 3: linkify_aliases entry [Chris](people/cwaytek-aseva) is clean', async () => {
    const f = join(tmpDir, 'case3-alias.md');
    const original = 'Reviewed update from [Chris](people/cwaytek-aseva).\n';
    writeFileSync(f, original);

    const { result: code, stderr } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--json-diagnostics'], { engine }),
    );

    expect(code).toBe(0);
    expect(stderr).not.toContain('"kind":"name_mismatch"');
    expect(readFileSync(f, 'utf-8')).toBe(original);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Case 4: AI-mediated misname emits name_mismatch
  // -------------------------------------------------------------------------

  test('case 4: [Calvin Waytek](people/cwaytek-aseva) emits name_mismatch', async () => {
    const f = join(tmpDir, 'case4-mismatch.md');
    const original = 'Reviewed [Calvin Waytek](people/cwaytek-aseva) update.\n';
    writeFileSync(f, original);

    const { result: code, stderr } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--json-diagnostics'], { engine }),
    );

    // Detective-only by default — exit 0 even with mismatch.
    expect(code).toBe(0);
    expect(stderr).toContain('"kind":"name_mismatch"');
    expect(stderr).toContain('"display":"Calvin Waytek"');
    expect(stderr).toContain('"slug":"people/cwaytek-aseva"');
    // Without --fix-display-names, file is untouched.
    expect(readFileSync(f, 'utf-8')).toBe(original);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Case 5: missing-slug target emits unknown_target
  // -------------------------------------------------------------------------

  test('case 5: [Leedy Allen](people/lallen-aseva) emits unknown_target', async () => {
    const f = join(tmpDir, 'case5-unknown.md');
    const original = 'Met with [Leedy Allen](people/lallen-aseva) yesterday.\n';
    writeFileSync(f, original);

    const { result: code, stderr } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--json-diagnostics'], { engine }),
    );

    // Detective-only by default — exit 0 even with unknown_target.
    expect(code).toBe(0);
    expect(stderr).toContain('"kind":"unknown_target"');
    expect(stderr).toContain('"slug":"people/lallen-aseva"');
    expect(readFileSync(f, 'utf-8')).toBe(original);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Case 6: --fix-display-names rewrites case 4 to canonical name
  // -------------------------------------------------------------------------

  test('case 6: --fix-display-names rewrites mismatch to canonical name', async () => {
    const f = join(tmpDir, 'case6-fix.md');
    writeFileSync(f, 'Reviewed [Calvin Waytek](people/cwaytek-aseva) update.\n');

    const { result: code, stderr } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--fix-display-names', '--json-diagnostics'], { engine }),
    );

    expect(code).toBe(0);
    expect(stderr).toContain('"kind":"display_fixed"');
    // File rewritten to canonical name.
    expect(readFileSync(f, 'utf-8')).toBe(
      'Reviewed [Christopher Waytek](people/cwaytek-aseva) update.\n',
    );
  }, 30_000);

  // -------------------------------------------------------------------------
  // Case 7: re-running --fix-display-names on the fixed file is a no-op
  // -------------------------------------------------------------------------

  test('case 7: --fix-display-names is idempotent', async () => {
    const f = join(tmpDir, 'case7-idempotent.md');
    // Start with the already-canonical form.
    const fixed = 'Reviewed [Christopher Waytek](people/cwaytek-aseva) update.\n';
    writeFileSync(f, fixed);

    // First run on a clean file: no fixes applied, no changes.
    const { result: code1, stderr: stderr1 } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--fix-display-names', '--json-diagnostics'], { engine }),
    );
    expect(code1).toBe(0);
    expect(stderr1).not.toContain('"kind":"display_fixed"');
    expect(readFileSync(f, 'utf-8')).toBe(fixed);

    // Second run: still a no-op.
    const { result: code2, stderr: stderr2 } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--fix-display-names', '--json-diagnostics'], { engine }),
    );
    expect(code2).toBe(0);
    expect(stderr2).not.toContain('"kind":"display_fixed"');
    expect(readFileSync(f, 'utf-8')).toBe(fixed);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Case 8: qualified wikilink form validates same as markdown form
  // -------------------------------------------------------------------------

  test('case 8: wikilink form [[people/cwaytek-aseva|Calvin]] emits name_mismatch', async () => {
    const f = join(tmpDir, 'case8-wikilink.md');
    const original = 'Synced with [[people/cwaytek-aseva|Calvin]] on the plan.\n';
    writeFileSync(f, original);

    const { result: code, stderr } = await captureStderr(() =>
      runAuditNameLinks(['--path', f, '--json-diagnostics'], { engine }),
    );

    // Detective-only — exit 0 even with mismatch.
    expect(code).toBe(0);
    expect(stderr).toContain('"kind":"name_mismatch"');
    expect(stderr).toContain('"display":"Calvin"');
    expect(stderr).toContain('"slug":"people/cwaytek-aseva"');
    // Without --fix-display-names, file is untouched.
    expect(readFileSync(f, 'utf-8')).toBe(original);
  }, 30_000);
});
