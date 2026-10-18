/**
 * secret-scan-stream.ts: the windowed scan reports exactly what scanText
 * reports on the whole text (pattern, 1-based line, fingerprint), whatever the
 * window seams and chunk boundaries cut: single-line values and private keys
 * swept across both seams of a window, a line longer than a window split
 * mid-line, multi-byte characters split across chunks, invalid UTF-8 and a
 * BOM. Windows are shrunk to the smallest the module allows (the windowChars
 * test seam) so a sweep stays small; the overlap is the production one.
 * Secrets are assembled at runtime from split literals.
 */
import { describe, test, expect } from 'bun:test';
import { scanText, type SecretFinding } from '../src/core/secret-scan.ts';
import { scanTextStream, STREAM_SCAN_OVERLAP_CHARS as O, streamScanWork } from '../src/core/secret-scan-stream.ts';

let seed = 7;
const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rs = (n: number, cs = ALNUM): string => Array.from({ length: n }, () => cs[Math.floor(rnd() * cs.length)]).join('');
const BEGIN = ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join('');
const END = ['-----END', ' RSA PRIVATE KEY', '-----'].join('');
const pem = (): string => [BEGIN, ...Array.from({ length: 200 }, () => rs(64, ALNUM + '+/')), END].join('\n');
const SECRETS: Array<() => string> = [
  () => '\nkey: ' + 'sk-' + rs(40) + '\n',
  () => ' Bearer ' + 'eyJ' + rs(4000) + '.' + rs(4000) + '.' + rs(4000) + ' ',
  () => '\n' + pem() + '\n',
  () => ' ' + 'sk-ant-' + rs(30) + ' ',
];
const W = 3 * O;

async function* chunks(buf: Uint8Array, size: () => number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; ) {
    const n = size();
    yield buf.subarray(i, i + n);
    i += n;
  }
}
const keys = (fs: SecretFinding[]): string[] => fs.map((f) => `${f.pattern}@${f.line}#${f.fingerprint}`).sort();

async function expectSameAsWhole(buf: Buffer, windowChars = W, size = () => 1 + Math.floor(rnd() * 70_000)): Promise<SecretFinding[]> {
  const whole = scanText(buf.toString('utf-8'));
  const streamed = await scanTextStream(chunks(buf, size), {}, windowChars);
  expect(keys(streamed)).toEqual(keys(whole));
  return streamed;
}

describe('scanTextStream', () => {
  test('values and private keys swept across both seams of a window match the whole-text scan', async () => {
    const lines = Array.from({ length: 4000 }, () => rs(80, ALNUM + ' ')).join('\n');
    const long = rs(5 * O, ALNUM + ' ');
    let found = 0;
    for (const filler of [lines, long]) {
      for (const make of SECRETS) {
        for (let at = W - O - 12_000; at < W + 12_000; at += 3001) {
          found += (await expectSameAsWhole(Buffer.from(filler.slice(0, at) + make() + filler.slice(at)))).length;
        }
      }
    }
    expect(found).toBeGreaterThanOrEqual(2 * SECRETS.length * 8);
  });

  test('a line longer than a window is split mid-line and still yields every value on it', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 40; i++) parts.push(rs(9000 + Math.floor(rnd() * 9000), ALNUM + ' '), ' ' + 'gh' + 'p_' + rs(36) + ' ');
    const found = await expectSameAsWhole(Buffer.from('head\n' + parts.join('') + '\ntail\n'));
    expect(found).toHaveLength(40);
    expect(found.every((f) => f.line === 2)).toBe(true);
  });

  test('multi-byte characters split across chunks, a surrogate pair at a mid-line split, invalid UTF-8 and a BOM', async () => {
    const emoji = '\u{1F600}'.repeat(2 * O);
    const text = '\uFEFF' + 'é日本語 ' + 'sk-ant-' + rs(30) + '\n' + emoji + ' ' + 'sk-' + rs(40) + ' ' + emoji + '\n' + 'é'.repeat(O) + ' ' + 'sk-' + rs(40) + '\n';
    expect(text.charCodeAt(O + 1) & 0xfc00).toBe(0xdc00); // the first mid-line split point is a low surrogate
    expect(await expectSameAsWhole(Buffer.from(text), 2 * O + 1, () => 7)).toHaveLength(3);
    const invalid = Buffer.concat([Buffer.from('a\xff\xfe\n'), Buffer.from([0xe6, 0x97, 0x0a, 0xc3]), Buffer.from(' sk-' + rs(40) + '\n'), Buffer.alloc(3 * O, 0x61)]);
    expect(await expectSameAsWhole(invalid, W, () => 3)).toHaveLength(1);
  });

  test('work counters bound the window and cover every byte', async () => {
    const buf = Buffer.from(Array.from({ length: 20_000 }, () => rs(99, ALNUM + ' ')).join('\n'));
    for (const k of Object.keys(streamScanWork) as Array<keyof typeof streamScanWork>) streamScanWork[k] = 0;
    await scanTextStream(chunks(buf, () => 65_536), {}, W);
    expect(streamScanWork.bytes).toBe(buf.length);
    expect(streamScanWork.chars).toBeGreaterThanOrEqual(buf.length);
    expect(streamScanWork.largestWindow).toBe(W);
    expect(streamScanWork.windows).toBeGreaterThanOrEqual(Math.ceil(buf.length / W));
    expect(streamScanWork.windows).toBeLessThanOrEqual(Math.ceil(buf.length / (W - O - 100)) + 1);
  });

test('every pattern slid across a mid-line cut at every offset matches the whole-text scan', async () => {
    const W2 = 2 * O;
    const cut = O; // a newline-free window is cut mid-line at exactly the overlap before its end
    const filler = rs(W2 + 6000, ALNUM.slice(0, 26) + ' ');
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    const hex = (n: number): string => rs(n, '0123456789abcdef');
    const cases: Array<{ s: string; highEntropy?: boolean }> = [
      { s: 'Bearer ' + rs(40) }, { s: 'BEARER ' + rs(40) }, { s: 'bearer\t\t' + rs(24) },
      { s: 'Authorization: Basic ' + b64('alice:' + rs(10)) }, { s: 'authorization:basic  ' + b64('u:p') },
      { s: 'Basic ' + b64('alice:' + rs(20)) },
      { s: 'postgres' + '://alice:' + rs(16) + '@db.example:5432/app' }, { s: 'https' + '://alice:' + rs(16) + '@host.example/x' },
      { s: 'eyJ' + rs(20) + '.' + rs(20) + '.' + rs(20) },
      { s: 'sk-ant-' + rs(30) }, { s: 'sk-proj-' + rs(30) }, { s: 'sk-' + rs(40) }, { s: 'pa-' + rs(30) },
      { s: 'github_pat_' + rs(30) }, { s: 'gh' + 'p_' + rs(36) }, { s: 'glpat-' + rs(24) }, { s: 'xox' + 'b-' + rs(20) },
      { s: 'AKIA' + rs(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') }, { s: 'AIza' + rs(35) },
      { s: 'sk_' + 'live_' + rs(24) }, { s: 'whsec_' + rs(30) }, { s: 'SG.' + rs(20) + '.' + rs(20) },
      { s: 'AC' + hex(32) }, { s: 'sb_secret_' + rs(24) }, { s: 'sbp_' + hex(40) }, { s: 'npm_' + rs(36) },
      { s: 'hf_' + rs(34) }, { s: 'dop_v1_' + hex(64) }, { s: 'gbrain_at_' + hex(64) },
      { s: 'Bearer ' + 'sk-ant-' + rs(30) }, { s: 'Bearer ' + rs(12) + 'gh' + 'p_' + rs(36) },
      { s: 'api_key = "' + rs(18) + '7Q"', highEntropy: true }, { s: 'SMTP_PASSWORD=' + rs(14) + '9z', highEntropy: true },
      { s: 'token:   ' + rs(16) + '3x', highEntropy: true },
    ];
    let probes = 0;
    let found = 0;
    for (const { s, highEntropy } of cases) {
      const opts = highEntropy ? { highEntropy: true } : {};
      for (let into = -2; into <= Math.min(s.length, 32); into++) {
        const at = cut - into;
        const text = filler.slice(0, at - 1) + ' ' + s + ' ' + filler.slice(at + s.length + 1, W2 + 6000);
        const buf = Buffer.from(text);
        const whole = scanText(text, opts);
        const streamed = await scanTextStream(chunks(buf, () => 1 + Math.floor(rnd() * 70_000)), opts, W2);
        expect({ s: s.slice(0, 12), into, got: keys(streamed) }).toEqual({ s: s.slice(0, 12), into, got: keys(whole) });
        expect(whole.length).toBeGreaterThan(0);
        probes++;
        found += streamed.length;
      }
    }
    expect(probes).toBeGreaterThan(cases.length * 20);
    expect(found).toBeGreaterThanOrEqual(probes);
  });

  test('a window under twice the overlap is refused', async () => {
    await expect(scanTextStream(chunks(Buffer.from('x'), () => 1), {}, 2 * O - 1)).rejects.toThrow(RangeError);
  });
});
