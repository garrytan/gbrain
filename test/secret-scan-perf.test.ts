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
 * of the prefix character: ~24 s).
 *
 * Each of those broken forms did per-item work that grew with the input, so
 * most cases below time the same input shape at two sizes SCALE (10x) apart,
 * back to back in this process, and require the larger to cost under
 * MAX_RATIO (30x) the smaller: linear work reads about 10x, the broken forms
 * about 100x. The echo-pass cases and the `high_entropy_assignment` case keep
 * absolute bounds: their inputs are capped (64 dictionary values,
 * ECHO_MAX_VALUE_CHARS, 4096-char values), so what they guard is a constant
 * factor, which a size ratio cannot see.
 *
 * Every timing, ratio or bound, is CPU time on the test's thread
 * (helpers/cpu-time.ts), which measures the work rather than how long the
 * scheduler made it wait (a wall-clock 400 ms bound read 409 ms at 32 busy
 * slots on a shared CI VM).
 *
 * Every credential-shaped value is synthetic and runtime-joined from >= 2
 * fragments; constant names keep scanner keywords away from the `=`.
 *
 * The `high_entropy_assignment` bounds are the backtracking guard, and the
 * absolute bound is the ONLY guard on per-character cost: the entropy gate's
 * histogram and a regex's inner loop are not countable by the ScanWork
 * counters (test/secret-scan-work-counters.test.ts pins the counts of execs,
 * candidates, gated chars and claims instead). Measured on a 4-core cloud box
 * (wave 16 G4.1): the 250 × 4096 segments cost ~80 ms each with the former
 * two-pass `correctedEntropy` (Set pass ~65 ms of it) and ~25 ms with the
 * one-pass histogram, so a loaded shard VM at 3-4× no longer reaches 300 ms.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { ECHO_MAX_UNIQUE, ECHO_MAX_VALUE_CHARS, privateKeySpans, redactFindings, scanText } from '../src/core/secret-scan.ts';
import { cpuMs } from './helpers/cpu-time.ts';

const SCALE = 10;
const MAX_RATIO = 30;
const RATIO_TIMEOUT_MS = 60_000;

// Process CPU, not cpuMs's thread CPU, for the repetitive-tail bound: an injected allocating echo-sweep regression
// passed it 3 of 3 on thread CPU (standalone: 1712 ms thread vs 3231 ms process, GC threads) and failed at 2386 ms on process CPU.
function processCpuMs(fn: () => unknown): number { const s = process.cpuUsage(); fn(); const u = process.cpuUsage(s); return (u.user + u.system) / 1000; }

/** Thread CPU time advances in scheduler ticks (~4 ms on Linux), so each timed window repeats its call until it holds at least this much. */
const MIN_WINDOW_MS = 40;

/**
 * cpu(large) / cpu(small) per call on inputs SCALE apart, timed back to back on this thread. CPU time, not wall
 * clock: a run that waits for a busy CPU accrues none, so load on a shared VM moves neither side (under 6 busy
 * loops at nice 10, wall-clock ratios of the same pair ranged 0-376x, CPU-time ratios 5-18x). `large` repeats
 * `reps` times per window, the smallest power of two that fills MIN_WINDOW_MS, and `small` SCALE times as often,
 * so both windows are about as long. The best of up to 3 pairs, stopping at the first under MAX_RATIO; a
 * regression that grows with the input is over MAX_RATIO in every pair. The caller's correctness run warms `large`.
 */
function scalingRatio(small: () => unknown, large: () => unknown): number {
  small();
  const repeat = (fn: () => unknown, n: number) => cpuMs(() => { for (let k = 0; k < n; k++) fn(); }) / n;
  let reps = 1;
  while (repeat(large, reps) * reps < MIN_WINDOW_MS) reps *= 2;
  let best = Infinity;
  for (let pair = 0; pair < 3 && !(best < MAX_RATIO); pair++) {
    const t = repeat(small, SCALE * reps);
    best = Math.min(best, repeat(large, reps) / Math.max(t, 0.005));
  }
  return best;
}

const OPAQUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');
const USERINFO = ['alice-example', ':', 's3cr3t', '@'].join('');
const PG_URL_CREDS = ['postgres://', USERINFO].join('');
const PG_URL = PG_URL_CREDS + 'db.example.com:5432/app';

/** One minified JSON line of `count` credential-less redis URLs (8000: ~248k chars). */
function redisJsonLine(count: number, extraElement = ''): string {
  const items = Array.from({ length: count }, (_, i) => `{"u":"redis://localhost:${6379 + (i % 7)}"}`);
  if (extraElement) items.push(extraElement);
  return `[${items.join(',')}]`;
}

describe('db_url_credentials is linear on long lines', () => {
  test('(i) 8000 credential-less redis URLs on one JSON line: 0 findings; 10x the URLs costs < 30x the time', () => {
    const line = redisJsonLine(8000), small = redisJsonLine(8000 / SCALE);
    expect(line.length).toBeGreaterThan(160_000);
    expect(scanText(line)).toEqual([]);
    expect(scalingRatio(() => scanText(small), () => scanText(line))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('(i-b) the same line WITH an @ elsewhere (the cheap precheck passes): still 0 findings; 10x the URLs costs < 30x the time', () => {
    // An email address means the `@` precheck cannot skip the pattern — this
    // pins the bounded quantifiers on their own, not the precheck. It also
    // pins the FALSE POSITIVE the unbounded form had: the run from the last
    // URL's port through `"},{"owner":"ops` to the email's `@` was one bogus
    // db_url_credentials finding, because string delimiters were legal
    // password characters. Second element: the same shape through the
    // USER segment (`cache"},{"contact":"ops` + `:oncall@`).
    const extra = '{"owner":"ops@example.com"},{"u":"redis://cache"},{"contact":"ops:oncall@example.com"}';
    const line = redisJsonLine(8000, extra), small = redisJsonLine(8000 / SCALE, extra);
    expect(scanText(line)).toEqual([]);
    expect(scalingRatio(() => scanText(small), () => scanText(line))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('(ii) 160k chars of repeated `redis://:` (no @): 0 findings; 10x the run costs < 30x the time', () => {
    const line = 'redis://:'.repeat(17_778), small = 'redis://:'.repeat(1_778);
    expect(line.length).toBeGreaterThan(160_000);
    expect(scanText(line)).toEqual([]);
    expect(scalingRatio(() => scanText(small), () => scanText(line))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('(ii-b) 160k chars of repeated `redis://:` followed by a single @: one bounded finding; 10x the run costs < 30x the time', () => {
    // `/` is a legal password character (base64 passwords are pasted
    // unescaped), so the ≤256 chars of `redis://:` runs ahead of the `@` read
    // as `user="" password="redis://:redis://:…"` — ONE credential-shaped
    // finding whose value ends at the `@`, not one per scheme occurrence and
    // not a run to the end of the line. The timing is the pin; the count
    // shows the bound is doing the work.
    const line = 'redis://:'.repeat(17_778) + '@', small = 'redis://:'.repeat(1_778) + '@';
    expect(scanText(line).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(scanText(small).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(scalingRatio(() => scanText(small), () => scanText(line))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);
});

describe('preview + corpus redaction are linear in hits on one line', () => {
  const bearers = (n: number) => Array.from({ length: n }, () => `Bearer ${OPAQUE}`).join(' ');
  const bearerLine = bearers(5000), smallLine = bearers(5000 / SCALE);

  test('(iii) 5000 Bearer tokens on one 190k line: one finding per occurrence; 10x the tokens costs < 30x the time', () => {
    expect(bearerLine.length).toBeGreaterThan(160_000);
    const findings = scanText(bearerLine);
    expect(findings.length).toBe(5000);
    expect(findings.every((f) => f.pattern === 'bearer')).toBe(true);
    expect(JSON.stringify(findings).includes(OPAQUE)).toBe(false);
    expect(scalingRatio(() => scanText(smallLine), () => scanText(bearerLine))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('(iii-b) redactFindings over the same line: no raw token survives; 10x the tokens costs < 30x the time', () => {
    const result = redactFindings(bearerLine);
    expect(result.redactions.length).toBe(5000);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(result.text.startsWith('Bearer <REDACTED:bearer> Bearer <REDACTED:bearer>')).toBe(true);
    expect(scalingRatio(() => redactFindings(smallLine), () => redactFindings(bearerLine))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('(iii-c) hit count scales linearly: 20000 tokens on one 760k line cost < 30x 2000 tokens', () => {
    // The first-wins overlap check and the preview window used to walk every
    // prior span per hit (O(hits²)): 5000 hits 305 ms, 10000 1.4 s, 20000
    // 5.4 s. The overlap check is O(value) per hit now (claimed-char bitmap)
    // and the preview window O(log hits) (binary search over sorted spans).
    const line = bearers(20_000), small = bearers(20_000 / SCALE);
    expect(scanText(line).length).toBe(20_000);
    expect(scalingRatio(() => scanText(small), () => scanText(line))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);
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
  test('200 KB of `-eyJ`: 0 findings; 10x the run costs < 30x the time (was ~25 s)', () => {
    const line = '-eyJ'.repeat(50_000), small = '-eyJ'.repeat(50_000 / SCALE);
    expect(scanText(line)).toEqual([]);
    expect(scalingRatio(() => scanText(small), () => scanText(line))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('210 KB of `-apikey` with highEntropy: 0 findings; 10x the run costs < 30x the time (was ~42 s)', () => {
    const line = '-apikey'.repeat(30_000), small = '-apikey'.repeat(30_000 / SCALE);
    expect(scanText(line, { highEntropy: true })).toEqual([]);
    expect(scalingRatio(() => scanText(small, { highEntropy: true }), () => scanText(line, { highEntropy: true }))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('180 KB of `_token` with highEntropy: 0 findings; 10x the run costs < 30x the time (was ~18 s)', () => {
    const line = '_token'.repeat(30_000), small = '_token'.repeat(30_000 / SCALE);
    expect(scanText(line, { highEntropy: true })).toEqual([]);
    expect(scalingRatio(() => scanText(small, { highEntropy: true }), () => scanText(line, { highEntropy: true }))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);
});

describe('private-key claims are linear in headers and text', () => {
  const MB = 1024 * 1024;
  const PEM_BODY_LINE = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj', 'AgEAAoIBAQC7VJTUt9Us8cKj'].join('');
  // Header/footer joined from fragments so the committed source never carries a whole PEM block (gitleaks private-key rule).
  const PEM_KEY = [['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join(''), PEM_BODY_LINE, ['-----END', ' RSA PRIVATE KEY', '-----'].join('')].join('\n');

  test('2000 header-only mentions ahead of a 1 MB tail: 2000 findings; 10x the headers and tail costs < 30x the time (was ~3.8 s)', () => {
    // The unbounded lazy body scanned from EVERY header to the end of the
    // text looking for an END that never comes. Bounded at
    // PEM_BODY_MAX_CHARS, each header does constant work.
    const make = (headers: number, tail: number) => Array.from({ length: headers }, () => 'leaked -----BEGIN RSA PRIVATE KEY----- here').join('\n') + '\n' + 'x'.repeat(tail);
    const text = make(2000, MB), small = make(2000 / SCALE, MB / SCALE);
    const findings = scanText(text);
    expect(findings.length).toBe(2000);
    expect(findings.every((f) => f.pattern === 'private_key_pem')).toBe(true);
    expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('2000 well-formed keys ahead of a 1 MB tail: 2000 findings with correct lines; 10x the keys and tail costs < 30x the time', () => {
    // The 1-based header line used to be recomputed per hit as
    // `text.slice(0, index).split('\n').length` — O(hits × text). It is a
    // running cursor now; the line numbers must still be exact.
    const make = (keys: number, tail: number) => Array.from({ length: keys }, () => PEM_KEY).join('\n') + '\n' + 'x'.repeat(tail);
    const text = make(2000, MB), small = make(2000 / SCALE, MB / SCALE);
    const findings = scanText(text);
    expect(findings.length).toBe(2000);
    expect(findings.map((f) => f.line)).toEqual(Array.from({ length: 2000 }, (_, k) => 3 * k + 1));
    expect(JSON.stringify(findings).includes(PEM_BODY_LINE)).toBe(false);
    expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('2000 well-formed keys AFTER a 1 MB preamble: exact lines; 10x the keys and preamble costs < 30x the time (was ~1.1 s)', () => {
    // The shape that isolates the per-hit line recount: every hit sits
    // behind >= 1 MB of text, so O(hits × prefix) slicing is >= 2 GB of
    // characters, while the running cursor walks the preamble once.
    const make = (preambleLines: number, keys: number) =>
      Array.from({ length: preambleLines }, () => 'x'.repeat(104)).join('\n') + '\n' + Array.from({ length: keys }, () => PEM_KEY).join('\n');
    const text = make(10_000, 2000), small = make(10_000 / SCALE, 2000 / SCALE);
    expect(text.length).toBeGreaterThan(MB);
    const findings = scanText(text);
    expect(findings.length).toBe(2000);
    expect(findings.map((f) => f.line)).toEqual(Array.from({ length: 2000 }, (_, k) => 10_001 + 3 * k));
    expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('20000 header mentions on ONE line ahead of an 8 MB newline-free tail: 20000 findings on line 1; 10x the headers and tail costs < 30x the time (was ~8 s)', () => {
    // The running cursor used to call `text.indexOf('\n', cursor)` once per
    // hit; with no `\n` anywhere after the cursor each call rescanned to the
    // end of the text and returned -1 — O(hits × text) through a different
    // door (~30 s with a 23 MB tail, inside SCAN_MAX_FILE_BYTES). The
    // next-newline position is carried as state now and a -1 is sticky, so
    // the newline search is O(text) total. What remains of the timing is the
    // bounded PEM body probe (20000 headers × PEM_BODY_MAX_CHARS) plus the
    // per-line patterns over the 8 MB line — the accepted constants.
    const header = ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join('');
    const make = (headers: number, tail: number) => Array.from({ length: headers }, () => header + ' ').join('') + 'x'.repeat(tail);
    const text = make(20_000, 8 * MB), small = make(20_000 / SCALE, (8 * MB) / SCALE);
    const findings = scanText(text);
    expect(findings.length).toBe(20_000);
    expect(findings.every((f) => f.pattern === 'private_key_pem' && f.line === 1)).toBe(true);
    expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

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
    const ms = cpuMs(() => { result = redactFindings(text); });
    expect(result.redactions.length).toBe(ECHO_MAX_UNIQUE);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(ms).toBeLessThan(400);
  });

  test('the adversarial tail — 4 MB of bearer-class chars sharing the values\' prefix, so every 7th position is a candidate start for all 64 values: < 1500ms', () => {
    // Each sweep rejects a candidate position after the shared prefix; 64
    // sweeps over 4 MB. Linear in the text, bounded by the cap.
    const text = vals.map((v) => `Bearer ${v}`).join(' ') + '\n' + 'opaqueT'.repeat((4 << 20) / 7);
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = cpuMs(() => { result = redactFindings(text); });
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
    const ms = cpuMs(() => { result = redactFindings(text); });
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
    const ms = processCpuMs(() => { result = redactFindings(text); });
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
  const prose = 'the quick brown fox jumps over the lazy dog and keeps going for a while yet more prose to pad it out';
  const base = ['aB3xZ9qL7m', 'Np2Rt5Vw8Yk1D4'].join('');
  // Uppercase pad: base36 renders lowercase, so `Q0` can never collide with
  // a padded single digit the way a lowercase `q` pad did (k=936 → `q0`).
  const uniqueValues = (n: number) => Array.from({ length: n }, (_, k) => base + k.toString(36).padStart(6, 'Q'));

  test('1 MB transcript with 5000 UNIQUE high-entropy values: 10x the values and text costs < 30x the time (was ~3 s for a ~70 ms scan)', () => {
    // One full-text replaceAll per unique (pattern, value) pair made the
    // rebuild O(unique × text); the output is now spliced from the claimed
    // spans in one pass. Two prose lines between assignments keep the
    // transcript ~1 MB and mostly non-secret, as a real session is.
    const make = (values: string[]) => values.flatMap((v) => [`api_key = "${v}"`, prose, prose]).join('\n');
    const values = uniqueValues(5000);
    const text = make(values), small = make(uniqueValues(5000 / SCALE));
    expect(text.length).toBeGreaterThan(1024 * 1024);
    const result = redactFindings(text, { highEntropy: true });
    expect(result.redactions.length).toBe(5000);
    expect(result.text.split('<REDACTED:high_entropy_assignment>').length - 1).toBe(5000);
    for (const v of [values[0], values[2499], values[4999]]) expect(result.text.includes(v!)).toBe(false);
    expect(result.text.startsWith(`api_key = "<REDACTED:high_entropy_assignment>"\n${prose}\n${prose}\napi_key = "<REDACTED:high_entropy_assignment>"`)).toBe(true);
    expect(scalingRatio(() => redactFindings(small, { highEntropy: true }), () => redactFindings(text, { highEntropy: true }))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('1 MB transcript with 5000 UNIQUE high-entropy values, each echoed bare once: only the first 64 echoes are scrubbed; 10x the values and text costs < 30x the time', () => {
    // The echo pass now covers high_entropy_assignment. What keeps this
    // linear is the dictionary cap: 64 sweeps over the text, not 5000 —
    // echoes of values past the cap are the documented, accepted miss (their
    // CLAIMS are still redacted).
    const make = (values: string[]) => values.flatMap((v) => [`api_key = "${v}"`, `then the agent pasted ${v} into the shell`, prose]).join('\n');
    const values = uniqueValues(5000);
    expect(new Set(values).size).toBe(5000);
    const text = make(values), small = make(uniqueValues(5000 / SCALE));
    expect(text.length).toBeGreaterThan(1024 * 1024);
    const result = redactFindings(text, { highEntropy: true });
    expect(result.redactions.length).toBe(5000);
    expect(result.text.split('<REDACTED:high_entropy_assignment>').length - 1).toBe(5000 + ECHO_MAX_UNIQUE);
    expect(result.text.includes(values[0]!)).toBe(false);
    expect(result.text.includes(values[ECHO_MAX_UNIQUE - 1]!)).toBe(false);
    // The 65th value: claim redacted, bare echo survives.
    expect(result.text).toContain(`then the agent pasted ${values[ECHO_MAX_UNIQUE]} into the shell`);
    expect(result.text).not.toContain(`api_key = "${values[ECHO_MAX_UNIQUE]}"`);
    expect(scalingRatio(() => redactFindings(small, { highEntropy: true }), () => redactFindings(text, { highEntropy: true }))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('5000 UNIQUE Bearer tokens on one line: 10x the tokens costs < 30x the time (was ~360 ms; the echo pass adds only its 64 sweeps)', () => {
    const make = (n: number) => Array.from({ length: n }, (_, k) => `Bearer ${OPAQUE}${k.toString(36).padStart(4, 'z')}`).join(' ');
    const line = make(5000), small = make(5000 / SCALE);
    const result = redactFindings(line);
    expect(result.redactions.length).toBe(5000);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(result.text).toBe(Array.from({ length: 5000 }, () => 'Bearer <REDACTED:bearer>').join(' '));
    expect(scalingRatio(() => redactFindings(small), () => redactFindings(line))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);
});

describe('security fix wave shapes are linear (A1 walks, A2, A3, A5; ENG-15, ENG-17)', () => {
  // Fences and values are joined from fragments; measured timings on the
  // dev box were 2-90 ms for every input below.
  const DASHES = '-'.repeat(5);
  const BEGIN = [DASHES, 'BEGIN RSA ', 'PRIVATE KEY', DASHES].join('');
  const END = [DASHES, 'END RSA ', 'PRIVATE KEY', DASHES].join('');
  const bodyLine = (i: number) => ['MIIEvQIBADANBgkqhkiG9w0BAQEF', 'AASCBKcwggSj', i.toString(36).padStart(24, 'Q')].join('');
  const bodyLines = (n: number) => Array.from({ length: n }, (_, i) => bodyLine(i)).join('\n');
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%<>';
  const entropic = (n: number, salt: number) =>
    Array.from({ length: n }, (_, k) => ALPHABET[(k * 7 + salt) % ALPHABET.length]).join('');

  test('20000 unterminated BEGIN fences, each with a body line: 20000 claims; 10x the fences costs < 30x the time', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `${BEGIN}\n${bodyLine(i)}`).join('\n');
    const text = make(20_000), small = make(20_000 / SCALE);
    const findings = scanText(text);
    expect(findings.length).toBe(20_000);
    expect(JSON.stringify(findings).includes(bodyLine(7))).toBe(false);
    expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('20000 END-only fences (each walk stops at the previous fence): 0 findings, and on ONE line ahead of an 8 MB tail; 10x the fences (and tail) costs < 30x the time', () => {
    const lines = (n: number) => `${END}\n`.repeat(n);
    expect(scanText(lines(20_000))).toEqual([]);
    expect(scalingRatio(() => scanText(lines(20_000 / SCALE)), () => scanText(lines(20_000)))).toBeLessThan(MAX_RATIO);
    const oneLine = (n: number, tail: number) => `${END} `.repeat(n) + 'x'.repeat(tail);
    const text = oneLine(20_000, 8 << 20), small = oneLine(20_000 / SCALE, (8 << 20) / SCALE);
    expect(scanText(text)).toEqual([]);
    expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('20000 END fences each preceded by a body line: 20000 backward claims; 10x the fences costs < 30x the time', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `${bodyLine(i)}\n${END}`).join('\n');
    const text = make(20_000), small = make(20_000 / SCALE);
    expect(privateKeySpans(text).length).toBe(20_000);
    expect(scalingRatio(() => privateKeySpans(small), () => privateKeySpans(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('1 MB of base64 lines with no fence, after a BEGIN, before an END, and with a fence every 10 lines: 10x the lines costs < 30x the time, each', () => {
    const shapes = (n: number) => {
      const lines = bodyLines(n);
      return [
        lines,
        `${BEGIN}\n${lines}`,
        `${lines}\n${END}`,
        lines.split('\n').map((l, i) => (i % 10 === 9 ? END : l)).join('\n'),
        lines.split('\n').map((l, i) => (i % 10 === 9 ? BEGIN : l)).join('\n'),
      ];
    };
    const large = shapes(16_000), small = shapes(16_000 / SCALE);
    expect(large[0]!.length).toBeGreaterThan(1_000_000);
    large.forEach((text, k) => {
      scanText(text);
      expect(scalingRatio(() => scanText(small[k]!), () => scanText(text))).toBeLessThan(MAX_RATIO);
    });
  }, RATIO_TIMEOUT_MS);

  test('url_credentials: 160k of repeated scheme + user + colon and a lone @, and 8000 credential-less https URLs with an email: 0 findings; 10x either costs < 30x the time', () => {
    const sep = ':' + '//';
    const run = (n: number) => ['https', sep, 'a:'].join('').repeat(n) + '@';
    expect(scanText(run(16_000))).toEqual([]);
    expect(scalingRatio(() => scanText(run(16_000 / SCALE)), () => scanText(run(16_000)))).toBeLessThan(MAX_RATIO);
    const json = (n: number) => '[' + Array.from({ length: n }, (_, i) => `{"u":"${['https', sep, `host${i}.example:8443/x`].join('')}"}`).join(',') + ',{"e":"ops@example.com"}]';
    const text = json(8000), small = json(8000 / SCALE);
    expect(scanText(text)).toEqual([]);
    expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('basic_auth: a 1 MB run of `Basic ` / `Authorization: Basic `, `Basic` + 1 MB of base64, and 500 valid 2048-char values: 10x each costs < 30x the time', () => {
    for (const make of [(n: number) => 'Basic '.repeat(180_000 * n), (n: number) => 'Authorization: Basic '.repeat(50_000 * n), (n: number) => 'Basic ' + 'A'.repeat((1 << 20) * n)]) {
      const text = make(1), small = make(1 / SCALE);
      expect(scanText(text)).toEqual([]);
      expect(scalingRatio(() => scanText(small), () => scanText(text))).toBeLessThan(MAX_RATIO);
    }
    const value = Buffer.from(['u', ':', 'a'.repeat(1534)].join('')).toString('base64');
    const values = (n: number) => `Basic ${value} `.repeat(n);
    expect(scanText(values(500)).length).toBe(500);
    expect(scalingRatio(() => scanText(values(500 / SCALE)), () => scanText(values(500)))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);

  test('high_entropy_assignment: 250 quoted and 250 unquoted 4096-char values on one line, and 4100-char runs of trailing punctuation: < 300ms', () => {
    const quoted = Array.from({ length: 250 }, (_, i) => `password="${entropic(4096, i)}"`).join(' ');
    let result!: ReturnType<typeof redactFindings>;
    let ms = cpuMs(() => { result = redactFindings(quoted, { highEntropy: true }); });
    expect(result.redactions.length).toBe(250);
    expect(ms).toBeLessThan(300);
    const unquoted = Array.from({ length: 250 }, (_, i) => `token=${entropic(4096, i).replace(/[<>]/g, '.')}`).join(' ');
    ms = cpuMs(() => { result = redactFindings(unquoted, { highEntropy: true }); });
    expect(result.redactions.length).toBe(250);
    expect(ms).toBeLessThan(300);
    ms = cpuMs(() => { expect(scanText(`token=${'.'.repeat(4100)} `.repeat(250), { highEntropy: true })).toEqual([]); });
    expect(ms).toBeLessThan(300);
  });
});

describe('labeled_credential (transcript lane): every candidate start does constant work', () => {
  const LABELED = { highEntropy: true, labeledCredentials: true } as const;
  // [name, input at `n` repetitions, n for the named size]; the timed pair is n and n / SCALE.
  const adversaries: Array<[string, (n: number) => string, number]> = [
    ['240 KB of `login `', (n) => 'login '.repeat(n), 40_000],
    ['220 KB of `login: a / `', (n) => 'login: a / '.repeat(n), 20_000],
    ['200 KB of `password: `', (n) => 'password: '.repeat(n), 20_000],
    ['a label, 200k spaces, then a value', (n) => 'password:' + ' '.repeat(n) + 'x', 200_000],
    ['200 KB of `a/` after a login label', (n) => 'login: ' + 'a/'.repeat(n), 100_000],
    ['20000 dangling pair lines', (n) => Array.from({ length: n }, () => 'login: alice-example /').join('\n'), 20_000],
    ['20000 dangling single labels', (n) => Array.from({ length: n }, () => 'password:').join('\n'), 20_000],
    ['a 200 KB row of escaped pipes', (n) => '| password | ' + '\\|'.repeat(n) + ' |', 100_000],
    ['200 KB of `--password `', (n) => '--password '.repeat(n), 20_000],
    ['a 64k-cell row of label cells under 64k password columns (W12 S3)', (n) => ['|' + 'password|'.repeat(n), '|' + '---|'.repeat(n), '|' + 'pwd|'.repeat(n)].join('\n'), 64_000],
  ];
  for (const [name, make, n] of adversaries) {
    test(`${name}: 10x the input costs < 30x the time`, () => {
      const text = make(n), small = make(n / SCALE);
      redactFindings(text, LABELED);
      expect(scalingRatio(() => redactFindings(small, LABELED), () => redactFindings(text, LABELED))).toBeLessThan(MAX_RATIO);
    }, RATIO_TIMEOUT_MS);
  }

  test('a 10k-row table with two credential columns: 10x the rows costs < 30x the time of 1k rows', () => {
    const table = (rows: number) => ['| user | password | pwd |', '|---|---|---|', ...Array.from({ length: rows }, (_, k) => `| u${k} | s3cret${k} | p${k}x\\|y |`)].join('\n');
    const small = table(10_000 / SCALE), large = table(10_000);
    expect(redactFindings(large, LABELED).redactions.length).toBe(20_000);
    expect(scalingRatio(() => redactFindings(small, LABELED), () => redactFindings(large, LABELED))).toBeLessThan(MAX_RATIO);
  }, RATIO_TIMEOUT_MS);
});
