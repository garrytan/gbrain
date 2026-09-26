/**
 * secret-scan performance regressions. The per-line scanner runs
 * SYNCHRONOUSLY over untrusted content (transcript ingest, `sources push`
 * blobs up to 25 MB, compiled context), so a pattern that is quadratic on a
 * long line is a denial-of-service lever, not a slow path. Pre-fix timings
 * for the inputs below were seconds (8000 credential-less redis URLs on one
 * JSON line: ~4 s; 160k chars of repeated `redis://:`: ~5.6 s; 5000 Bearer
 * tokens on one line: ~2.6 s vs 41 ms one-per-line; 200 KB of `-eyJ`: ~25 s;
 * 210 KB of `-apikey`: ~42 s; 2000 PEM headers without END ahead of a 1 MB
 * tail: ~3.8 s; 20000 PEM headers on ONE line ahead of an 8 MB newline-free
 * tail: ~8 s (~30 s at 23 MB); redacting a 1 MB transcript with ~5k unique
 * values: ~3 s; the echo pass as ONE escaped-alternation RegExp over 64
 * claimed 4 KB bearer values sharing a 4000-char prefix ahead of a 1 MB tail
 * of the prefix character: ~24 s). The thresholds sit 2-50x above the fixed
 * timings and 10-1000x below the broken ones, so they bind on a regression
 * without flaking on a loaded CI box.
 *
 * Every credential-shaped value is synthetic and runtime-joined from >= 2
 * fragments; constant names keep scanner keywords away from the `=`.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { ECHO_MAX_UNIQUE, ECHO_MAX_VALUE_CHARS, redactFindings, scanText } from '../src/core/secret-scan.ts';

function elapsedMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const OPAQUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');
const USERINFO = ['alice-example', ':', 's3cr3t', '@'].join('');
const PG_URL_CREDS = ['postgres://', USERINFO].join('');
const PG_URL = PG_URL_CREDS + 'db.example.com:5432/app';

/** One minified JSON line of credential-less redis URLs (~248k chars). */
function redisJsonLine(extraElement = ''): string {
  const items = Array.from({ length: 8000 }, (_, i) => `{"u":"redis://localhost:${6379 + (i % 7)}"}`);
  if (extraElement) items.push(extraElement);
  return `[${items.join(',')}]`;
}

describe('db_url_credentials is linear on long lines', () => {
  test('(i) 8000 credential-less redis URLs on one JSON line: 0 findings, < 200ms', () => {
    const line = redisJsonLine();
    expect(line.length).toBeGreaterThan(160_000);
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('(i-b) the same line WITH an @ elsewhere (the cheap precheck passes): still 0 findings, < 200ms', () => {
    // An email address means the `@` precheck cannot skip the pattern — this
    // pins the bounded quantifiers on their own, not the precheck. It also
    // pins the FALSE POSITIVE the unbounded form had: the run from the last
    // URL's port through `"},{"owner":"ops` to the email's `@` was one bogus
    // db_url_credentials finding, because string delimiters were legal
    // password characters. Second element: the same shape through the
    // USER segment (`cache"},{"contact":"ops` + `:oncall@`).
    const line = redisJsonLine('{"owner":"ops@example.com"},{"u":"redis://cache"},{"contact":"ops:oncall@example.com"}');
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('(ii) 160k chars of repeated `redis://:` (no @): < 200ms', () => {
    const line = 'redis://:'.repeat(17_778);
    expect(line.length).toBeGreaterThan(160_000);
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('(ii-b) 160k chars of repeated `redis://:` followed by a single @: one bounded finding, < 200ms', () => {
    // `/` is a legal password character (base64 passwords are pasted
    // unescaped), so the ≤256 chars of `redis://:` runs ahead of the `@` read
    // as `user="" password="redis://:redis://:…"` — ONE credential-shaped
    // finding whose value ends at the `@`, not one per scheme occurrence and
    // not a run to the end of the line. The timing is the pin; the count
    // shows the bound is doing the work.
    const line = 'redis://:'.repeat(17_778) + '@';
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings.map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(ms).toBeLessThan(200);
  });
});

describe('preview + corpus redaction are linear in hits on one line', () => {
  const bearerLine = Array.from({ length: 5000 }, () => `Bearer ${OPAQUE}`).join(' ');

  test('(iii) 5000 Bearer tokens on one 190k line: scanText < 1500ms, one finding per occurrence', () => {
    expect(bearerLine.length).toBeGreaterThan(160_000);
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(bearerLine); });
    expect(findings.length).toBe(5000);
    expect(findings.every((f) => f.pattern === 'bearer')).toBe(true);
    expect(JSON.stringify(findings).includes(OPAQUE)).toBe(false);
    expect(ms).toBeLessThan(1500);
  });

  test('(iii-b) redactFindings over the same line: < 1500ms, no raw token survives', () => {
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = elapsedMs(() => { result = redactFindings(bearerLine); });
    expect(result.redactions.length).toBe(5000);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(result.text.startsWith('Bearer <REDACTED:bearer> Bearer <REDACTED:bearer>')).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  test('(iii-c) hit count scales linearly: 20000 tokens on one 760k line < 1500ms', () => {
    // The first-wins overlap check and the preview window used to walk every
    // prior span per hit (O(hits²)): 5000 hits 305 ms, 10000 1.4 s, 20000
    // 5.4 s. The overlap check is O(value) per hit now (claimed-char bitmap)
    // and the preview window O(log hits) (binary search over sorted spans).
    const line = Array.from({ length: 20_000 }, () => `Bearer ${OPAQUE}`).join(' ');
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings.length).toBe(20_000);
    expect(ms).toBeLessThan(1500);
  });
});

describe('the bounded connection-string pattern still fires on real credentials', () => {
  test('(iv) scheme://user:pass@host: value is exactly the credential span ending at @', () => {
    const findings = scanText(`DATABASE_URL=${PG_URL}`);
    expect(findings.map((f) => f.pattern)).toEqual(['db_url_credentials']);
    // The fingerprint is the sha256 of the span that ends at `@` — host/db
    // are not part of the value.
    const expected = createHash('sha256').update(PG_URL_CREDS).digest('hex').slice(0, 16);
    expect(findings[0]!.fingerprint).toBe(`sha256:${expected}`);
    const { text } = redactFindings(`DATABASE_URL=${PG_URL}`);
    expect(text).toBe('DATABASE_URL=<REDACTED:db_url_credentials>db.example.com:5432/app');
  });

  test('an empty user (redis-style `://:pw@`) still fires', () => {
    const url = ['redis://', ':', 'r3dis', '@cache.internal:6379'].join('');
    expect(scanText(url).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(redactFindings(url).text).toBe('<REDACTED:db_url_credentials>cache.internal:6379');
  });

  test('the password bound is exactly 256 chars (pinned so an edit is a visible edit)', () => {
    const pw256 = 'p4'.repeat(128);
    expect(pw256.length).toBe(256);
    const ok = ['mysql://', 'svc', ':', pw256, '@h/db'].join('');
    expect(scanText(ok).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    // 257 is the accepted miss: a JWT that long is still claimed by `jwt`;
    // an opaque password that long is not a realistic wire shape.
    const over = ['mysql://', 'svc', ':', pw256 + 'x', '@h/db'].join('');
    expect(scanText(over)).toEqual([]);
  });

  test('the RFC 3986 sub-delims, a `:` and a %XX escape are still legal password characters', () => {
    // `'` is the one sub-delim deliberately NOT accepted: it is a string
    // delimiter in minified JS/YAML, the same false-positive shape as `"`.
    const pw = ['p%40ss', '!$&()*+,;=~-._:x'].join('');
    const url = ['mysql://', 'svc', ':', pw, '@h/db'].join('');
    const findings = scanText(`u ${url}`);
    expect(findings.map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(redactFindings(url).text).toBe('<REDACTED:db_url_credentials>h/db');
  });

  test('the user bound is 128 chars; the user segment stops at `/`, the password does not', () => {
    const user128 = 'u'.repeat(128);
    expect(scanText(['amqp://', user128, ':', 'p4ss', '@h'].join('')).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(scanText(['amqp://', user128 + 'u', ':', 'p4ss', '@h'].join(''))).toEqual([]);
    // A `/` in the USER segment ends it (`scheme://host/path:x@y` is not a
    // credential); a `/` in the PASSWORD is legal — base64 passwords are
    // pasted unescaped all the time, and an earlier cut that excluded it let
    // every such password through (pinned positively in
    // secret-scan-format-detectors-extra).
    expect(scanText(['mssql://', 'sv/c', ':', 'p4ss', '@h'].join(''))).toEqual([]);
    expect(scanText(['mssql://', 'svc', ':', 'pa/th0', '@h'].join('')).map((f) => f.pattern)).toEqual(['db_url_credentials']);
  });
});

describe('jwt + high_entropy_assignment are linear on adversarial `-`/`_` runs', () => {
  // Both value classes contain `-` and `_`. When the LEFT BOUNDARY admits the
  // same characters, every `-`/`_` in the run is a fresh start whose value
  // consumes to end-of-line and backtracks — quadratic. jwt now excludes `-`
  // from its boundary and bounds each segment; the entropy rule bounds the
  // keyword's trailing identifier segments (`{0,64}`) and the value.
  test('200 KB of `-eyJ`: 0 findings, < 200ms (was ~25 s)', () => {
    const line = '-eyJ'.repeat(50_000);
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('210 KB of `-apikey` with highEntropy: 0 findings, < 200ms (was ~42 s)', () => {
    const line = '-apikey'.repeat(30_000);
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line, { highEntropy: true }); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('180 KB of `_token` with highEntropy: 0 findings, < 200ms (was ~18 s)', () => {
    const line = '_token'.repeat(30_000);
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line, { highEntropy: true }); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });
});

describe('PEM_BLOCK_RE is linear in headers and text', () => {
  const MB_TAIL = 'x'.repeat(1024 * 1024);
  const PEM_BODY_LINE = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj', 'AgEAAoIBAQC7VJTUt9Us8cKj'].join('');
  // Header/footer joined from fragments so the committed source never carries a whole PEM block (gitleaks private-key rule).
  const PEM_KEY = [['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join(''), PEM_BODY_LINE, ['-----END', ' RSA PRIVATE KEY', '-----'].join('')].join('\n');

  test('2000 header-only mentions ahead of a 1 MB tail: 2000 findings, < 300ms (was ~3.8 s)', () => {
    // The unbounded lazy body scanned from EVERY header to the end of the
    // text looking for an END that never comes. Bounded at
    // PEM_BODY_MAX_CHARS, each header does constant work.
    const text = Array.from({ length: 2000 }, () => 'leaked -----BEGIN RSA PRIVATE KEY----- here').join('\n') + '\n' + MB_TAIL;
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(text); });
    expect(findings.length).toBe(2000);
    expect(findings.every((f) => f.pattern === 'private_key_pem')).toBe(true);
    expect(ms).toBeLessThan(300);
  });

  test('2000 well-formed keys ahead of a 1 MB tail: 2000 findings with correct lines, < 300ms', () => {
    // The 1-based header line used to be recomputed per hit as
    // `text.slice(0, index).split('\n').length` — O(hits × text). It is a
    // running cursor now; the line numbers must still be exact.
    const text = Array.from({ length: 2000 }, () => PEM_KEY).join('\n') + '\n' + MB_TAIL;
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(text); });
    expect(findings.length).toBe(2000);
    expect(findings.map((f) => f.line)).toEqual(Array.from({ length: 2000 }, (_, k) => 3 * k + 1));
    expect(JSON.stringify(findings).includes(PEM_BODY_LINE)).toBe(false);
    expect(ms).toBeLessThan(300);
  });

  test('2000 well-formed keys AFTER a 1 MB preamble: exact lines, < 300ms (was ~1.1 s)', () => {
    // The shape that isolates the per-hit line recount: every hit sits
    // behind >= 1 MB of text, so O(hits × prefix) slicing is >= 2 GB of
    // characters, while the running cursor walks the preamble once.
    const preamble = Array.from({ length: 10_000 }, () => 'x'.repeat(104)).join('\n');
    expect(preamble.length).toBeGreaterThan(1024 * 1024);
    const text = preamble + '\n' + Array.from({ length: 2000 }, () => PEM_KEY).join('\n');
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(text); });
    expect(findings.length).toBe(2000);
    expect(findings.map((f) => f.line)).toEqual(Array.from({ length: 2000 }, (_, k) => 10_001 + 3 * k));
    expect(ms).toBeLessThan(300);
  });

  test('20000 header mentions on ONE line ahead of an 8 MB newline-free tail: 20000 findings on line 1, < 1500ms (was ~8 s)', () => {
    // The running cursor used to call `text.indexOf('\n', cursor)` once per
    // hit; with no `\n` anywhere after the cursor each call rescanned to the
    // end of the text and returned -1 — O(hits × text) through a different
    // door (~30 s with a 23 MB tail, inside SCAN_MAX_FILE_BYTES). The
    // next-newline position is carried as state now and a -1 is sticky, so
    // the newline search is O(text) total. What remains of the timing is the
    // bounded PEM body probe (20000 headers × PEM_BODY_MAX_CHARS) plus the
    // per-line patterns over the 8 MB line — the accepted constants.
    const header = ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join('');
    const text = Array.from({ length: 20_000 }, () => header + ' ').join('') + 'x'.repeat(8 << 20);
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(text); });
    expect(findings.length).toBe(20_000);
    expect(findings.every((f) => f.pattern === 'private_key_pem' && f.line === 1)).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  test('the carried newline position stays exact when hits and newlines interleave on and between lines', () => {
    const header = ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join('');
    const text = `a\n${header}\nb\nc\n${header} ${header}\n\n${header}`;
    expect(scanText(text).map((f) => f.line)).toEqual([2, 5, 5, 7]);
  });
});

describe(`the echo pass is at most ${ECHO_MAX_UNIQUE} substring sweeps over the text`, () => {
  // One `indexOf` sweep per dictionary value (the count is capped, the value
  // length is capped at ECHO_MAX_VALUE_CHARS), candidates spliced into the
  // unclaimed gaps. Never one replaceAll per unique value (5000 unique Bearer
  // tokens on one line stays under the 200 ms pin below with only the first
  // 64 in the dictionary) and never a single escaped-alternation RegExp,
  // which was O(text × Σ|values|) on prefix-sharing values (the last pin).
  const vals = Array.from({ length: ECHO_MAX_UNIQUE }, (_, k) => `${OPAQUE}${k.toString(36).padStart(4, 'z')}`);

  test('64 unique bearer claims ahead of an 8 MB tail with no echo: redact < 400ms', () => {
    const text = vals.map((v) => `Bearer ${v}`).join(' ') + '\n' + 'x'.repeat(8 << 20);
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = elapsedMs(() => { result = redactFindings(text); });
    expect(result.redactions.length).toBe(ECHO_MAX_UNIQUE);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(ms).toBeLessThan(400);
  });

  test('the adversarial tail — 4 MB of bearer-class chars sharing the values\' prefix, so every 7th position is a candidate start for all 64 values: < 1500ms', () => {
    // Each sweep rejects a candidate position after the shared prefix; 64
    // sweeps over 4 MB. Linear in the text, bounded by the cap.
    const text = vals.map((v) => `Bearer ${v}`).join(' ') + '\n' + 'opaqueT'.repeat((4 << 20) / 7);
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = elapsedMs(() => { result = redactFindings(text); });
    expect(result.redactions.length).toBe(ECHO_MAX_UNIQUE);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(ms).toBeLessThan(1500);
  });

  test(`the every-position adversary — ${ECHO_MAX_UNIQUE} claimed values of ${ECHO_MAX_VALUE_CHARS} chars sharing a 500-char prefix ahead of a 1 MB tail of the prefix character: < 300ms (the alternation form took ~24 s)`, () => {
    // The bearer class is `{20,}`, so an attacker-influenced page can plant
    // long prefix-sharing tokens. With the alternation, every position of the
    // tail was a candidate start that walked the shared prefix once per
    // alternative — O(text × Σ|values|). Per-value substring sweeps stay
    // linear here, and the value-length cap bounds each compare.
    const prefix = 'A'.repeat(500);
    const vals512 = Array.from({ length: ECHO_MAX_UNIQUE }, (_, k) => prefix + k.toString(36).padStart(ECHO_MAX_VALUE_CHARS - prefix.length, 'B'));
    expect(vals512.every((v) => v.length === ECHO_MAX_VALUE_CHARS)).toBe(true);
    const tail = 'A'.repeat(1 << 20);
    const text = vals512.map((v) => `Bearer ${v}`).join(' ') + '\n' + tail;
    let result!: ReturnType<typeof redactFindings>;
    const ms = elapsedMs(() => { result = redactFindings(text); });
    expect(result.redactions.length).toBe(ECHO_MAX_UNIQUE);
    expect(result.redactions.every((r) => r.pattern === 'bearer')).toBe(true);
    // Every value joined the dictionary (exactly at the length cap) and the
    // tail carries no echo, so it comes through intact.
    expect(result.echoValues.size).toBe(ECHO_MAX_UNIQUE);
    expect(result.text).toBe(Array.from({ length: ECHO_MAX_UNIQUE }, () => 'Bearer <REDACTED:bearer>').join(' ') + '\n' + tail);
    expect(ms).toBeLessThan(300);
  });

  test(`the repetitive-tail adversary — ${ECHO_MAX_UNIQUE} claimed values of 20..83 repeated \`A\`s, then a 2 MiB \`A\` tail: heap delta < 64 MiB, RSS delta < 96 MiB, < 1500ms, no run of 20 \`A\`s survives`, () => {
    // Retained memory must be independent of text size. Collecting every
    // non-overlapping occurrence of every value up front is O(text × Σ
    // 1/|value|) objects — ~3 M candidates here, ~230 MB of RSS for 64
    // findings (and redactSession runs BEFORE message truncation). The
    // streaming merge keeps O(values) state and emits as it goes.
    const vals = Array.from({ length: ECHO_MAX_UNIQUE }, (_, k) => 'A'.repeat(20 + k));
    const tail = 'A'.repeat(2 << 20);
    const text = vals.map((v) => `Bearer ${v}`).join('\n') + '\n' + tail;
    const gc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
    gc?.(true);
    const before = process.memoryUsage();
    let result!: ReturnType<typeof redactFindings>;
    const ms = elapsedMs(() => { result = redactFindings(text); });
    const after = process.memoryUsage();
    expect(result.redactions.length).toBe(ECHO_MAX_UNIQUE);
    expect(/A{20}/.test(result.text)).toBe(false);
    // 2 MiB = 25266 × 83 + 74 and 74 is itself a claimed length, so the tail
    // is covered wall to wall by echo tokens.
    expect(result.text.split('\n').at(-1)!.replaceAll('<REDACTED:bearer>', '')).toBe('');
    expect((after.heapUsed - before.heapUsed) / (1 << 20)).toBeLessThan(64);
    expect((after.rss - before.rss) / (1 << 20)).toBeLessThan(96);
    expect(ms).toBeLessThan(1500);
  });
});

describe('redactFindings is linear in unique values (span-splice, not replaceAll per value)', () => {
  test('1 MB transcript with 5000 UNIQUE high-entropy values: redact < 400ms (was ~3 s for a ~70 ms scan)', () => {
    // One full-text replaceAll per unique (pattern, value) pair made the
    // rebuild O(unique × text); the output is now spliced from the claimed
    // spans in one pass. Two prose lines between assignments keep the
    // transcript ~1 MB and mostly non-secret, as a real session is.
    const prose = 'the quick brown fox jumps over the lazy dog and keeps going for a while yet more prose to pad it out';
    const base = ['aB3xZ9qL7m', 'Np2Rt5Vw8Yk1D4'].join('');
    const values = Array.from({ length: 5000 }, (_, k) => base + k.toString(36).padStart(6, 'Q'));
    const lines: string[] = [];
    for (const v of values) lines.push(`api_key = "${v}"`, prose, prose);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(1024 * 1024);
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = elapsedMs(() => { result = redactFindings(text, { highEntropy: true }); });
    expect(result.redactions.length).toBe(5000);
    expect(result.text.split('<REDACTED:high_entropy_assignment>').length - 1).toBe(5000);
    for (const v of [values[0], values[2499], values[4999]]) expect(result.text.includes(v!)).toBe(false);
    expect(result.text.startsWith(`api_key = "<REDACTED:high_entropy_assignment>"\n${prose}\n${prose}\napi_key = "<REDACTED:high_entropy_assignment>"`)).toBe(true);
    expect(ms).toBeLessThan(400);
  });

  test('1 MB transcript with 5000 UNIQUE high-entropy values, each echoed bare once: only the first 64 echoes are scrubbed, < 400ms', () => {
    // The echo pass now covers high_entropy_assignment. What keeps this
    // linear is the dictionary cap: 64 sweeps over the text, not 5000 —
    // echoes of values past the cap are the documented, accepted miss (their
    // CLAIMS are still redacted).
    const prose = 'the quick brown fox jumps over the lazy dog and keeps going for a while yet more prose to pad it out';
    const base = ['aB3xZ9qL7m', 'Np2Rt5Vw8Yk1D4'].join('');
    // Uppercase pad: base36 renders lowercase, so `Q0` can never collide with
    // a padded single digit the way a lowercase `q` pad did (k=936 → `q0`).
    const values = Array.from({ length: 5000 }, (_, k) => base + k.toString(36).padStart(6, 'Q'));
    expect(new Set(values).size).toBe(5000);
    const lines: string[] = [];
    for (const v of values) lines.push(`api_key = "${v}"`, `then the agent pasted ${v} into the shell`, prose);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(1024 * 1024);
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = elapsedMs(() => { result = redactFindings(text, { highEntropy: true }); });
    expect(result.redactions.length).toBe(5000);
    expect(result.text.split('<REDACTED:high_entropy_assignment>').length - 1).toBe(5000 + ECHO_MAX_UNIQUE);
    expect(result.text.includes(values[0]!)).toBe(false);
    expect(result.text.includes(values[ECHO_MAX_UNIQUE - 1]!)).toBe(false);
    // The 65th value: claim redacted, bare echo survives.
    expect(result.text).toContain(`then the agent pasted ${values[ECHO_MAX_UNIQUE]} into the shell`);
    expect(result.text).not.toContain(`api_key = "${values[ECHO_MAX_UNIQUE]}"`);
    expect(ms).toBeLessThan(400);
  });

  test('5000 UNIQUE Bearer tokens on one line: redact < 200ms (was ~360 ms; the echo pass adds only its 64 sweeps)', () => {
    const line = Array.from({ length: 5000 }, (_, k) => `Bearer ${OPAQUE}${k.toString(36).padStart(4, 'z')}`).join(' ');
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = elapsedMs(() => { result = redactFindings(line); });
    expect(result.redactions.length).toBe(5000);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(result.text).toBe(Array.from({ length: 5000 }, () => 'Bearer <REDACTED:bearer>').join(' '));
    expect(ms).toBeLessThan(200);
  });
});
