/**
 * secret-scan private-key claims (security fix wave A1, ENG-12, CEO-15,
 * DX-4 support): truncated keys (BEGIN with no END in view) claim the body
 * that follows; split keys (END with no BEGIN in view) claim the body before
 * the fence; quoted markers stay marker-only (BEGIN) or unclaimed (END);
 * `privateKeySpans` is the same claim set the scanner reports.
 *
 * Key material is generated at runtime (ephemeral keys, random base64) and
 * every fence is joined from fragments, so the committed source carries no
 * key block (gitleaks private-key rule, CEO-10).
 */
import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import {
  PEM_BODY_MAX_CHARS,
  patternSince,
  privateKeySpans,
  redactFindings,
  scanText,
} from '../src/core/secret-scan.ts';

const DASHES = '-'.repeat(5);
const begin = (kind = 'RSA ') => [DASHES, 'BEGIN ', kind, 'PRIVATE KEY', DASHES].join('');
const end = (kind = 'RSA ') => [DASHES, 'END ', kind, 'PRIVATE KEY', DASHES].join('');

/** One random base64 body line of `n` chars. */
function b64Line(n = 64): string {
  let s = '';
  while (s.length < n) s += randomBytes(n).toString('base64').replace(/=/g, '');
  return s.slice(0, n);
}

const TOKEN = '<REDACTED:private_key_pem>';

/** No run of 8+ base64 chars survives outside the redaction tokens. */
function noKeyMaterial(out: string): boolean {
  return !/[A-Za-z0-9+/=]{8,}/.test(out.split(TOKEN).join(' '));
}

const RSA_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const EC_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString();

describe('FORWARD: a BEGIN fence with no END in view claims the body after it', () => {
  test('a key cut off mid-line: header, every whole line and the partial last line are claimed', () => {
    const lines = [b64Line(), b64Line(), b64Line()];
    const partial = b64Line(23);
    const text = `notes:\n${begin()}\n${lines.join('\n')}\n${partial}`;
    const { text: out, redactions } = redactFindings(text);
    expect(out).toBe(`notes:\n${TOKEN}`);
    expect(redactions.map((r) => [r.pattern, r.line])).toEqual([['private_key_pem', 2]]);
    expect(JSON.stringify(redactions).includes(partial)).toBe(false);
  });

  test('a key cut at a line end keeps the prose that follows the body', () => {
    const body = [b64Line(), b64Line(), b64Line(20)].join('\n');
    const text = `${begin('')}\n${body}\n\nMore notes about the server follow here.\n`;
    expect(redactFindings(text).text).toBe(`${TOKEN}\n\nMore notes about the server follow here.\n`);
  });

  test('a short final line followed by a cut is claimed; a short interior word after the body is not', () => {
    const tail = b64Line(5);
    expect(redactFindings(`${begin()}\n${b64Line()}\n${tail}\n`).text).toBe(`${TOKEN}\n`);
    expect(redactFindings(`${begin()}\n${b64Line()}\nThanks\nsee you`).text).toBe(`${TOKEN}\nThanks\nsee you`);
  });

  test('RFC 1421 encrypted headers and one blank line may follow BEGIN', () => {
    const text = [
      'notes',
      begin(),
      'Proc-Type: 4,ENCRYPTED',
      `DEK-Info: AES-128-CBC,${randomBytes(16).toString('hex').toUpperCase()}`,
      '',
      b64Line(),
      b64Line(),
    ].join('\n');
    const { text: out } = redactFindings(text);
    expect(out).toBe(`notes\n${TOKEN}`);
  });

  test('indented (YAML block scalar) and CRLF bodies are claimed', () => {
    const lines = [b64Line(), b64Line(), b64Line(31)];
    const yaml = `tls:\n  key: |\n    ${begin('EC ')}\n${lines.map((l) => `    ${l}`).join('\n')}\nother: value\n`;
    expect(redactFindings(yaml).text).toBe(`tls:\n  key: |\n    ${TOKEN}\nother: value\n`);
    const crlf = `a\r\n${begin()}\r\n${lines.join('\r\n')}\r\nb text here\r\n`;
    expect(redactFindings(crlf).text).toBe(`a\r\n${TOKEN}\r\nb text here\r\n`);
  });

  test('a JSON \\n-escaped key: truncated, complete, and cut inside an escape', () => {
    const lines = [b64Line(), b64Line(), b64Line(17)];
    const truncated = `{"private_key":"${begin('')}\\n${lines.join('\\n')}`;
    expect(redactFindings(truncated).text).toBe(`{"private_key":"${TOKEN}`);
    const complete = `{"private_key":"${begin('')}\\n${lines.join('\\n')}\\n${end('')}\\n","id":"x"}`;
    expect(redactFindings(complete).text).toBe(`{"private_key":"${TOKEN}\\n","id":"x"}`);
    const cutInEscape = `{"k":"${begin('')}\\n${lines[0]}\\n${lines[1]}\\`;
    expect(redactFindings(cutInEscape).text).toBe(`{"k":"${TOKEN}\\`);
  });

  test('a quoted marker in prose stays marker-only and the next prose line survives', () => {
    const marker = begin('');
    const inline = `To find leaks, search for the string ${marker} in your repo, then rotate.`;
    expect(redactFindings(inline).text).toBe(`To find leaks, search for the string ${TOKEN} in your repo, then rotate.`);
    const ownLine = `Search for this line:\n${marker}\nThen rotate every key you find.\n`;
    expect(redactFindings(ownLine).text).toBe(`Search for this line:\n${TOKEN}\nThen rotate every key you find.\n`);
  });

  test('a base64 run longer than 128 chars ends the body and is not claimed', () => {
    const long = b64Line(129);
    const out = redactFindings(`${begin()}\n${b64Line()}\n${long}\n`).text;
    expect(out).toBe(`${TOKEN}\n${long}\n`);
  });

  test(`the forward claim stops at PEM_BODY_MAX_CHARS (${PEM_BODY_MAX_CHARS}); the remainder is the accepted miss`, () => {
    const lines = Array.from({ length: 400 }, () => b64Line());
    const text = `${begin()}\n${lines.join('\n')}`;
    const [span] = privateKeySpans(text);
    const header = begin().length;
    expect(span!.start).toBe(0);
    expect(span!.end - header).toBeLessThanOrEqual(PEM_BODY_MAX_CHARS);
    expect(span!.end - header).toBeGreaterThan(PEM_BODY_MAX_CHARS - 70);
  });
});

describe('BACKWARD: an END fence with no BEGIN in view claims the body before it', () => {
  test('a chunk that starts mid-key (partial first line): body and fence claimed, prose after survives', () => {
    const partial = b64Line(9);
    const text = `${partial}\n${b64Line()}\n${b64Line()}\n${b64Line(12)}\n${end()}\nafter the key\n`;
    const { text: out, redactions } = redactFindings(text);
    expect(out).toBe(`${TOKEN}\nafter the key\n`);
    expect(redactions.map((r) => [r.pattern, r.line])).toEqual([['private_key_pem', 1]]);
  });

  test("a finding's line is the line of its first claimed character", () => {
    const text = `intro prose line\n\n${b64Line()}\n${b64Line()}\n${end('')}`;
    expect(scanText(text).map((f) => f.line)).toEqual([3]);
    expect(redactFindings(text).text).toBe(`intro prose line\n\n${TOKEN}`);
  });

  test('a quoted END marker with no body line before it produces no finding', () => {
    for (const text of [
      `Keys end with ${end('')} and nothing else.`,
      `Keys end with this line:\n${end('')}\n`,
      `${end('')}\n`,
    ]) {
      expect(scanText(text)).toEqual([]);
      expect(privateKeySpans(text)).toEqual([]);
    }
  });

  test('CRLF, indented and JSON-escaped bodies before END are claimed', () => {
    const lines = [b64Line(), b64Line(), b64Line(30)];
    expect(redactFindings(`${lines.join('\r\n')}\r\n${end()}\r\nz\r\n`).text).toBe(`${TOKEN}\r\nz\r\n`);
    expect(redactFindings(`key: |\n${lines.map((l) => `  ${l}`).join('\n')}\n  ${end()}\nnext: 1\n`).text)
      .toBe(`key: |\n  ${TOKEN}\nnext: 1\n`);
    expect(redactFindings(`${lines.join('\\n')}\\n${end('')}\\n"}`).text).toBe(`${TOKEN}\\n"}`);
  });

  test('a short interior line or a prose line stops the walk; the over-128 run is not claimed', () => {
    const keep = 'a prose line with spaces';
    expect(redactFindings(`${keep}\n${b64Line()}\n${b64Line()}\n${end()}`).text).toBe(`${keep}\n${TOKEN}`);
    const long = b64Line(129);
    expect(redactFindings(`x y\n${long}\n${b64Line()}\n${end()}`).text).toBe(`x y\n${long}\n${TOKEN}`);
    expect(redactFindings(`x y\nAbc\n${b64Line()}\n${end()}`).text).toBe(`x y\nAbc\n${TOKEN}`);
  });
});

describe('fences in combination', () => {
  test('a truncated key followed within 16 KB by a complete key: two claims, the prose between survives', () => {
    const prose = 'Second key below, rotated last week.';
    const text = `${begin()}\n${b64Line()}\n${b64Line(40)}\n\n${prose}\n${begin('EC ')}\n${b64Line()}\n${end('EC ')}\n`;
    const { text: out, redactions } = redactFindings(text);
    expect(out).toBe(`${TOKEN}\n\n${prose}\n${TOKEN}\n`);
    expect(redactions.map((r) => r.line)).toEqual([1, 6]);
  });

  test('BEGIN-only, END-only and complete keys in one text: spans are sorted, disjoint and equal to the redacted spans', () => {
    const text = [
      `${b64Line(7)}\n${b64Line()}\n${end()}`,
      'between one',
      `${begin()}\n${b64Line()}\n${end()}`,
      'between two',
      `${begin()}\n${b64Line()}\n${b64Line(11)}`,
    ].join('\n');
    const spans = privateKeySpans(text);
    expect(spans.length).toBe(3);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    let rebuilt = '';
    let at = 0;
    for (const s of spans) {
      rebuilt += text.slice(at, s.start) + TOKEN;
      at = s.end;
    }
    rebuilt += text.slice(at);
    expect(redactFindings(text).text).toBe(rebuilt);
    expect(rebuilt).toBe(`${TOKEN}\nbetween one\n${TOKEN}\nbetween two\n${TOKEN}`);
  });

  test('text without a private-key fence has no spans', () => {
    expect(privateKeySpans('')).toEqual([]);
    expect(privateKeySpans(`${b64Line()}\n${b64Line()}\n`)).toEqual([]);
    expect(privateKeySpans([DASHES, 'BEGIN CERTIFICATE', DASHES].join('') + `\n${b64Line()}\n`)).toEqual([]);
  });
});

describe('generated keys split at every cut point leave no key material in either half', () => {
  const encodings: Array<[string, string]> = [
    ['LF', RSA_PEM],
    ['CRLF', RSA_PEM.replace(/\n/g, '\r\n')],
    ['indented', RSA_PEM.trimEnd().split('\n').map((l) => `    ${l}`).join('\n')],
    ['JSON-escaped', JSON.stringify({ private_key: RSA_PEM })],
    ['EC sec1', EC_PEM],
  ];
  for (const [label, pem] of encodings) {
    test(`${label}`, () => {
      const text = `notes: the deploy key\n${pem}\ndone`;
      const keyStart = text.indexOf(DASHES);
      const keyEnd = text.lastIndexOf(DASHES) + DASHES.length;
      for (let cut = keyStart; cut <= keyEnd; cut += 5) {
        const head = redactFindings(text.slice(0, cut)).text;
        const tail = redactFindings(text.slice(cut)).text;
        if (!noKeyMaterial(head) || !noKeyMaterial(tail)) {
          throw new Error(`${label}: key material survived a cut at ${cut - keyStart}`);
        }
      }
    });
  }
});

describe('ENG-12: one key, one finding', () => {
  test('a vendor-shaped line inside a key body is not reported on its own', () => {
    const aws = ['AKIA', 'Q7RZ2X9KLM4N8P3T'].join('');
    for (const text of [
      `${begin()}\n${b64Line()}\n${aws}\n${b64Line()}\n${end()}`,
      `${begin()}\n${b64Line()}\n${aws}\n${b64Line()}`,
      `${b64Line()}\n${aws}\n${b64Line()}\n${end()}`,
    ]) {
      expect(scanText(text).map((f) => f.pattern)).toEqual(['private_key_pem']);
      expect(redactFindings(text).text).toBe(TOKEN);
    }
  });

  test('a hit outside the key on the same text is still reported', () => {
    const aws = ['AKIA', 'Q7RZ2X9KLM4N8P3T'].join('');
    const text = `id ${aws}\n${begin()}\n${b64Line()}\n${end()}`;
    expect(scanText(text).map((f) => f.pattern).sort()).toEqual(['aws_access_key', 'private_key_pem']);
  });
});

describe('fingerprints and since (A6, DX-4, DX-5)', () => {
  const sha16 = (v: string) => `sha256:${createHash('sha256').update(v).digest('hex').slice(0, 16)}`;

  test('a truncated key carries the pre-wave header-only fingerprint as legacyFingerprint', () => {
    const header = begin();
    const [f] = scanText(`${header}\n${b64Line()}\n${b64Line(10)}`);
    expect(f!.legacyFingerprint).toBe(sha16(header));
    expect(f!.fingerprint).not.toBe(sha16(header));
    expect(f!.since).toBe(patternSince('private_key_pem'));
  });

  test('a complete block and a marker-only claim keep their pre-wave fingerprint (no legacyFingerprint)', () => {
    const header = begin();
    const [marker] = scanText(`see ${header} here`);
    expect(marker!.fingerprint).toBe(sha16(header));
    expect(marker!.legacyFingerprint).toBeUndefined();
    const block = `${header}\n${b64Line()}\n${end()}`;
    const [full] = scanText(block);
    expect(full!.fingerprint).toBe(sha16(block));
    expect(full!.legacyFingerprint).toBeUndefined();
  });

  test('the header-only allowlist entry from before the wave no longer suppresses a truncated key', () => {
    const header = begin();
    const text = `${header}\n${b64Line()}\n${b64Line(10)}`;
    expect(scanText(text, { allowlist: [sha16(header)] }).length).toBe(1);
    const [f] = scanText(text);
    expect(scanText(text, { allowlist: [f!.fingerprint] })).toEqual([]);
  });
});
