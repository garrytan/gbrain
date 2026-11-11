/** #8265: recognize encoded assignment syntax without changing wire offsets or heuristic gates. */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { planRedaction, redactFindings, scanText } from '../src/core/secret-scan.ts';

// Synthetic, deterministic high-entropy value without any named provider prefix.
const value = ['Example', '9vQ2rX7mL4tZ8pC6'].join('');
const marker = '<REDACTED:high_entropy_assignment>';

const contexts: Array<[string, string, string]> = [];
for (const slashes of [1, 2, 3]) {
  for (const quote of ['"', "'"]) {
    const q = '\\'.repeat(slashes) + quote;
    contexts.push([`escaped quote ${slashes} ${quote}`, `{${q}password${q}:${q}`, `${q}}`]);
  }
}
for (const separator of ['%3D', '%3d', '%3A', '%3a']) {
  contexts.push([separator, `password${separator}`, '&next=1']);
  contexts.push([`${separator} encoded tail`, `api_access_token${separator}`, '%26next%3D1']);
}

describe('#8265 encoded high-entropy assignments', () => {
  for (const [name, prefix, suffix] of contexts) {
    test(`${name}: exact value span, fingerprint and echo survive wire syntax`, () => {
      const text = `🌱 ${prefix}${value}${suffix}`;
      const findings = scanText(text, { highEntropy: true });
      expect(findings.map(f => f.pattern)).toEqual(['high_entropy_assignment']);
      expect(findings[0]!.fingerprint).toBe(`sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`);
      const plan = planRedaction(text, { highEntropy: true });
      expect(plan.claimed.map(c => [c.abs, c.end])).toEqual([[text.indexOf(value), text.indexOf(value) + value.length]]);
      expect(redactFindings(`${text}\nbare ${value}`, { highEntropy: true }).text)
        .toBe(`🌱 ${prefix}${marker}${suffix}\nbare ${marker}`);
      expect(scanText(text)).toEqual([]);
    });
  }

  test('literal percent-delimiters in ordinary and quoted assignments remain value data', () => {
    for (const prefix of ['password=', 'password="']) {
      const secret = `${value}%26tail9`;
      const suffix = prefix.endsWith('"') ? '"' : '';
      expect(redactFindings(`${prefix}${secret}${suffix}\nbare ${secret}`, { highEntropy: true }).text)
        .toBe(`${prefix}${marker}${suffix}\nbare ${marker}`);
    }
    const padded = `${value}%3D%3D`;
    expect(redactFindings(`password%3D${padded}%26next%3D1\nbare ${padded}`, { highEntropy: true }).text)
      .toBe(`password%3D${marker}%26next%3D1\nbare ${marker}`);
  });

  test('backslashes in the password are value data, not closing-quote syntax', () => {
    for (const depth of [0, 1, 2, 3]) {
      const quote = '\\'.repeat(depth) + '"';
      const password = 'aB3xK9mQ2pR' + '\\\\';
      const text = `{${quote}password${quote}:${quote}${password}${quote}}`;
      const plan = planRedaction(text, { highEntropy: true });
      expect(plan.claimed.map(c => text.slice(c.abs, c.end))).toEqual([password]);
      expect(redactFindings(`${text}\nbare ${password}`, { highEntropy: true }).text)
        .toBe(`{${quote}password${quote}:${quote}${marker}${quote}}\nbare ${marker}`);
    }
  });

  test('ordinary query parameters, malformed separators and non-secret values stay unchanged', () => {
    const texts = [
      `query%3D${value}&next=1`, `monkey%3D${value}`, `password%3G${value}`,
      'password%3D1234567890123456&next=1', 'password%3DDefaultAzureCredential',
      'password%3Dprocess.env.DB_PASSWORD_2', 'password%3D./example/path123',
      'password%3D<REDACTED:high_entropy_assignment>',
    ];
    for (const text of texts) expect(redactFindings(text, { highEntropy: true }).text).toBe(text);
  });
});
