import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #4988: the skill's bash pre-pass divided byte counts by 4 and labelled the
// result "measured"; on Claude-loaded markdown (backticks, paths, punctuation)
// that undercounts 25-35%. The skill must state the divisor it uses in the
// report and defer to the host client's exact context breakdown when one exists.
const skill = readFileSync(join(import.meta.dir, '..', 'skills/context-audit/SKILL.md'), 'utf8');

describe('#4988 context-audit skill states its token-estimate basis', () => {
  test('pre-pass no longer hard-codes a bare chars/4 divisor', () => {
    expect(skill).not.toMatch(/\/ 4 \)\)/);
    expect(skill).not.toContain('chars/4');
  });

  test('report header carries the estimate basis and defers to the host figure', () => {
    expect(skill).toContain('Estimate basis');
    // Anchor to the deferral clause itself — a bare /\/context/ is satisfied by
    // the `/tmp/context-audit-draft.md` scratch path on the pre-fix file.
    expect(skill).toContain('Claude Code `/context`');
    expect(skill).toContain('host-reported exact total (e.g. `/context`)');
  });

  // #5009: the divisor is the one the issue measured (2.65-3.03 bytes/token on
  // always-loaded markdown). 3.5 was the top of the range, i.e. still a ~13-24%
  // undercount; the pre-pass rounds UP so integer math never adds to it.
  test('divisor is the calibrated bytes/2.8 with ceil arithmetic, not the 3.5 floor', () => {
    expect(skill).toContain('bytes/2.8');
    expect(skill).not.toContain('bytes/3.5');
    expect(skill).not.toContain('* 2 / 7');
    expect(skill).toContain('* 10 + 27 ) / 28');
  });
});
