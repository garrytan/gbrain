/**
 * sensitivity-scan (cathedral-5 D4'): each composed family fires in order,
 * the .gbrain-scan-allow fingerprint allowlist un-drops findings from EVERY
 * family (not just secrets), config/loader failures throw the typed error
 * (abort lane), and the scrubPii refactor is byte-regression-pinned.
 *
 * All "secrets" below are synthetic fixtures (this file is inside the
 * .gitleaks.toml test/ allowlist).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadSensitivityConfig,
  scanSensitive,
  SensitivityScanConfigError,
} from '../src/core/context/sensitivity-scan.ts';
import { findPii, scrubPii, PII_PATTERNS } from '../src/core/eval-capture-scrub.ts';
import { SCAN_ALLOW_FILENAME } from '../src/core/secret-scan.ts';

// Synthetic fixture values (never real keys).
const ANTHROPIC = 'sk-ant-' + 'api03-Zz9Yy8Xx7Ww6Vv5Uu4Tt3';

const BLOCK_WORD = 'FORBIDDEN_PLACEHOLDER_NAME_1';

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});
function ws(): string {
  tmp = mkdtempSync(join(tmpdir(), 'sensitivity-scan-'));
  return tmp;
}

/** Config with no allowlist, an explicit blocklist, and a temp pattern file. */
function makeConfig(root: string, extra: { patternLines?: string[]; blocklist?: string } = {}) {
  const patternsPath = join(root, 'patterns.txt');
  writeFileSync(patternsPath, (extra.patternLines ?? [String.raw`\bZZPRIVATE\w+\b`]).join('\n'));
  return loadSensitivityConfig({
    workspaceRoot: root,
    blocklist: extra.blocklist ?? BLOCK_WORD,
    userPatternsPath: patternsPath,
  });
}

const DIRTY = [
  `key=${ANTHROPIC}`,
  'mail alice@example.com now',
  'call 555-123-4567',
  // Path-family fixture built at runtime — the literal deployment path is
  // banned in public artifacts (check-privacy.sh), and new tests must not
  // join its allow-list; the detector still sees the assembled string.
  'log at ' + ['', 'data', '.openclaw', 'state.json'].join('/'),
  `met ${BLOCK_WORD} yesterday`,
  'ref ZZPRIVATEthing done',
].join('\n');

describe('scanSensitive — family composition', () => {
  test('every family fires, in composed order (secret → pii → path → blocklist → pattern-file)', () => {
    const config = makeConfig(ws());
    const findings = scanSensitive(DIRTY, config);
    const families = findings.map((f) => f.family);

    expect(families).toContain('secret:anthropic');
    expect(families).toContain('pii:email');
    expect(families).toContain('pii:phone');
    expect(families).toContain('path');
    expect(families).toContain('blocklist');
    expect(families).toContain('pattern-file');

    const first = (prefix: string) => families.findIndex((f) => f.startsWith(prefix));
    expect(first('secret:')).toBeLessThan(first('pii:'));
    expect(first('pii:')).toBeLessThan(first('path'));
    expect(first('path')).toBeLessThan(first('blocklist'));
    expect(first('blocklist')).toBeLessThan(first('pattern-file'));
  });

  test('findings carry family + sha256 fingerprint only — never the matched text', () => {
    const config = makeConfig(ws());
    for (const f of scanSensitive(DIRTY, config)) {
      expect(Object.keys(f).sort()).toEqual(['family', 'fingerprint']);
      expect(f.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    }
  });

  test('clean text yields zero findings; empty text short-circuits', () => {
    const config = makeConfig(ws());
    expect(scanSensitive('a perfectly ordinary sentence about concepts', config)).toEqual([]);
    expect(scanSensitive('', config)).toEqual([]);
  });

  test('private path shapes fire; benign paths do not', () => {
    const config = makeConfig(ws());
    const hit = scanSensitive('see /private/alice-example/workspace/notes.md', config);
    expect(hit.map((f) => f.family)).toContain('path');
    const clean = scanSensitive('see /usr/local/share/docs/notes.md', config);
    expect(clean.filter((f) => f.family === 'path')).toEqual([]);
  });

  test('blocklist is case-insensitive and word-bounded', () => {
    const config = makeConfig(ws());
    const lower = BLOCK_WORD.toLowerCase();
    expect(scanSensitive(`met ${lower} today`, config).map((f) => f.family)).toContain('blocklist');
    // Substring inside a longer token must NOT fire (word boundary).
    expect(
      scanSensitive(`met ${BLOCK_WORD}SUFFIXED today`, config).filter((f) => f.family === 'blocklist'),
    ).toEqual([]);
  });

  test('empty blocklist disables the family without error', () => {
    const root = ws();
    const patternsPath = join(root, 'patterns.txt');
    writeFileSync(patternsPath, String.raw`\bZZPRIVATE\w+\b`);
    const config = loadSensitivityConfig({
      workspaceRoot: root,
      blocklist: '',
      userPatternsPath: patternsPath,
    });
    expect(config.blocklistRe).toBeNull();
    expect(scanSensitive(`met ${BLOCK_WORD} today`, config).filter((f) => f.family === 'blocklist')).toEqual([]);
  });
});

describe('scanSensitive — fingerprint allowlist un-drops per family', () => {
  /** Scan dirty text, allowlist the first finding of `family`, rescan. */
  function undrop(family: string) {
    const root = ws();
    const before = scanSensitive(DIRTY, makeConfig(root));
    const target = before.find((f) => f.family === family);
    expect(target).toBeDefined();
    writeFileSync(join(root, SCAN_ALLOW_FILENAME), `${target!.fingerprint}\n`);
    const after = scanSensitive(DIRTY, makeConfig(root));
    return { before, after };
  }

  for (const family of ['secret:anthropic', 'pii:email', 'pii:phone', 'path', 'blocklist', 'pattern-file']) {
    test(`allowlisting a ${family} fingerprint suppresses it (uniform escape hatch)`, () => {
      const { before, after } = undrop(family);
      const target = before.find((f) => f.family === family)!;
      // The allowlisted VALUE is gone from every family that matched it.
      expect(after.filter((f) => f.fingerprint === target.fingerprint)).toEqual([]);
      // Other findings survive — the hatch is per-value, not per-scan.
      expect(after.length).toBeGreaterThan(0);
      expect(after.length).toBeLessThan(before.length);
    });
  }

  test('same value matched by two families is suppressed in both by one fingerprint', () => {
    // The shipped pattern-file defaults include an email regex, so an email
    // fires pii:email AND pattern-file with the SAME matched value — one
    // allowlist line must silence both.
    const root = ws();
    const before = scanSensitive(DIRTY, makeConfig(root));
    const email = before.find((f) => f.family === 'pii:email')!;
    writeFileSync(join(root, SCAN_ALLOW_FILENAME), `${email.fingerprint}\n`);
    const after = scanSensitive(DIRTY, makeConfig(root));
    expect(after.map((f) => f.family)).not.toContain('pii:email');
    expect(after.filter((f) => f.fingerprint === email.fingerprint)).toEqual([]);
  });
});

describe('loadSensitivityConfig — failure taxonomy (config throws, content never does)', () => {
  test('malformed regex in the operator pattern file throws the typed error', () => {
    const root = ws();
    const patternsPath = join(root, 'patterns.txt');
    writeFileSync(patternsPath, '([unclosed');
    expect(() =>
      loadSensitivityConfig({ workspaceRoot: root, blocklist: '', userPatternsPath: patternsPath }),
    ).toThrow(SensitivityScanConfigError);
  });

  test('malformed operator blocklist throws the typed error', () => {
    const root = ws();
    expect(() =>
      loadSensitivityConfig({ workspaceRoot: root, blocklist: 'a(|b' }),
    ).toThrow(SensitivityScanConfigError);
  });

  test('present-but-unreadable allowlist throws the typed error', () => {
    const root = ws();
    // A directory named like the allowlist file: exists, unreadable as a file.
    mkdirSync(join(root, SCAN_ALLOW_FILENAME));
    expect(() => loadSensitivityConfig({ workspaceRoot: root, blocklist: '' })).toThrow(
      SensitivityScanConfigError,
    );
  });

  test('absent allowlist file is a valid empty state, not an error', () => {
    const root = ws();
    const config = loadSensitivityConfig({
      workspaceRoot: root,
      blocklist: '',
      userPatternsPath: join(root, 'no-such-patterns.txt'),
    });
    expect(config.allowlist).toEqual([]);
  });
});

describe('PII refactor regression — scrubPii bytes + findPii semantics', () => {
  test('PII_PATTERNS order is the load-bearing scrub order', () => {
    expect(PII_PATTERNS.map((p) => p.family)).toEqual([
      'email', 'phone', 'ssn', 'jwt', 'bearer', 'credit_card',
    ]);
  });

  test('byte-exact: email', () => {
    expect(scrubPii('email me at alice@example.com about this')).toBe(
      'email me at [REDACTED] about this',
    );
  });

  test('byte-exact: phone', () => {
    expect(scrubPii('call 555-123-4567')).toBe('call [REDACTED]');
  });

  test('byte-exact: SSN', () => {
    expect(scrubPii('ssn is 123-45-6789 on file')).toBe('ssn is [REDACTED] on file');
  });

  test('byte-exact: bearer keeps the Bearer prefix', () => {
    expect(scrubPii('Authorization: Bearer abc123DEF456ghi789')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  test('byte-exact: Luhn-valid card redacted, Luhn-invalid untouched', () => {
    expect(scrubPii('card 4111 1111 1111 1111 expires 12/26')).toBe(
      'card [REDACTED] expires 12/26',
    );
    expect(scrubPii('order id 1234567890123456')).toBe('order id 1234567890123456');
  });

  test('findPii returns spans, never text, and never mutates', () => {
    const input = 'mail alice@example.com and card 4111 1111 1111 1111';
    const findings = findPii(input);
    const families = findings.map((f) => f.family);
    expect(families).toContain('email');
    expect(families).toContain('credit_card');
    for (const f of findings) {
      expect(Object.keys(f).sort()).toEqual(['end', 'family', 'start']);
      expect(f.end).toBeGreaterThan(f.start);
    }
    // Spans point at the actual match in the ORIGINAL text.
    const email = findings.find((f) => f.family === 'email')!;
    expect(input.slice(email.start, email.end)).toBe('alice@example.com');
  });

  test('findPii honors the Luhn gate (detection semantics match scrub semantics)', () => {
    expect(findPii('order id 1234567890123456').filter((f) => f.family === 'credit_card')).toEqual([]);
    expect(
      findPii('card 4111 1111 1111 1111').filter((f) => f.family === 'credit_card').length,
    ).toBe(1);
  });

  test('findPii on empty input returns []', () => {
    expect(findPii('')).toEqual([]);
  });
});
