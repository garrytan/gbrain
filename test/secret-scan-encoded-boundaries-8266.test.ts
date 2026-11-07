/** #8266: detect wire-encoded credentials without decoding or rewriting source offsets.
 * Synthetic keys only; preserve first-wins attribution, allowlists and the bearer echo floor.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { applyRedaction, createScanWork, planRedaction, redactFindings, scanText, scanTextSpans } from '../src/core/secret-scan.ts';
import { scanTextStream, STREAM_SCAN_OVERLAP_CHARS } from '../src/core/secret-scan-stream.ts';
import { redactFields, residualMatches, resolveSecretRules } from '../src/core/secret-spans.ts';
import { alnum, hex } from './helpers/provider-keys.ts';

const boundaries = [
  '\\x00', '\\xFF', '\\U0001F600', '\\0', '\\v', '=3D', '=3d',
  '\x1b[32m', '\x1b[0;38;2;255;0;42m', '\\x1b[32m', '\\u001b[32m', '^[[32m', '\\^[[32m',
];
const keyShapes = [
  { pattern: 'github_token', make: () => ['ghp', alnum(36)].join('_') },
  { pattern: 'openrouter', make: () => ['sk', 'or', 'v1', hex(64)].join('-') },
  { pattern: 'jwt', make: () => ['eyJ' + alnum(24), alnum(24), alnum(24)].join('.') },
];
const fingerprint = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

describe('#8266 encoded credential boundaries', () => {
  for (const shape of keyShapes) {
    test(`${shape.pattern}: escape and SGR boundaries preserve source text and claim the complete value`, () => {
      for (const before of boundaries) {
        const key = shape.make();
        const prefix = `output=a${before}`;
        const text = `${prefix}${key} done`;
        expect(scanText(text).map(f => f.pattern)).toEqual([shape.pattern]);
        const [span] = scanTextSpans(text);
        expect(text.slice(span!.start, span!.end)).toBe(key);
        expect(span!.finding!.fingerprint).toBe(fingerprint(key));
        const out = redactFindings(text).text;
        expect(out).toBe(`${prefix}<REDACTED:${shape.pattern}> done`);
        expect(scanText(out)).toEqual([]);
        expect(scanText(text, { allowlist: [fingerprint(key)] })).toEqual([]);
        expect(redactFindings(text, { allowlist: [fingerprint(key)] }).text).toBe(text);
      }
    });
  }

  test('escaped anchors reach prebuilt bearer/Basic and opt-in assignment lanes', () => {
    for (const before of boundaries) {
      const token = alnum(40);
      expect(redactFindings(`out=a${before}Bearer ${token}`).text).toBe(`out=a${before}Bearer <REDACTED:bearer>`);
      const basic = Buffer.from(`example:${alnum(20)}`).toString('base64');
      expect(redactFindings(`out=a${before}Basic ${basic}`).text).toBe(`out=a${before}Basic <REDACTED:basic_auth>`);
      const password = `X9${alnum(30)}7q`;
      expect(redactFindings(`out=a${before}password=${password}`, { highEntropy: true }).text)
        .toBe(`out=a${before}password=<REDACTED:high_entropy_assignment>`);
    }
  });

  test('incomplete escapes, ordinary suffixes and non-SGR terminal commands do not become boundaries', () => {
    for (const before of ['\\x', '\\xZ0', '\\U0001F60', '\\U0001F60Z', '\\q', '=3', '=3G', '3D', '_', 'm', '\x1b[32K', '\x1b[32', '^[[mword']) {
      const text = `word${before}${keyShapes[0]!.make()}`;
      expect(scanText(text)).toEqual([]);
      expect(redactFindings(text).text).toBe(text);
    }
  });
});

describe('#8266 encoded bearer credentials', () => {
  for (const separator of [' ', '%20', '+', '\\u0020', '%20+\\u0020']) {
    test(`separator ${JSON.stringify(separator)} keeps full escaped-slash token and session echoes`, () => {
      const token = `${alnum(12)}\\/${alnum(24)}==`;
      const prefix = `header=Bearer${separator}`;
      const text = `${prefix}${token}\necho_${token}`;
      expect(scanText(text).map(f => f.pattern)).toEqual(['bearer']);
      expect(scanText(text)[0]!.fingerprint).toBe(fingerprint(token));
      expect(redactFindings(text).text).toBe(`${prefix}<REDACTED:bearer>\necho_<REDACTED:bearer>`);
      const dictionary = new Map<string, string>();
      const echo = planRedaction(`echo_${token}`, { echoValues: dictionary });
      planRedaction(`${prefix}${token}`, { echoValues: dictionary });
      expect(applyRedaction(echo)).toBe('echo_<REDACTED:bearer>');
      const rules = resolveSecretRules(['bearer']);
      const [result] = redactFields([{ key: 'body', text }], rules);
      expect(result!.proven).toBe(true);
      expect(residualMatches(result!.next, rules)).toEqual({});
      expect(redactFields([{ key: 'body', text: result!.next }], rules)[0]!.spans).toEqual([]);
    });
  }

  test('encoded separator retains vendor attribution and union coverage', () => {
    const key = keyShapes[1]!.make();
    expect(scanText(`Bearer%20${key}`).map(f => f.pattern)).toEqual(['openrouter']);
    expect(redactFindings(`Bearer%20${key}`).text).toBe('Bearer%20<REDACTED:openrouter>');
  });

  test('a long bearer prefix cannot hide the escaped-slash suffix behind a partial successful claim', () => {
    const token = `${alnum(30)}\\/${alnum(24)}\\/${alnum(24)}`;
    const text = `Bearer ${token}`;
    expect(scanTextSpans(text)).toEqual([expect.objectContaining({ start: 7, end: text.length })]);
    expect(redactFindings(text).text).toBe('Bearer <REDACTED:bearer>');
    expect(redactFindings(text, { allowlist: [fingerprint(token)] }).text).toBe(text);
  });

  test('short encoded-slash runs do not evade the 20-character bearer floor; malformed separators are not whitespace', () => {
    for (const token of ['a'.repeat(19), '\\/'.repeat(10), 'a'.repeat(17) + '\\/']) {
      expect(scanText(`Bearer%20${token}`)).toEqual([]);
    }
    for (const sep of ['%2', '%2G', '\\u002', '\\u002G', '_']) {
      expect(scanText(`Bearer${sep}${alnum(40)}`)).toEqual([]);
    }
  });

  test('stream seams keep encoded anchors and full values with exact findings', async () => {
    const window = 2 * STREAM_SCAN_OVERLAP_CHARS;
    const key = keyShapes[0]!.make();
    const token = `${alnum(12)}\\/${alnum(24)}`;
    const text = 'z'.repeat(STREAM_SCAN_OVERLAP_CHARS - 6) + `\\U0001F600${key}\nBearer%20${token}\n` + 'z'.repeat(window);
    async function* chunks() {
      const bytes = Buffer.from(text);
      for (let at = 0; at < bytes.length; at += 17) yield bytes.subarray(at, at + 17);
    }
    expect(await scanTextStream(chunks(), {}, window)).toEqual(scanText(text));
    expect(scanText(text).map(f => f.pattern)).toEqual(['github_token', 'bearer']);
  });

  test('dense failed escape/SGR candidates keep bounded scanner work', () => {
    const unit = 'word\\xZZ\\U1234567Z\x1b[123;456K=3G';
    const small = createScanWork(), large = createScanWork();
    expect(scanText(unit.repeat(1_000), { work: small })).toEqual([]);
    expect(scanText(unit.repeat(2_000), { work: large })).toEqual([]);
    expect(large.regexExecs).toBe(small.regexExecs);
    expect(large.lineChars).toBe(2 * small.lineChars);
  });
});
