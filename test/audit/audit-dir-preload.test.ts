/**
 * Regression gate for #2823: the shared test bootstrap
 * (`test/helpers/audit-dir-preload.ts`, wired via `bunfig.toml`'s
 * `preload`) must redirect `GBRAIN_AUDIT_DIR` to a per-run scratch
 * directory BEFORE any test file runs, so audit-emitting code paths never
 * fall through to the operator's real `~/.gbrain/audit/`.
 *
 * Before the fix, `test/import-file.test.ts`'s oversize-content boundary
 * fixture (`'borderline-slug'`) fired a real `soft_block` content-sanity
 * event straight into the developer's live audit trail on every test run.
 * This file reproduces that exact event shape directly against the audit
 * module (no PGLite/import-file machinery needed) and asserts it lands
 * only in the scratch dir.
 */
import { describe, test, expect } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { resolveAuditDir } from '../../src/core/audit/audit-writer.ts';
import {
  logContentSanityAssessment,
  readRecentContentSanityEvents,
  computeContentSanityAuditFilename,
} from '../../src/core/audit/content-sanity-audit.ts';
import { assessContentSanity } from '../../src/core/content-sanity.ts';

describe('shared test-bootstrap audit isolation (#2823)', () => {
  test('GBRAIN_AUDIT_DIR is set by the preload to a scratch dir, not the real ~/.gbrain/audit', () => {
    const dir = process.env.GBRAIN_AUDIT_DIR;
    expect(dir).toBeTruthy();
    expect(dir).not.toBe(join(homedir(), '.gbrain', 'audit'));
    // mkdtempSync(tmpdir(), ...) always lives directly under os.tmpdir().
    expect(dir!.startsWith(tmpdir())).toBe(true);
  });

  test('resolveAuditDir() resolves to the preload-set scratch dir', () => {
    const expected = process.env.GBRAIN_AUDIT_DIR;
    expect(expected).toBeTruthy();
    expect(resolveAuditDir()).toBe(expected!);
  });

  test('an oversize content-sanity event (the import-file.test.ts "borderline-slug" shape) never reaches the real ~/.gbrain/audit', () => {
    // Unique per test-run so a stale match from a prior manual run can
    // never produce a false pass.
    const sentinelSlug = `borderline-slug-audit-dir-preload-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const realAuditDir = join(homedir(), '.gbrain', 'audit');
    const realAuditFile = join(realAuditDir, computeContentSanityAuditFilename());

    // Reproduce the exact disposition the leaking fixture hits: body bytes
    // over DEFAULT_BYTES_BLOCK (500_000) with no junk pattern match →
    // shouldSkipEmbed=true, no shouldQuarantine → classified 'soft_block'.
    const result = assessContentSanity({
      compiled_truth: 'x'.repeat(600_000),
      timeline: '',
      title: 'Borderline',
    });
    expect(result.shouldSkipEmbed).toBe(true);
    expect(result.shouldQuarantine).toBe(false);

    logContentSanityAssessment(sentinelSlug, 'default', result);

    // 1. The event IS readable back through the audit module — proves the
    //    write succeeded and landed in the dir resolveAuditDir() reports.
    const recent = readRecentContentSanityEvents(1);
    const found = recent.find((e) => e.slug === sentinelSlug);
    expect(found).toBeDefined();
    expect(found?.event_type).toBe('soft_block');

    // 2. The real ~/.gbrain/audit content-sanity file for the current ISO
    //    week — if it exists at all on this machine — does NOT contain the
    //    sentinel slug. This is the actual regression: before the fix, this
    //    assertion would fail on any machine with a real ~/.gbrain.
    if (existsSync(realAuditFile)) {
      const contents = readFileSync(realAuditFile, 'utf8');
      expect(contents).not.toContain(sentinelSlug);
    }
  });
});
