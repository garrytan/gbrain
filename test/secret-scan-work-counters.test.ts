/**
 * G4.1 (wave 16): the secret scanner's cost on the high-entropy perf fixture is pinned by deterministic work
 * counters (`ScanWork`, src/core/secret-scan-work.ts; the write gate's #6490 shape), counted at the sites that do
 * the work: each regex `exec`, each candidate a pattern returns, each character handed to `correctedEntropy`
 * (inside the call, so a second entropy call per candidate doubles `gateChars`), each validate, each claim, each
 * union split, each echo sweep. The same text gives the same counts on every machine.
 *
 * Forced probes (each applied alone to src/core/secret-scan.ts, this file rerun):
 *   1. quoted pattern's trailing quote made optional (`["']?` in ASSIGNMENT_QUOTED_SOURCE's group 1) → both
 *      high-entropy patterns match the unquoted line: candidates 500, gateChars doubles (2,047,976).
 *   2. a second `correctedEntropy(value, work)` call per candidate → gateChars doubles, candidates unchanged.
 * What the counters cannot see: per-character cost inside one entropy call (the one-pass histogram vs the former
 * Set pass) or inside one regex exec; test/secret-scan-perf.test.ts's absolute bounds are the only guard for that.
 */
import { describe, expect, test } from 'bun:test';
import { createScanWork, redactFindings, scanText, type ScanWork } from '../src/core/secret-scan.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%<>';
const entropic = (n: number, salt: number) => Array.from({ length: n }, (_, k) => ALPHABET[(k * 7 + salt) % ALPHABET.length]).join('');
/** The three inputs of the perf file's `high_entropy_assignment` test, byte for byte. */
const QUOTED = Array.from({ length: 250 }, (_, i) => `password="${entropic(4096, i)}"`).join(' ');
const UNQUOTED = Array.from({ length: 250 }, (_, i) => `token=${entropic(4096, i).replace(/[<>]/g, '.')}`).join(' ');
const TRAILING = `token=${'.'.repeat(4100)} `.repeat(250);

/** The unquoted class excludes `.?!` as the LAST character, so a value ending on a replaced `<`/`>` or on `!` is matched without that run. */
const UNQUOTED_VALUE_CHARS = Array.from({ length: 250 }, (_, i) => entropic(4096, i).replace(/[<>]/g, '.').replace(/[.?!]+$/, '').length).reduce((a, b) => a + b, 0);

function scanWork(text: string): { work: ScanWork; findings: number } {
  const work = createScanWork();
  const { redactions } = redactFindings(text, { highEntropy: true, work });
  return { work, findings: redactions.length };
}

describe('ScanWork on the high-entropy perf fixture', () => {
  test('250 quoted 4096-char values: 250 candidates, 1,024,000 gate chars, 250 claims', () => {
    const { work, findings } = scanWork(QUOTED);
    expect(findings).toBe(250);
    expect(work.linesScanned).toBe(1);
    expect(work.lineChars).toBe(QUOTED.length);
    expect(work.candidates).toEqual({ high_entropy_assignment: 250 });
    expect(work.gateChars).toBe(250 * 4096);
    expect(work.gatePassed).toBe(250);
    expect(work.validateCalls).toBe(250);
    expect(work.claims).toBe(250);
    expect(work.unionSplits).toBe(0);
    // 4096-char values exceed ECHO_MAX_VALUE_CHARS, so the echo dictionary stays empty and no sweep runs.
    expect(work.echoSweeps).toBe(0);
  });

  test('250 unquoted values: 250 candidates, every value character gated once, 250 claims', () => {
    const { work, findings } = scanWork(UNQUOTED);
    expect(findings).toBe(250);
    expect(UNQUOTED_VALUE_CHARS).toBe(1_023_988);
    expect(work.candidates).toEqual({ high_entropy_assignment: 250 });
    expect(work.gateChars).toBe(UNQUOTED_VALUE_CHARS);
    expect(work.gatePassed).toBe(250);
    expect(work.validateCalls).toBe(250);
    expect(work.claims).toBe(250);
    expect(work.unionSplits).toBe(0);
  });

  test('the two high-entropy patterns run 251 + 1 execs on the unquoted line (250 matches + the final null; the quoted pattern finds nothing)', () => {
    const withGate = createScanWork();
    scanText(UNQUOTED, { highEntropy: true, work: withGate });
    const coreOnly = createScanWork();
    scanText(UNQUOTED, { highEntropy: false, work: coreOnly });
    expect(coreOnly.candidates).toEqual({});
    expect(withGate.regexExecs - coreOnly.regexExecs).toBe(251 + 1);
  });

  test('4100-char runs of trailing punctuation: no candidate, nothing gated, nothing claimed', () => {
    const work = createScanWork();
    expect(scanText(TRAILING, { highEntropy: true, work })).toEqual([]);
    expect(work.linesScanned).toBe(1);
    expect(work.candidates).toEqual({});
    expect(work.gateChars).toBe(0);
    expect(work.gatePassed).toBe(0);
    expect(work.validateCalls).toBe(0);
    expect(work.claims).toBe(0);
  });

  test('the counters change nothing: findings and redacted text are identical with and without the accumulator', () => {
    for (const text of [QUOTED, UNQUOTED, TRAILING]) {
      const plain = redactFindings(text, { highEntropy: true });
      const counted = redactFindings(text, { highEntropy: true, work: createScanWork() });
      expect(counted.text).toBe(plain.text);
      expect(counted.redactions).toEqual(plain.redactions);
    }
  });
});

describe('ScanWork on the overlap and echo paths', () => {
  const TWILIO_SID = ['AC', '0123456789abcdef0123456789abcdef'].join('');
  const PW = ['s3cr3t', 'P4ssw0rdXyz'].join('');

  test('a database URL whose username is a vendor-shaped id is one union split: three claims from two candidates', () => {
    const work = createScanWork();
    const findings = scanText(['postgres://', TWILIO_SID, ':', PW, '@db.internal/app'].join(''), { work });
    expect(findings.map(f => f.pattern)).toEqual(['twilio', 'db_url_credentials', 'db_url_credentials']);
    expect(work.unionSplits).toBe(1);
    expect(work.claims).toBe(3);
    expect(work.candidates).toEqual({ twilio: 1, db_url_credentials: 1 });
  });

  test('a bearer value echoed bare later in the text: one claim, one echo sweep', () => {
    const work = createScanWork();
    const value = ['opaque', 'Token0123456789abcdefXYZ'].join('');
    const { text, redactions } = redactFindings(`tool: curl -H "Authorization: Bearer ${value}" https://api.example/v1\nassistant: the token ${value} expired\n`, { work });
    expect(redactions.length).toBe(1);
    expect(text).toBe('tool: curl -H "Authorization: Bearer <REDACTED:bearer>" https://api.example/v1\nassistant: the token <REDACTED:bearer> expired\n');
    expect(work.claims).toBe(1);
    expect(work.echoSweeps).toBe(1);
  });
});
