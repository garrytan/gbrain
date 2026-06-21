import { describe, it, expect } from 'bun:test';
import { parseAutoPromoteArgs } from '../../src/commands/auto-promote.ts';

describe('auto-promote CLI args', () => {
  it('defaults to dry-run unless --apply', () => {
    expect(parseAutoPromoteArgs([]).dry_run).toBe(true);
    expect(parseAutoPromoteArgs(['--apply']).dry_run).toBe(false);
    expect(parseAutoPromoteArgs(['--dry-run']).dry_run).toBe(true);
  });
  it('reads scope and limit', () => {
    const a = parseAutoPromoteArgs(['--scope-id', 'personal:me', '--limit', '50']);
    expect(a.scope_id).toBe('personal:me');
    expect(a.limit).toBe(50);
  });
});

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildAutoPromoteDigest } from '../../src/commands/auto-promote.ts';
import { saveBrainReport } from '../../src/commands/report.ts';
import type { RunAutoPromoteResult } from '../../src/core/auto-promote/service.ts';

const DIGEST_RESULT: RunAutoPromoteResult = {
  counts: {
    selected_low_risk: 3,
    selected_risky: 1,
    auto_promoted: 2,
    canonical_handoffs: 2,
    canonical_writes: 0,
    escalated: 1,
    deferred: 1,
    excluded: 4,
  },
  promoted: [],
  excluded: [
    { id: 'a', reason: 'open_contradiction' },
    { id: 'b', reason: 'open_contradiction' },
    { id: 'c', reason: 'missing_provenance' },
    { id: 'd', reason: 'low_confidence' },
  ],
  audit: [
    {
      candidate_id: 'a',
      lane: 'excluded',
      lane_reason: 'open_contradiction',
      runner_kind: null,
      prompt_version: null,
      prompt_input_hash: null,
      confidence_threshold: 0.85,
      policy_version: 'auto-promote-policy-v1',
      verification: { status: 'unverified', method: null },
      target_snapshot_hash: null,
      verdict: { decision: null, confidence: null, judged_at: null },
      gate_skip_reason: 'open_contradiction',
      preflight_result: null,
      patch_candidate_id: null,
      canonical_page_writes_enabled: false,
      canonical_write_result: 'not_attempted',
    },
  ],
} as RunAutoPromoteResult;

describe('auto-promote digest', () => {
  it('parses the digest flags', () => {
    const parsed = parseAutoPromoteArgs(['--digest', '--report-dir', '/tmp/brain']);
    expect(parsed.digest).toBe(true);
    expect(parsed.report_dir).toBe('/tmp/brain');
    expect(parseAutoPromoteArgs([]).digest).toBe(false);
    expect(parseAutoPromoteArgs([]).report_dir).toBe('.');
  });

  it('summarizes counts and groups exclusions by reason', () => {
    const digest = buildAutoPromoteDigest({
      result: DIGEST_RESULT,
      dry_run: true,
      scope_id: 'workspace:default',
      now: '2026-06-12T03:00:00.000Z',
    });

    expect(digest).toContain('Mode: dry-run (no mutations applied)');
    expect(digest).toContain('- Promotable (auto-promoted): 2');
    expect(digest).toContain('- Escalated for review: 1');
    expect(digest).toContain('- Audit entries: 1');
    expect(digest).toContain('- open_contradiction: 2');
    expect(digest).toContain('- missing_provenance: 1');
    expect(digest).toContain('mbrain auto-promote --apply');
  });

  it('omits the next-step nudge in apply mode and when nothing is promotable', () => {
    const applyDigest = buildAutoPromoteDigest({
      result: DIGEST_RESULT,
      dry_run: false,
      scope_id: 'workspace:default',
      now: '2026-06-12T03:00:00.000Z',
    });
    expect(applyDigest).not.toContain('## Next step');

    const emptyDigest = buildAutoPromoteDigest({
      result: { counts: { ...DIGEST_RESULT.counts, auto_promoted: 0 }, promoted: [], excluded: [], audit: [] } as RunAutoPromoteResult,
      dry_run: true,
      scope_id: 'workspace:default',
      now: '2026-06-12T03:00:00.000Z',
    });
    expect(emptyDigest).toContain('No candidates met the confidence bar');
  });

  it('saves the digest as a timestamped brain report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-digest-'));
    try {
      const digest = buildAutoPromoteDigest({
        result: DIGEST_RESULT,
        dry_run: true,
        scope_id: 'workspace:default',
        now: '2026-06-12T03:00:00.000Z',
      });
      const path = saveBrainReport({
        brainDir: dir,
        type: 'auto-promote-digest',
        title: 'Auto-Promote Digest',
        content: digest,
        now: new Date('2026-06-12T03:00:00.000Z'),
      });

      expect(path).toContain(join(dir, 'reports', 'auto-promote-digest'));
      const files = readdirSync(join(dir, 'reports', 'auto-promote-digest'));
      expect(files.length).toBe(1);
      const saved = readFileSync(path, 'utf-8');
      expect(saved).toContain('report_type: auto-promote-digest');
      expect(saved).toContain('- Promotable (auto-promoted): 2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
