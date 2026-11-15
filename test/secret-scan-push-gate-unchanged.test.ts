/**
 * GST-2768 PR 1: the cookie_header rule, the .netrc password form and the
 * cross-line / cross-message label join are transcript-lane opt-ins. Every
 * other lane (the sources-push gate and bootstrap verify with default
 * options, the compiled-context scan, the highEntropy-only redactors, the
 * labeled-credential callers outside transcripts) must give byte-identical
 * results on the synthetic credential corpus before and after.
 *
 * The golden was generated on master before the change
 * (GBRAIN_TEST_UPDATE_GOLDENS=1). It stores only rule names, line numbers,
 * fingerprints and sha256 digests of previews and redacted output, never text.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as scan from '../src/core/secret-scan.ts';
import { COOKIE_PROSE_NEGATIVES, SYNTHETIC_CREDENTIAL_CORPUS } from './fixtures/transcripts/synthetic-credentials.ts';

const GOLDEN = join(import.meta.dir, 'fixtures/transcripts/synthetic-credentials.shared-scanner.golden.json');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const OPTION_SETS: Record<string, scan.ScanOpts> = {
  default: {},
  highEntropy: { highEntropy: true },
  labeledCredentials: { labeledCredentials: true },
  highEntropyLabeled: { highEntropy: true, labeledCredentials: true },
};

function texts(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of SYNTHETIC_CREDENTIAL_CORPUS) {
    e.messages.forEach((m, i) => out.push([`${e.id}#${i}`, m]));
    out.push([`${e.id}#joined`, e.messages.join('\n')]);
  }
  COOKIE_PROSE_NEGATIVES.forEach((t, i) => out.push([`prose#${i}`, t]));
  return out;
}

function snapshot(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, opts] of Object.entries(OPTION_SETS)) {
    const perText: Record<string, unknown> = {};
    for (const [id, text] of texts()) {
      const plan = scan.planRedaction(text, opts);
      perText[id] = {
        findings: scan.scanText(text, opts).map((f) => [f.pattern, f.line, f.fingerprint, sha(f.redactedPreview), f.since ?? null]),
        redacted: sha(scan.applyRedaction(plan)),
      };
    }
    out[name] = perText;
  }
  return out;
}

describe('shared scanner unchanged outside the transcript lane', () => {
  test('every non-transcript option set matches the pre-change golden byte for byte', () => {
    const now = snapshot();
    if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
    expect(now).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  test('the transcript-lane options are the shared defaults plus the transcript rules', () => {
    expect(scan.TRANSCRIPT_LANE_SCAN_OPTS).toEqual({ highEntropy: true, labeledCredentials: true, transcriptRules: true });
  });

  test('the new rules fire only with the transcript-lane options', () => {
    const cookie = SYNTHETIC_CREDENTIAL_CORPUS.filter((e) => e.kind === 'cookie_header');
    expect(cookie.length).toBeGreaterThan(0);
    for (const e of cookie) {
      const text = e.messages.join('\n');
      for (const opts of Object.values(OPTION_SETS)) expect(scan.scanText(text, opts).some((f) => f.pattern === 'cookie_header')).toBe(false);
      expect(scan.scanText(text, scan.TRANSCRIPT_LANE_SCAN_OPTS).some((f) => f.pattern === 'cookie_header')).toBe(true);
    }
    const netrc = SYNTHETIC_CREDENTIAL_CORPUS.find((e) => e.id === 'netrc-line')!;
    for (const opts of Object.values(OPTION_SETS)) expect(scan.redactFindings(netrc.messages[0]!, opts).text).toContain(netrc.secrets[0]!);
    expect(scan.redactFindings(netrc.messages[0]!, scan.TRANSCRIPT_LANE_SCAN_OPTS).text).not.toContain(netrc.secrets[0]!);
  });
});
