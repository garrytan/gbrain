/**
 * Fix wave 13 P1.14-P1.16 (CSO lows, lane E).
 * Protects: the paid-consent skill lint names itself a documentation tripwire
 * (the runtime consent check is the gate); `pollCommand` renders a server-supplied
 * `fix.argv` shell-quoted, so `$(…)` and spaces paste inert; `parseRepoBase` emits
 * the URL it validated (parser-normalized), not the raw string, and refuses a bare
 * `?`/`#` the parser would drop.
 * Seams: none.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollCommand } from '../src/core/persistence/write-wait.ts';
import { parseRepoBase } from '../src/core/repo-base.ts';

describe('P1.14 paid-consent lint wording', () => {
  test('the failure says the lint checks wording and the runtime consent check still applies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w13-lint-'));
    try {
      mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true });
      writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '```bash\ngbrain reindex-code --yes\n```\n');
      writeFileSync(join(dir, 'allow.txt'), '');
      const res = spawnSync('bun', ['scripts/check-skill-refs.mjs', '--skills-dir', join(dir, 'skills'), '--allowlist', join(dir, 'allow.txt'), '--no-cli-refs'], { encoding: 'utf8' });
      const out = `${res.stdout}${res.stderr}`;
      expect(res.status).toBe(1);
      expect(out).toContain('[paid-consent] skills/alpha/SKILL.md:2');
      expect(out).toContain('the runtime consent check still applies; this lint only checks the wording');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('P1.15 pollCommand quoting', () => {
  test('a fix.argv element with a space or $(…) is single-quoted', () => {
    const id = 'req 1$(touch /tmp/pwned)';
    expect(pollCommand(id, { argv: ['gbrain', 'write-request', '--brain', 'my brain', '--', id] }))
      .toBe("gbrain write-request --brain 'my brain' -- 'req 1$(touch /tmp/pwned)'");
    expect(pollCommand('0b1c-uuid')).toBe('gbrain write-request -- 0b1c-uuid');
  });
});

describe('P1.16 parseRepoBase returns the parsed URL', () => {
  test('a value the parser normalizes is emitted normalized', () => {
    expect(parseRepoBase('https://Docs.Example.test:443/fork/./gbrain/x/../main/')).toBe('https://docs.example.test/fork/gbrain/main');
    expect(parseRepoBase('https://raw.githubusercontent.com/fork-org/gbrain/main')).toBe('https://raw.githubusercontent.com/fork-org/gbrain/main');
  });
  test('an empty query or fragment marker is refused rather than silently dropped', () => {
    expect(parseRepoBase('https://docs.example.test/x?')).toEqual({ invalid: 'https://docs.example.test/x?' });
    expect(parseRepoBase('https://docs.example.test/x#')).toEqual({ invalid: 'https://docs.example.test/x#' });
  });
});
