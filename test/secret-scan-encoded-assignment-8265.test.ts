/**
 * #8265: `high_entropy_assignment` missed a key whose closing quote is escaped (`{\"password\":\"<v>\"}`, JSON inside a
 * JSON string, the usual shape of tool output) and a URL-encoded separator (`password%3D<v>`, `token%3A<v>`). The
 * value is still bounded: it never takes the backslash of an escaped closing quote, and after an encoded separator it
 * never takes the next parameter (`&`, `%26`). Offsets and fingerprints stay on the stored bytes.
 *
 * Every value is assembled at runtime from random parts (gitleaks, CEO-10).
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';
import { alnum } from './helpers/provider-keys.ts';

const OPTS = { highEntropy: true } as const;
const MARK = '<REDACTED:high_entropy_assignment>';
const secret = () => `Q7x${alnum(21)}9`;
const fingerprint = (v: string) => `sha256:${createHash('sha256').update(v).digest('hex').slice(0, 16)}`;
const found = (line: string) => scanText(line, OPTS).map((f) => f.pattern);

describe('#8265 escaped-quote JSON keys', () => {
  for (const depth of [1, 2, 3]) {
    const q = `${'\\'.repeat(depth)}"`;
    test(`${depth} backslash(es) before each quote: claimed, value only`, () => {
      const v = secret();
      const line = `{${q}password${q}:${q}${v}${q},${q}n${q}:1}`;
      const [hit] = scanText(line, OPTS);
      expect(hit?.pattern).toBe('high_entropy_assignment');
      expect(hit?.fingerprint).toBe(fingerprint(v));
      expect(redactFindings(line, OPTS).text).toBe(`{${q}password${q}:${q}${MARK}${q},${q}n${q}:1}`);
    });
  }

  test('single-quoted, escaped, with spaces around the colon', () => {
    const v = secret();
    const line = `{\\'api_key\\' : \\'${v}\\'}`;
    expect(redactFindings(line, OPTS).text).toBe(`{\\'api_key\\' : \\'${MARK}\\'}`);
  });

  test('an escaped key with an unquoted value', () => {
    const v = secret();
    const line = `x \\"SMTP_PASSWORD\\"=${v} done`;
    expect(redactFindings(line, OPTS).text).toBe(`x \\"SMTP_PASSWORD\\"=${MARK} done`);
  });
});

describe('#8265 URL-encoded separators', () => {
  for (const sep of ['%3D', '%3d', '%3A', '%3a']) {
    test(`password${sep}<value>: claimed, value only`, () => {
      const v = secret();
      const line = `body=user%3Dalice-example%26password${sep}${v}`;
      const [hit] = scanText(line, OPTS);
      expect(hit?.pattern).toBe('high_entropy_assignment');
      expect(hit?.fingerprint).toBe(fingerprint(v));
      expect(redactFindings(line, OPTS).text).toBe(`body=user%3Dalice-example%26password${sep}${MARK}`);
    });
  }

  test('the value stops at the next encoded or literal parameter', () => {
    const v = secret();
    expect(redactFindings(`a=b%26token%3D${v}%26page%3D2`, OPTS).text).toBe(`a=b%26token%3D${MARK}%26page%3D2`);
    expect(redactFindings(`a=b%26token%3D${v}&page=2`, OPTS).text).toBe(`a=b%26token%3D${MARK}&page=2`);
  });

  test('a value that itself carries percent-escapes keeps them', () => {
    const v = `${alnum(10)}%21${alnum(10)}4`;
    expect(redactFindings(`client_secret%3D${v}%26x%3D1`, OPTS).text).toBe(`client_secret%3D${MARK}%26x%3D1`);
  });

  test('a secret key later in a URL-encoded URL value the scan rejects is still claimed', () => {
    const v = secret();
    const line = `token%3Dhttps%3A%2F%2Fexample.org%2Fcb?password=${v}`;
    expect(redactFindings(line, OPTS).text).toBe(`token%3Dhttps%3A%2F%2Fexample.org%2Fcb?password=${MARK}`);
  });

  test('a URL-encoded URL that carries userinfo is still claimed', () => {
    const v = secret();
    expect(found(`password=postgres%3A%2F%2Fu%3A${v}%40db.example%2Fapp`)).toContain('high_entropy_assignment');
    expect(found(`api_key%3Dhttps%3A%2F%2Fu%3A${v}%40x.example`)).toContain('high_entropy_assignment');
  });

  test('a plain separator still keeps a %26 that sits inside the value', () => {
    const v = `${alnum(10)}%26${alnum(10)}4`;
    expect(redactFindings(`password=${v} next`, OPTS).text).toBe(`password=${MARK} next`);
  });
});

describe('#8265 no new findings on ordinary text', () => {
  const LINES = [
    'https://example.test/search?q=a%3Db&page=2',
    'redirect_uri%3Dhttps%3A%2F%2Fexample.test',
    'callback_token%3Dhttps%3A%2F%2Fexample.test%2Fdone%3Fid%3D12',
    'token_count%3D1234567890123',
    'token_count%3A1234567890123%26page%3D2',
    'state=%7B%22page%22%3A2%2C%22q%22%3A%22a%3Db%22%7D',
    'UPDATE jobs SET execution_token=NULL,claim_expires_at=NULL,error_code=$3 WHERE id=$1',
    'const t = token = getToken(x)',
    '{\\"token\\":\\"\\",\\"n\\":1}',
    '{\\"password\\":null,\\"secret_name\\":\\"acme-example\\"}',
    'see secrets%2Fsource-a%2Fversions%2F12 for details',
  ];
  for (const line of LINES) {
    test(line, () => {
      expect(found(line)).toEqual([]);
    });
  }
});
