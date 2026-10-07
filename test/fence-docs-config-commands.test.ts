/**
 * Printed fence settings commands are real (#6188 D29).
 *
 * Protects: every `gbrain config set fences.* <value>` command that the fence
 * docs, the v0.60.102.0 migration note, the behavior-change rows and the fence
 * reason fixes print names a registered key with a value `config set`
 * accepts, and the three opt-outs (`fences.normalize`, `fences.repair.enabled`,
 * `fences.repair.llm` set false) are printed where an agent upgrading a brain
 * reads them.
 * Fails when: a doc or notice prints a misspelled or unregistered key, a value
 * `config set` refuses, or drops an opt-out the user is promised.
 * Why new: the config test checks the validator; nothing checked that the
 * commands the docs and notices print pass it.
 * Seams: none; reads the committed docs and the in-code texts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { BEHAVIOR_CHANGES } from '../src/core/behavior-change-notice.ts';
import { FENCE_CONFIG_KEYS, validateFenceConfigValue } from '../src/core/fence-repair/config.ts';
import { FENCE_REASON_CODES, FENCE_REASONS } from '../src/core/fence-repair/reasons.ts';

const ROOT = join(import.meta.dir, '..');
const MIGRATION_NOTE = 'skills/migrations/v0.60.102.0.md';
const DOCS = [
  'AGENTS.md', MIGRATION_NOTE, 'docs/guides/fence-format.md', 'docs/guides/write-refusals.md', 'docs/guides/live-sync.md',
  'docs/guides/troubleshooting.md', 'docs/guides/repair.md', 'docs/operations/spend-controls.md',
];
const OPT_OUTS = ['gbrain config set fences.normalize false', 'gbrain config set fences.repair.enabled false', 'gbrain config set fences.repair.llm false'];
/** The value ends before closing quotes, brackets or the sentence punctuation of the prose (or CLI output line) that prints it. */
const COMMAND = /gbrain config set (fences\.[A-Za-z_.]*[A-Za-z_])\s+([^\s`'")]+?)(?=[.,;:]?(?:\s|$|[`'")]))/g;
/** A placeholder value (`<usd>`, `<n>`) stands for a number the user picks. */
const sample = (value: string) => (/^<[a-z_]+>$/.test(value) ? '2' : value);

const docTexts = Object.fromEntries(DOCS.map(path => [path, readFileSync(join(ROOT, path), 'utf8')]));
const notices = BEHAVIOR_CHANGES.flatMap(c => (typeof c.text === 'string' ? [c.text] : []));
const fixes = FENCE_REASON_CODES.map(reason => FENCE_REASONS[reason].fix);

function commands(text: string): Array<{ key: string; value: string }> {
  return [...text.matchAll(COMMAND)].map(m => ({ key: m[1]!, value: m[2]! }));
}

describe('printed fence config commands', () => {
  const printed = [...Object.values(docTexts), ...notices, ...fixes].flatMap(commands);

  test('every printed command names a registered fences key with a value config set accepts', () => {
    expect(printed.length).toBeGreaterThan(10);
    const refused = printed.flatMap(({ key, value }) => {
      const error = !KNOWN_CONFIG_KEYS.includes(key) ? 'not in KNOWN_CONFIG_KEYS' : validateFenceConfigValue(key, sample(value));
      return error ? [`gbrain config set ${key} ${value}: ${error}`] : [];
    });
    expect(refused).toEqual([]);
    expect([...new Set(printed.map(c => c.key))].filter(key => !FENCE_CONFIG_KEYS.includes(key))).toEqual([]);
  });

  test('the migration note and the behavior-change rows print every opt-out', () => {
    for (const optOut of OPT_OUTS) {
      expect(docTexts[MIGRATION_NOTE]).toContain(optOut);
      expect(notices.some(text => text.includes(optOut))).toBe(true);
    }
  });
});
