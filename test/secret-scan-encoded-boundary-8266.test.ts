/**
 * #8266: the escape boundary missed a key right after a terminal color code (`ESC[32m`, raw or written as
 * `\u001b[`, `\x1b[`, `\033[`), a `\xNN` or `\UXXXXXXXX` escape, or a quoted-printable `=3D`, because each ends on a
 * word character; and a bearer token holding a JSON-escaped slash (`\/`) was redacted only up to the slash, leaving
 * its tail in the stored text.
 *
 * Every key is assembled at runtime from random parts (gitleaks, CEO-10).
 */
import { describe, expect, test } from 'bun:test';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';
import { alnum } from './helpers/provider-keys.ts';

const j = (sep: string, ...parts: string[]) => parts.join(sep);
const KEYS: ReadonlyArray<{ pattern: string; make(): string }> = [
  { pattern: 'github_token', make: () => j('_', 'ghp', alnum(36)) },
  { pattern: 'openai', make: () => j('-', 'sk', 'proj', alnum(32)) },
  { pattern: 'npm_token', make: () => j('_', 'npm', alnum(36)) },
];
const BEFORE = ['\x1b[32m', '\x1b[0m', '\x1b[1;31m', '\\u001b[32m', '\\x1b[0m', '\\033[0m', '\\x22', '\\U0001F600', '=3D', '=3d'];

describe('#8266 a key after an ANSI color code, a \\x / \\U escape or =3D is claimed', () => {
  for (const { pattern, make } of KEYS) {
    test(`${pattern}: claimed and redacted after every encoded boundary`, () => {
      for (const before of BEFORE) {
        const key = make();
        const line = `out=a${before}${key} done`;
        expect({ before, found: scanText(line).map((f) => f.pattern) }).toEqual({ before, found: [pattern] });
        expect({ before, out: redactFindings(line).text }).toEqual({ before, out: `out=a${before}<REDACTED:${pattern}> done` });
      }
    });
  }
});

describe('#8266 a bearer token with an escaped slash is redacted whole', () => {
  test('JSON-escaped \\/ inside the token: no tail survives', () => {
    const head = alnum(30);
    const tail = alnum(24);
    const line = `{"h":"Authorization: Bearer ${head}\\/${tail}","n":1}`;
    const out = redactFindings(line).text;
    expect(out.includes(tail)).toBe(false);
    expect(out).toBe('{"h":"Authorization: Bearer <REDACTED:bearer>","n":1}');
  });

  test('a very long bearer-class run does not stop the rule from matching the token after it', () => {
    const token = 'EXAMPLEfakeTOKEN' + alnum(24);
    const line = 'Authorization: Bearer ' + 'A'.repeat(1_000_000) + ' then Bearer ' + token;
    expect(scanText(line).length).toBeGreaterThan(0);
    expect(redactFindings(line).text.includes(token)).toBe(false);
  });

  test('a bare echo of an escaped token, written with a plain slash, is redacted too', () => {
    const [head, tail] = [alnum(24), alnum(24)];
    const out = redactFindings(`{"h":"Bearer ${head}\\/${tail}"}\nlater: ${head}/${tail} end`).text;
    expect(out).not.toContain(head);
    expect(out).not.toContain(tail);
  });

  test('the token still ends at an escaped newline or quote', () => {
    const tok = alnum(40);
    expect(redactFindings(`{"h":"Bearer ${tok}\\nnext"}`).text).toBe('{"h":"Bearer <REDACTED:bearer>\\nnext"}');
    expect(redactFindings(`{"h":"Bearer ${tok}\\"x"}`).text).toBe('{"h":"Bearer <REDACTED:bearer>\\"x"}');
  });
});

describe('#8266 no new false positives', () => {
  test('colored prose and quoted-printable prose stay clean', () => {
    const prose = [
      'status \x1b[32mrisk-assessment-matrix-for-the-quarter\x1b[0m ok',
      'a=3Dskeleton-key-ceremony and \\x22task-scheduler-for-the-cluster',
      '\x1b[1;31mghp-is-not-a-key\x1b[0m npm_install_dependencies_for_workspace_now',
    ].join('\n');
    expect(scanText(prose)).toEqual([]);
    expect(redactFindings(prose, { highEntropy: true }).text).toBe(prose);
  });

  test('a backslash x or U that is not a full escape is not a boundary', () => {
    for (const before of ['\\xg', '\\x2', '\\U0001F6', '=3', '[32m']) {
      const key = j('_', 'ghp', alnum(36));
      expect({ before, found: scanText(`id=a${before}${key}`).map((f) => f.pattern) }).toEqual({ before, found: [] });
    }
  });
});
