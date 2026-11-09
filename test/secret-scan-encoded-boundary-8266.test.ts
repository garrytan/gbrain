/**
 * #8266: a key right after a terminal colour code (raw ESC or its escaped spellings), a C/Python \xNN or \UNNNNNNNN
 * escape or quoted-printable =3D was never claimed, because each ends on a word character and the left boundary read
 * it as part of a word; and a JSON-escaped bearer token (\/ inside the value) was redacted only up to the first \/,
 * leaving its tail in stored transcript text.
 *
 * Both directions are pinned: every such boundary now claims the whole key, a bearer value keeps every escaped-slash
 * segment, and near-miss escapes, ordinary words and non-SGR terminal sequences still do not fire. Dense failing
 * input keeps the scanner's work linear. Every key is assembled at runtime from random parts (gitleaks, CEO-10).
 */
import { describe, expect, test } from 'bun:test';
import { createScanWork, redactFindings, scanText } from '../src/core/secret-scan.ts';
import { scanTextStream, STREAM_SCAN_OVERLAP_CHARS } from '../src/core/secret-scan-stream.ts';
import { alnum, hex } from './helpers/provider-keys.ts';

const j = (sep: string, ...parts: string[]) => parts.join(sep);
const ESC = String.fromCharCode(27);
const KEYS = [
  { pattern: 'github_token', make: () => j('_', 'ghp', alnum(36)) },
  { pattern: 'openrouter', make: () => j('-', 'sk', 'or', 'v1', hex(64)) },
  { pattern: 'jwt', make: () => j('.', 'eyJ' + alnum(24), alnum(24), alnum(24)) },
];
/** As each appears in the raw text, immediately before the key. */
const BOUNDARIES = [ESC + '[32m', ESC + '[0;38;2;255;0;42m', '\\x1b[32m', '\\u001b[1;31m', '\\033[0m', '\\e[32m',
  '\\x00', '\\xFF', '\\U0001F600', '=3D', '=3d'];

describe('#8266 encoded boundaries', () => {
  for (const { pattern, make } of KEYS) {
    test(pattern + ': claimed after every encoded boundary, and the whole key is redacted', () => {
      for (const before of BOUNDARIES) {
        const key = make();
        const text = 'out=a' + before + key + ' done';
        expect({ before, found: scanText(text).map(f => f.pattern) }).toEqual({ before, found: [pattern] });
        expect({ before, out: redactFindings(text).text }).toEqual({ before, out: 'out=a' + before + '<REDACTED:' + pattern + '> done' });
      }
    });
  }

  test('near-miss escapes, ordinary words and non-SGR terminal sequences are not boundaries', () => {
    for (const before of ['\\x', '\\xZ0', '\\U0001F60', '=3', '=3G', '3D', 'm', ESC + '[32K', ESC + '[32', '\\x1b[32']) {
      const text = 'word' + before + j('_', 'ghp', alnum(36));
      expect({ before, found: scanText(text) }).toEqual({ before, found: [] });
    }
  });
});

describe('#8266 escaped-slash bearer values', () => {
  test('the whole JSON-escaped token is redacted, with one finding over the whole value', () => {
    const token = alnum(30) + '\\/' + alnum(24) + '\\/' + alnum(12);
    const text = '{"h":"Bearer ' + token + '"}';
    const findings = scanText(text);
    expect(findings.map(f => f.pattern)).toEqual(['bearer']);
    expect(redactFindings(text).text).toBe('{"h":"Bearer <REDACTED:bearer>"}');
  });

  test('the 20-character floor still holds and an escaped quote ends the value', () => {
    expect(scanText('Bearer ' + 'a'.repeat(17) + '\\/')).toEqual([]);
    const token = alnum(30);
    expect(redactFindings('{"h":"Bearer ' + token + '\\"x"}').text).toBe('{"h":"Bearer <REDACTED:bearer>\\"x"}');
  });

  test('a stream scan across a window seam finds what scanText finds', async () => {
    const window = 2 * STREAM_SCAN_OVERLAP_CHARS;
    const text = 'z'.repeat(STREAM_SCAN_OVERLAP_CHARS - 6) + ESC + '[32m' + j('_', 'ghp', alnum(36)) + '\nBearer ' + alnum(12) + '\\/' + alnum(24) + '\n' + 'z'.repeat(window);
    async function* chunks() { const bytes = Buffer.from(text); for (let at = 0; at < bytes.length; at += 17) yield bytes.subarray(at, at + 17); }
    expect(await scanTextStream(chunks(), {}, window)).toEqual(scanText(text));
    expect(scanText(text).map(f => f.pattern)).toEqual(['github_token', 'bearer']);
  });

  test('dense failing candidates keep scanner work linear in the input', () => {
    const unit = 'word\\xZZ\\U1234567Z' + ESC + '[123;456K=3G\\x1b[1;2;3;4;5 Bearer ' + 'a\\/'.repeat(6) + '"';
    const small = createScanWork(), large = createScanWork();
    expect(scanText(unit.repeat(1_000), { work: small })).toEqual([]);
    expect(scanText(unit.repeat(2_000), { work: large })).toEqual([]);
    expect(large.regexExecs).toBe(small.regexExecs);
    expect(large.lineChars).toBe(2 * small.lineChars);
  });
});
