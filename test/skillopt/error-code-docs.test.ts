/**
 * Every remediation code skillopt can emit links to
 * `docs/guides/skillopt.md#<code>`; the guide's error-code table must carry a
 * matching anchor row for each, and no anchor for a code that no longer exists.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildRemediation, SKILLOPT_REMEDIATION_CODES } from '../../src/core/skillopt/remediation.ts';
import { SKILLOPT_HELP_TEXT } from '../../src/core/skillopt/help.ts';

const root = join(import.meta.dir, '..', '..');
const guide = readFileSync(join(root, 'docs/guides/skillopt.md'), 'utf8');
const tableRows = guide.split('\n').filter((l) => l.startsWith('| <a id="'));
const anchoredCodes = tableRows.map((l) => l.match(/^\| <a id="([a-z_]+)"><\/a>`([a-z_]+)`/)?.slice(1));

describe('skillopt error-code table', () => {
  test('every emitted remediation code has an anchored table row', () => {
    for (const code of SKILLOPT_REMEDIATION_CODES) {
      const [entry] = buildRemediation([`${code}: x`], code);
      expect(entry?.docs).toBe(`docs/guides/skillopt.md#${code}`);
      expect(anchoredCodes).toContainEqual([code, code]);
    }
  });

  test('the table has no rows for codes skillopt does not emit', () => {
    expect(anchoredCodes.length).toBe(tableRows.length);
    expect(anchoredCodes.map((c) => c![0]).sort()).toEqual([...SKILLOPT_REMEDIATION_CODES].sort());
  });

  test('guide and help state the errored -> exit 2 contract', () => {
    expect(guide).toMatch(/\| 2 \| `aborted` \/ `errored` \|.*optimizer_output_unusable/);
    expect(SKILLOPT_HELP_TEXT).toMatch(/2 = aborted[\s\S]*errored[\s\S]*optimizer_output_unusable/);
  });
});
