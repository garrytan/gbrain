/**
 * #1123 — the multi_source_drift doctor recommendation must only reference
 * CLI surfaces that actually exist. Pre-fix it pointed at
 * 'gbrain sources rehome' (never built) and at 'gbrain delete <slug>'
 * without saying that delete targets the ACTIVE source — following it
 * literally on a multi-source brain deletes the correctly-routed row.
 */

import { describe, test, expect } from 'bun:test';
import { multiSourceDriftAdvice } from '../src/commands/doctor.ts';

describe('#1123 — multiSourceDriftAdvice references only real surfaces', () => {
  const advice = multiSourceDriftAdvice(45, 'foo (intended=wiki)');

  test('carries the count and sample', () => {
    expect(advice).toContain('45 page slug(s)');
    expect(advice).toContain('foo (intended=wiki)');
  });

  test('points at the re-sync path that reconciles drift', () => {
    expect(advice).toContain("gbrain sources status");
    expect(advice).toContain("gbrain sync --source <id> --full");
  });

  test('does not reference the never-built rehome command', () => {
    expect(advice).not.toContain('rehome');
  });

  test('delete advice pins the source explicitly instead of implying delete targets default', () => {
    expect(advice).toContain('GBRAIN_SOURCE=default gbrain delete <slug>');
    expect(advice).not.toContain('delete --source');
  });

  // #4490: the advice used to name only two causes, then recommend a delete.
  // The third cause — the file behind the slug is not git-tracked, so the
  // recommended re-sync imports NOTHING for it and the operator lands on the
  // delete step against a row nothing will recreate — must be named, along
  // with the sync flag that covers it, BEFORE the delete recommendation.
  test('#4490: names the untracked-file cause and --include-gitignored before the delete step', () => {
    expect(advice).toContain('--include-gitignored');
    expect(advice.toLowerCase()).toContain('not git-tracked');
    const flagIdx = advice.indexOf('--include-gitignored');
    const deleteIdx = advice.indexOf('gbrain delete <slug>');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(flagIdx);
  });
});
