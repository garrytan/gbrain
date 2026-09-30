/**
 * secret-scan (agent-bootstrap ENG-9/CX2-15/S3#2): every pattern class fires,
 * benign lookalikes don't, previews never contain the value, the per-workspace
 * allowlist overrides per-finding (fingerprint) or per-path (glob), and
 * corpus-write redaction replaces spans in place with <REDACTED:pattern>.
 *
 * All "secrets" below are synthetic fixtures (this file is inside the
 * .gitleaks.toml test/ allowlist — the CI policy; the module under test
 * deliberately does NOT import that allowlist [CX2-15]).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanText, scanFiles, redactFindings, loadWorkspaceAllowlist, matchesGlob,
  globToRegExp, shannonEntropy, pathAllowlisted, SCAN_ALLOW_FILENAME,
  PEM_BODY_MAX_CHARS, ECHO_MIN_CHARS_BEARER, ECHO_MIN_CHARS_ENTROPY, ECHO_MAX_UNIQUE,
  ECHO_MAX_VALUE_CHARS, planRedaction, applyRedaction,
} from '../src/core/secret-scan.ts';

// Synthetic fixture values (never real keys).
const OPENAI = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
const OPENAI_PROJ = 'sk-proj-' + 'Ab1_Cd2-Ef3gH4iJ5kL6mN7oP8';
const OPENAI_SVCACCT = 'sk-svcacct-' + 'Zz1_Yy2-Xx3wV4uT5sR6qP7oN8';
const OPENAI_NONE = 'sk-None-' + 'Qq1_Ww2-Ee3rT4yU5iO6pA7sD8';
const VOYAGE = 'pa-' + 'Vv1Bb2Nn3Mm4Kk5Jj6Hh7Gg8Ff9';
const ANTHROPIC = 'sk-ant-' + 'api03-Zz9Yy8Xx7Ww6Vv5Uu4Tt3';
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const GHO = 'gho_' + 'B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9';
const GH_PAT = 'github_pat_' + '11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb';
const SLACK = 'xoxb-' + '123456789012-abcdefABCDEF';
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const GBRAIN_HEX = '0123456789abcdef'.repeat(4);
const PEM = '-----BEGIN RSA PRIVATE KEY-----';

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});
function ws(): string {
  tmp = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  return tmp;
}

describe('scanText — pattern classes', () => {
  test('detects every pattern class with correct names + line numbers', () => {
    const text = [
      `export OPENAI_API_KEY=${OPENAI}`,          // line 1
      'benign line',                               // line 2
      `anthropic: ${ANTHROPIC}`,                   // line 3
      `token = "${GHP}"`,                          // line 4
      `refresh ${GHO}`,                            // line 5
      `fine_grained: ${GH_PAT}`,                   // line 6
      `slack bot ${SLACK}`,                        // line 7
      `aws_access_key_id = ${AWS}`,                // line 8
      PEM,                                         // line 9
    ].join('\n');
    const findings = scanText(text);
    const byPattern = new Map(findings.map((f) => [f.pattern, f]));
    expect(byPattern.get('openai')?.line).toBe(1);
    expect(byPattern.get('anthropic')?.line).toBe(3);
    expect(byPattern.get('github_pat')?.line).toBe(6);
    expect(byPattern.get('slack')?.line).toBe(7);
    expect(byPattern.get('aws_access_key')?.line).toBe(8);
    expect(byPattern.get('private_key_pem')?.line).toBe(9);
    // both github token forms fire as github_token
    const ghLines = findings.filter((f) => f.pattern === 'github_token').map((f) => f.line).sort();
    expect(ghLines).toEqual([4, 5]);
    expect(findings.length).toBe(8);
  });

  test('prefixed OpenAI forms (sk-proj-/sk-svcacct-/sk-None-) fire as openai, once each', () => {
    for (const key of [OPENAI_PROJ, OPENAI_SVCACCT, OPENAI_NONE]) {
      const findings = scanText(`key=${key}`);
      expect(findings.map((f) => f.pattern)).toEqual(['openai']);
      expect(JSON.stringify(findings).includes(key)).toBe(false);
    }
  });

  test("gbrain's own tokens (generateToken prefix family) fire as gbrain_token", () => {
    // '' = legacy bearer (auth create / token-mint / serve-http); the rest are
    // the OAuth forms from oauth-provider.ts, gbrain_at_ being the /mcp bearer.
    for (const infix of ['', 'at_', 'rt_', 'cs_', 'code_']) {
      const findings = scanText(`Authorization: Bearer gbrain_${infix}${GBRAIN_HEX}`);
      expect(findings.map((f) => f.pattern)).toEqual(['gbrain_token']);
    }
  });

  test('a gbrain_cl_ client id (public identifier) does not fire', () => {
    expect(scanText(`client_id=gbrain_cl_${GBRAIN_HEX}`)).toEqual([]);
  });

  test('a Voyage key (pa-…, PROVIDER_KEY_SHAPES shape) fires as voyage', () => {
    const findings = scanText(`voyage_api_key: ${VOYAGE}`);
    expect(findings.map((f) => f.pattern)).toEqual(['voyage']);
    expect(JSON.stringify(findings).includes(VOYAGE)).toBe(false);
    expect(findings[0]!.redactedPreview).toContain('<REDACTED:voyage>');
  });

  test('an anthropic key is NOT double-reported as a generic openai match', () => {
    const findings = scanText(`key=${ANTHROPIC}`);
    expect(findings.map((f) => f.pattern)).toEqual(['anthropic']);
  });

  test('benign lookalikes do not fire', () => {
    const text = [
      'skill-router dispatches to the right sub-skill',
      'ghost_pattern and ghost_writer are fine identifiers',
      'the risk-assessmentresultsdata2024 report',          // embedded sk- inside a word
      'task-management-systems-for-founders-and-agents',
      'xoxo love, the changelog',                            // not xox[baprs]-
      'AKIAXX',                                              // too short
      `gbrain_${'ab'.repeat(16)} is a 32-hex config id`,     // token body is 64 hex
      'the gbrain_token pattern name itself',                // identifier, no hex body
      '-----BEGIN CERTIFICATE-----',                         // not a private key
    ].join('\n');
    expect(scanText(text)).toEqual([]);
  });

  test('previews and findings NEVER contain the secret value', () => {
    const text = `a=${OPENAI}\nb=${SLACK}\npem:\n${PEM}`;
    const findings = scanText(text);
    expect(findings.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(findings);
    expect(serialized.includes(OPENAI)).toBe(false);
    expect(serialized.includes(SLACK)).toBe(false);
    for (const f of findings) {
      expect(f.redactedPreview).toContain(`<REDACTED:${f.pattern}>`);
    }
  });

  test('fingerprint is stable and sha256-prefixed', () => {
    const [a] = scanText(`x=${OPENAI}`);
    const [b] = scanText(`totally different context ${OPENAI} here`);
    expect(a!.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(a!.fingerprint).toBe(b!.fingerprint);
  });
});

describe('high-entropy heuristic (off by default)', () => {
  const HI = 'aB3xZ9qL7mNp2Rt5Vw8Yk1D4';
  test('off by default — an entropic assignment is not flagged', () => {
    expect(scanText(`api_key = "${HI}"`)).toEqual([]);
  });
  test('opt-in flags entropic assignments, skips low-entropy ones', () => {
    const hits = scanText(`api_key = "${HI}"`, { highEntropy: true });
    expect(hits.map((f) => f.pattern)).toEqual(['high_entropy_assignment']);
    expect(scanText(`password = "aaaaaaaaaaaaaaaaaaaaaaaa"`, { highEntropy: true })).toEqual([]);
  });
  test('shannonEntropy sanity', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy(HI)).toBeGreaterThan(3.5);
  });
});

describe('allowlist', () => {
  test('fingerprint entry suppresses exactly that finding', () => {
    const [f] = scanText(`x=${OPENAI}\ny=${SLACK}`);
    const remaining = scanText(`x=${OPENAI}\ny=${SLACK}`, { allowlist: [f!.fingerprint] });
    expect(remaining.map((r) => r.pattern)).toEqual(['slack']);
  });

  test('a short fingerprint prefix (<16 hex) never matches', () => {
    const [f] = scanText(`x=${OPENAI}`);
    // 4 hex — well below the floor.
    const tiny = f!.fingerprint.slice(0, 'sha256:'.length + 4);
    expect(scanText(`x=${OPENAI}`, { allowlist: [tiny] }).length).toBe(1);
    // 12 hex — used to pass under the old 8-hex floor; now rejected.
    const twelve = f!.fingerprint.slice(0, 'sha256:'.length + 12);
    expect(twelve.length).toBe('sha256:'.length + 12);
    expect(scanText(`x=${OPENAI}`, { allowlist: [twelve] }).length).toBe(1);
    // The full 16-hex fingerprint (what the tool emits) still suppresses.
    expect(scanText(`x=${OPENAI}`, { allowlist: [f!.fingerprint] }).length).toBe(0);
  });

  test('loadWorkspaceAllowlist: absent file → EMPTY default [CX2-15]', () => {
    expect(loadWorkspaceAllowlist(ws())).toEqual([]);
  });

  test('loadWorkspaceAllowlist: parses entries, skips comments + blanks', () => {
    const root = ws();
    writeFileSync(
      join(root, SCAN_ALLOW_FILENAME),
      '# comment\n\nfixtures/**\nsha256:0123456789abcdef\n  spaced.md  \n',
    );
    expect(loadWorkspaceAllowlist(root)).toEqual(['fixtures/**', 'sha256:0123456789abcdef', 'spaced.md']);
  });

  test('glob entry suppresses a whole file in scanFiles', () => {
    const root = ws();
    mkdirSync(join(root, 'fixtures'), { recursive: true });
    writeFileSync(join(root, 'fixtures', 'keys.md'), `k=${OPENAI}\n`);
    writeFileSync(join(root, 'real.md'), `k=${OPENAI}\n`);
    const allowlist = ['fixtures/**'];
    const findings = scanFiles(
      [join(root, 'fixtures', 'keys.md'), join(root, 'real.md')],
      { allowlist, workspaceRoot: root },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.file).toBe(join(root, 'real.md'));
  });
});

describe('scanFiles', () => {
  test('skips binary files (NUL sniff) and unreadable paths', () => {
    const root = ws();
    const bin = join(root, 'blob.bin');
    writeFileSync(bin, Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(OPENAI)]));
    const txt = join(root, 'note.md');
    writeFileSync(txt, `${OPENAI}\n`);
    const findings = scanFiles([bin, txt, join(root, 'missing.md')]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.file).toBe(txt);
    expect(findings[0]!.line).toBe(1);
  });
});

describe('redactFindings (corpus-write mode, S3#2)', () => {
  test('replaces every span in place with <REDACTED:pattern>', () => {
    const text = `intro\nsaid: my key is ${OPENAI} ok?\nand slack ${SLACK}\nrepeat ${OPENAI}\n`;
    const { text: out, redactions } = redactFindings(text);
    expect(out.includes(OPENAI)).toBe(false);
    expect(out.includes(SLACK)).toBe(false);
    expect(out).toContain('<REDACTED:openai>');
    expect(out).toContain('<REDACTED:slack>');
    // one redaction record per occurrence (2 openai + 1 slack)
    expect(redactions.length).toBe(3);
    // non-secret content survives byte-for-byte
    expect(out.startsWith('intro\nsaid: my key is ')).toBe(true);
    expect(out.endsWith(' ok?\nand slack <REDACTED:slack>\nrepeat <REDACTED:openai>\n')).toBe(true);
  });

  test('prefixed openai + voyage keys are redacted in place', () => {
    const text = `proj: ${OPENAI_PROJ}\nvoyage: ${VOYAGE}\n`;
    const { text: out, redactions } = redactFindings(text);
    expect(out.includes(OPENAI_PROJ)).toBe(false);
    expect(out.includes(VOYAGE)).toBe(false);
    expect(out).toBe('proj: <REDACTED:openai>\nvoyage: <REDACTED:voyage>\n');
    expect(redactions.map((r) => r.pattern).sort()).toEqual(['openai', 'voyage']);
  });

  test('allowlisted values are left intact (declared safe)', () => {
    const [f] = scanText(`x=${OPENAI}`);
    const { text: out, redactions } = redactFindings(`x=${OPENAI}`, { allowlist: [f!.fingerprint] });
    expect(out).toBe(`x=${OPENAI}`);
    expect(redactions).toEqual([]);
  });

  test('a full PEM block is redacted whole — no base64 body line survives', () => {
    // Synthetic key material (never a real key). The body lines are the leak
    // the header-only pattern used to leave in the corpus.
    const body = [
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
      'MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu',
      'NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ',
    ].join('\n');
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const text = `notes before\n${pem}\nnotes after\n`;

    const { text: out, redactions } = redactFindings(text);
    // The body base64 must be GONE — not just the header line.
    for (const line of body.split('\n')) {
      expect(out.includes(line)).toBe(false);
    }
    expect(out.includes('-----END RSA PRIVATE KEY-----')).toBe(false);
    expect(out).toContain('<REDACTED:private_key_pem>');
    // Surrounding prose survives.
    expect(out.startsWith('notes before\n')).toBe(true);
    expect(out.endsWith('\nnotes after\n')).toBe(true);
    const pemRedactions = redactions.filter((r) => r.pattern === 'private_key_pem');
    expect(pemRedactions.length).toBe(1);
    // The finding preview never leaks the body either.
    expect(pemRedactions[0]!.redactedPreview).toContain('<REDACTED:private_key_pem>');
    for (const line of body.split('\n')) {
      expect(pemRedactions[0]!.redactedPreview.includes(line)).toBe(false);
    }
  });

  test('scanText finds a full PEM block; a lone header still blocks the push', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\n-----END RSA PRIVATE KEY-----';
    const full = scanText(`k:\n${pem}\n`);
    expect(full.map((f) => f.pattern)).toEqual(['private_key_pem']);
    expect(full[0]!.line).toBe(2); // header line
    expect(JSON.stringify(full).includes('MIIEvQIBADANBgkqhkiG9w0BAQEF')).toBe(false);

    // Lone/truncated header (no END) — the push-block gate must still fire.
    const header = scanText('leaked: -----BEGIN RSA PRIVATE KEY-----\n');
    expect(header.map((f) => f.pattern)).toEqual(['private_key_pem']);
  });

  test('several PEM blocks report exact 1-based header lines (incremental line cursor)', () => {
    // Header/footer joined from fragments so the committed source never carries a whole PEM block (gitleaks private-key rule).
    const key = (b: string) => [['-----BEGIN', ' EC PRIVATE KEY', '-----'].join(''), b, ['-----END', ' EC PRIVATE KEY', '-----'].join('')].join('\n');
    const text = [
      'a',                       // 1
      key('MHcCAQEEIBody0001'),  // 2-4
      'b',                       // 5
      key('MHcCAQEEIBody0002'),  // 6-8
      'c',                       // 9
      ['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join(''), // 10, header-only, last so no later END can extend it
    ].join('\n');
    const findings = scanText(text);
    expect(findings.map((f) => f.pattern)).toEqual(['private_key_pem', 'private_key_pem', 'private_key_pem']);
    expect(findings.map((f) => f.line)).toEqual([2, 6, 10]);
    const { text: out } = redactFindings(text);
    expect(out).toBe('a\n<REDACTED:private_key_pem>\nb\n<REDACTED:private_key_pem>\nc\n<REDACTED:private_key_pem>');
  });

  test(`the PEM body bound is exactly ${PEM_BODY_MAX_CHARS} chars (pinned so an edit is a visible edit)`, () => {
    // Body = everything between the header and the END marker, newlines
    // included. At the bound the whole block (body + END) is one redacted
    // span; one char over degrades to the header-only match — the gate still
    // fires, the body is the accepted miss (an RSA-16384 PEM is ~12.5 KB).
    // Header/footer joined from fragments (see above).
    const wrap = (body: string) => ['-----BEGIN', ' RSA PRIVATE KEY', '-----', body, '-----END', ' RSA PRIVATE KEY', '-----'].join('');
    const atBound = wrap('\n' + 'Q'.repeat(PEM_BODY_MAX_CHARS - 2) + '\n');
    let { text: out } = redactFindings(atBound);
    expect(out).toBe('<REDACTED:private_key_pem>');
    const overBound = wrap('\n' + 'Q'.repeat(PEM_BODY_MAX_CHARS - 1) + '\n');
    const findings = scanText(overBound);
    expect(findings.map((f) => f.pattern)).toEqual(['private_key_pem']);
    ({ text: out } = redactFindings(overBound));
    expect(out.startsWith('<REDACTED:private_key_pem>\nQ')).toBe(true);
    expect(out.endsWith('-----END RSA PRIVATE KEY-----')).toBe(true);
  });
});

describe('glob dialect (shared with the push deny-list)', () => {
  test('basename globs match at any depth; path globs anchor at root', () => {
    expect(matchesGlob('*.pglite', 'brain.pglite')).toBe(true);
    expect(matchesGlob('*.pglite', 'deep/nested/brain.pglite')).toBe(true);
    expect(matchesGlob('.env*', '.env')).toBe(true);
    expect(matchesGlob('.env*', 'sub/.env.local')).toBe(true);
    expect(matchesGlob('.env*', 'environments.md')).toBe(false);
    expect(matchesGlob('*.pem', 'certs/server.pem')).toBe(true);
    expect(matchesGlob('*.key', 'k.key')).toBe(true);
    expect(matchesGlob('.gbrain/**', '.gbrain/brain.db')).toBe(true);
    expect(matchesGlob('.gbrain/**', '.gbrain/a/b/c')).toBe(true);
    expect(matchesGlob('.gbrain/**', 'sub/.gbrain/x')).toBe(false); // anchored
    expect(matchesGlob('docs/*.md', 'docs/a.md')).toBe(true);
    expect(matchesGlob('docs/*.md', 'docs/sub/a.md')).toBe(false); // * stays in segment
  });
  test('globToRegExp escapes regex metachars', () => {
    expect(globToRegExp('a+b.md').test('a+b.md')).toBe(true);
    expect(globToRegExp('a+b.md').test('aab.md')).toBe(false);
    expect(pathAllowlisted('x (1).md', ['x (1).md'])).toBe(true);
  });
});

describe('high-entropy assignment reaches compound credential keys', () => {
  const HI = 'Ab3xK9mQ2pR7sT1vW4yZ8bC5dE6f';
  // `\b`-style boundaries cannot match inside `api_access_token`, and a
  // keyword-adjacent anchor cannot match `AWS_SECRET_ACCESS_KEY` at all —
  // `SECRET` is not the segment touching the `=`. Both shapes leaked to an
  // external API before this rule was widened AND enabled at the call site.
  for (const [name, input] of [
    ['underscore-separated keyword', `api_access_token: ${HI}`],
    ['screaming snake case', `SMTP_PASSWORD=${HI}`],
    ['keyword with trailing segments', `AWS_SECRET_ACCESS_KEY=${HI}`],
  ] as const) {
    test(name, () => {
      expect(scanText(input, { highEntropy: true }).map((f) => f.pattern)).toEqual(['high_entropy_assignment']);
    });
  }

  test('the value floor is exactly 12 — the 16-char-SMTP-password class that motivated it stays covered', () => {
    // 12 distinct chars = log2(12) ≈ 3.585 bits/char, just over the 3.5 gate.
    expect(scanText('password=aB3xK9mQ2pR7', { highEntropy: true }).map((f) => f.pattern)).toEqual(['high_entropy_assignment']);
    // 11 chars can never reach 3.5 bits/char (log2(11) ≈ 3.46) — and the
    // regex floor refuses it first. Pinned so a floor edit is a visible edit.
    expect(scanText('password=aB3xK9mQ2pR', { highEntropy: true })).toEqual([]);
  });

  test('the widened keywords passphrase and credential fire', () => {
    for (const k of ['passphrase', 'credential'] as const) {
      expect(scanText(`${k}=${HI}`, { highEntropy: true }).map((f) => f.pattern)).toEqual(['high_entropy_assignment']);
    }
  });

  test('the keyword may carry up to 64 trailing identifier chars before the `=` (bounded, closes a quadratic)', () => {
    // `[A-Za-z0-9_-]*` after the keyword ran to end-of-line and backtracked
    // once per `-`/`_` in an adversarial run (secret-scan-perf pins the
    // timing); `{0,64}` keeps AWS_SECRET_ACCESS_KEY-style compounds and
    // anything a real config key could plausibly be named.
    const tail64 = '_' + 'X'.repeat(63);
    expect(scanText(`SECRET${tail64}=${HI}`, { highEntropy: true }).map((f) => f.pattern)).toEqual(['high_entropy_assignment']);
    expect(scanText(`SECRET${tail64}X=${HI}`, { highEntropy: true })).toEqual([]);
  });

  test('the value is redacted through 4096 chars (pinned so a bound edit is a visible edit)', () => {
    // The cap gives the rule constant work per occurrence; a longer value is
    // redacted only through its first 4096 chars — the accepted miss, well
    // above any real token or base64 key blob.
    const v4096 = (HI + '0').repeat(4096 / (HI.length + 1) + 1).slice(0, 4096);
    expect(v4096.length).toBe(4096);
    expect(redactFindings(`token=${v4096}`, { highEntropy: true }).text).toBe('token=<REDACTED:high_entropy_assignment>');
    expect(redactFindings(`token=${v4096}Z`, { highEntropy: true }).text).toBe('token=<REDACTED:high_entropy_assignment>Z');
  });

  /** Known limitation, asserted so it stays visible rather than being
   * rediscovered. The left boundary requires the keyword to START at a
   * non-alphanumeric, so a camelCase compound (`apiAccessToken`) is out of
   * reach here. Dropping the boundary would let the keyword fire mid-word in
   * ordinary prose, and this pattern is shared with gbrain's corpus scanning.
   * The consumer's own scrub normalises separators and DOES cover this shape,
   * and it is the last pass before anything leaves the machine. */
  test('camelCase compounds are NOT covered by this rule', () => {
    expect(scanText(`apiAccessToken=${HI}`, { highEntropy: true })).toEqual([]);
  });

  // The rule runs over tool-call arguments, which ARE the recall signal.
  test('leaves paths, commands and hashes alone', () => {
    for (const s of [
      'src/core/context/hook-heartbeat.ts',
      'cd ~/Documents/GitHub/memorable-gbrain && bun test',
      'commit 3e365f5f1a2b4c8d9e0f1a2b3c4d5e6f70819293',
      'export NODE_OPTIONS=--max-old-space-size=8192',
    ]) {
      expect(scanText(s, { highEntropy: true })).toEqual([]);
    }
  });
});

// ── Format-based detectors (unprefixed credential shapes) ───────────────────
//
// Every seeded value below is SYNTHETIC and assembled at runtime from >= 2
// fragments so no committed line carries a credential-shaped literal (the
// wave security scan runs gitleaks with the allowlist stripped). Constant
// names keep scanner keywords away from the `=`.
const JWT_SEGMENTS = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzAwMDAwMDAwfQ',
  'c2lnbmF0dXJlLXBsYWNlaG9sZGVyLTAwMDA',
];
const JWT = JWT_SEGMENTS.join('.');
const ASIA_ID = ['ASIA', 'Q3EXAMPLE7ABCDEF'].join(''); // 16 after the prefix
const GOOGLE_SHAPE = ['AIza', 'SyD1-Fake_Example0123456789abcdefGH'].join('');
const STRIPE_LIVE = ['sk_live_', '4eC39HqLyjWDarjtT1zdp7dc'].join('');
const STRIPE_RESTRICTED = ['rk_test_', 'Ab12Cd34Ef56Gh78Ij90Kl'].join('');
const STRIPE_WEBHOOK = ['whsec_', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34'].join('');
const SENDGRID_SHAPE = ['SG', '.abcDEF123_ghiJKL456', '.mnoPQR789-stuVWX012'].join('');
const TWILIO_SID = ['AC', '0123456789abcdef', '0123456789abcdef'].join('');
const TWILIO_SIGNING = ['SK', 'fedcba9876543210', 'fedcba9876543210'].join('');
const SUPABASE_SB = ['sb_secret_', 'exampleplaceholdervalue00'].join(''); // low-entropy value: matches sb_secret_[A-Za-z0-9_-]{20,} but stays under gitleaks' generic-api-key entropy gate
const SUPABASE_SBP = ['sbp_', '0123456789abcdef0123456789abcdef01234567'].join('');
const GITLAB_SHAPE = ['glpat-', 'Ab12Cd34Ef56Gh78Ij90Kl'].join('');
const NPM_SHAPE = ['npm_', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78'].join('');
const HF_SHAPE = ['hf_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('');
const OPAQUE_BEARER_VALUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');
const DB_URL_CREDS = ['postgres://', 'dbuser', ':', 'p4ssw0rd', '@'].join('');
const DB_URL = DB_URL_CREDS + 'db.internal:5432/app';
const MONGO_SRV_URL = ['mongodb+srv://', 'app', ':', 'p4ss', '@cluster0.internal/db'].join('');
const REDIS_NOUSER_URL = ['redis://', ':', 'r3dis', '@cache.internal:6379'].join('');

describe('format-based detectors — attribution per pattern (unprefixed credential shapes)', () => {
  const cases: Array<[string, string, string]> = [
    ['jwt', 'service role', JWT],
    ['aws_access_key', 'temporary aws id', ASIA_ID],
    ['google_api_key', 'maps', GOOGLE_SHAPE],
    ['stripe', 'live', STRIPE_LIVE],
    ['stripe', 'restricted', STRIPE_RESTRICTED],
    ['stripe', 'webhook signing', STRIPE_WEBHOOK],
    ['sendgrid', 'mail', SENDGRID_SHAPE],
    ['twilio', 'account sid', TWILIO_SID],
    ['twilio', 'signing key', TWILIO_SIGNING],
    ['supabase_key', 'sb_secret form', SUPABASE_SB],
    ['supabase_key', 'sbp management token', SUPABASE_SBP],
    ['gitlab_pat', 'gitlab', GITLAB_SHAPE],
    ['npm_token', 'npm', NPM_SHAPE],
    ['huggingface', 'hf', HF_SHAPE],
    ['db_url_credentials', 'postgres url', DB_URL],
    ['db_url_credentials', 'mongodb+srv url', MONGO_SRV_URL],
    ['db_url_credentials', 'redis url with empty user', REDIS_NOUSER_URL],
  ];
  for (const [pattern, label, value] of cases) {
    test(`${pattern} (${label}) fires exactly once and never leaks the value`, () => {
      const findings = scanText(`note: ${value} end`);
      expect(findings.map((f) => f.pattern)).toEqual([pattern]);
      expect(JSON.stringify(findings).includes(value)).toBe(false);
      expect(findings[0]!.redactedPreview).toContain(`<REDACTED:${pattern}>`);
      const { text } = redactFindings(`x ${value} y`);
      expect(text.includes(value)).toBe(false);
      expect(text).toContain(`<REDACTED:${pattern}>`);
    });
  }

  test('connection-string redaction keeps the host/db, drops only the credential span', () => {
    const { text } = redactFindings(`DATABASE_URL=${DB_URL}`);
    expect(text).toBe('DATABASE_URL=<REDACTED:db_url_credentials>db.internal:5432/app');
    expect(text.includes('p4ssw0rd')).toBe(false);
  });

  test('the advisory-shaped session line: JWT + account SID both redacted, prose intact', () => {
    const line = `deploy is failing. service role key ${JWT} and twilio sid ${TWILIO_SID}`;
    const { text, redactions } = redactFindings(line);
    expect(redactions.map((r) => r.pattern).sort()).toEqual(['jwt', 'twilio']);
    expect(text).toBe('deploy is failing. service role key <REDACTED:jwt> and twilio sid <REDACTED:twilio>');
  });
});

describe('format-based detectors — ordering + catch-all attribution', () => {
  test('Bearer <jwt> attributes to jwt (specific wins over the bearer catch-all)', () => {
    const findings = scanText(`Authorization: Bearer ${JWT}`);
    expect(findings.map((f) => f.pattern)).toEqual(['jwt']);
  });

  test('Bearer <opaque token> attributes to bearer; the header word survives redaction', () => {
    const findings = scanText(`Authorization: Bearer ${OPAQUE_BEARER_VALUE}`);
    expect(findings.map((f) => f.pattern)).toEqual(['bearer']);
    const { text } = redactFindings(`Authorization: Bearer ${OPAQUE_BEARER_VALUE}`);
    expect(text).toBe('Authorization: Bearer <REDACTED:bearer>');
    // lowercase header word too
    expect(scanText(`authorization: bearer ${OPAQUE_BEARER_VALUE}`).map((f) => f.pattern)).toEqual(['bearer']);
  });

  test('Bearer <vendor key> keeps the vendor attribution (existing contract, pinned against the catch-all)', () => {
    expect(scanText(`Bearer ${ANTHROPIC}`).map((f) => f.pattern)).toEqual(['anthropic']);
    expect(scanText(`Bearer gbrain_at_${GBRAIN_HEX}`).map((f) => f.pattern)).toEqual(['gbrain_token']);
    expect(scanText(`Bearer ${GHP}`).map((f) => f.pattern)).toEqual(['github_token']);
  });

  test('a JWT used as a connection-string password: jwt reports the token once; db_url_credentials still covers the userinfo around it', () => {
    // Attribution is first-wins (the JWT is never double-reported as a
    // connection-string credential); coverage is the UNION (the username and
    // the `@` the catch-all matched around the JWT are claimed as its slices).
    const url = ['postgres://', 'svc', ':', JWT, '@db.internal/app'].join('');
    const findings = scanText(url);
    expect(findings.filter((f) => f.pattern === 'jwt').length).toBe(1);
    expect(findings.map((f) => f.pattern)).toEqual(['jwt', 'db_url_credentials', 'db_url_credentials']);
    const { text } = redactFindings(url);
    expect(text).toBe('<REDACTED:db_url_credentials><REDACTED:jwt><REDACTED:db_url_credentials>db.internal/app');
    expect(text.includes(JWT)).toBe(false);
    expect(text.includes('svc')).toBe(false);
  });
});

// ── Union coverage ───────────────────────────────────────────────────────────
//
// The per-line dedupe is first-wins for ATTRIBUTION only. A later span that
// partially overlaps an earlier claim has its UNCLAIMED slices claimed as hits
// of the later pattern (value = the slice), so nothing a pattern matched is
// left in the output or a preview; a fully covered later span is skipped.
// Discarding the whole later span used to ship the entire password of a
// database URL whose username was a vendor-shaped id.
describe('union coverage — a later span overlapping an earlier claim still covers its uncovered slices', () => {
  const PW = ['s3cr3t', 'P4ssw0rdXyz'].join('');
  const EXPECTED = '<REDACTED:db_url_credentials><REDACTED:twilio><REDACTED:db_url_credentials>db.internal/app';

  test('a database URL whose USERNAME is a vendor-shaped id: username AND password redacted, in the text and in every preview', () => {
    const url = ['postgres://', TWILIO_SID, ':', PW, '@db.internal/app'].join('');
    const findings = scanText(url);
    // One record per claimed span: the id, then the two db_url slices around it.
    expect(findings.map((f) => f.pattern)).toEqual(['twilio', 'db_url_credentials', 'db_url_credentials']);
    for (const f of findings) {
      expect(f.redactedPreview).toBe(EXPECTED);
      expect(f.redactedPreview.includes(PW)).toBe(false);
      expect(f.redactedPreview.includes(TWILIO_SID)).toBe(false);
    }
    const { text, redactions } = redactFindings(url);
    expect(text).toBe(EXPECTED);
    expect(redactions.length).toBe(3);
  });

  test('the slices carry their own fingerprints, so a slice can be allowlisted like any finding', () => {
    const url = ['postgres://', TWILIO_SID, ':', PW, '@db.internal/app'].join('');
    const [, , tail] = scanText(url);
    const { text, redactions } = redactFindings(url, { allowlist: [tail!.fingerprint] });
    expect(redactions.map((r) => r.pattern)).toEqual(['twilio', 'db_url_credentials']);
    expect(text).toBe(`<REDACTED:db_url_credentials><REDACTED:twilio>:${PW}@db.internal/app`);
  });

  test('a FULLY covered later span is skipped: Bearer <vendor key> reports the vendor only, no bearer record', () => {
    for (const key of [ANTHROPIC, GHP, `gbrain_at_${GBRAIN_HEX}`]) {
      const { text, redactions } = redactFindings(`Authorization: Bearer ${key}`);
      expect(redactions.length).toBe(1);
      expect(redactions[0]!.pattern).not.toBe('bearer');
      expect(text).toBe(`Authorization: Bearer <REDACTED:${redactions[0]!.pattern}>`);
    }
  });

  test('a JWT inside a longer opaque bearer token: jwt keeps the JWT, bearer covers the tail', () => {
    const tail = ['.extra', 'Segment0123456789'].join('');
    const line = `Authorization: Bearer ${JWT}${tail}`;
    expect(scanText(line).map((f) => f.pattern)).toEqual(['jwt', 'bearer']);
    const { text } = redactFindings(line);
    expect(text).toBe('Authorization: Bearer <REDACTED:jwt><REDACTED:bearer>');
    expect(text.includes(tail)).toBe(false);
  });

  test('a span split around TWO earlier claims yields one slice per gap', () => {
    // Two vendor ids inside one connection-string span: `user` is a twilio
    // SID and the password a JWT — the catch-all covers the scheme, the `:`
    // between them and the trailing `@`.
    const url = ['mysql://', TWILIO_SID, ':', JWT, '@h/db'].join('');
    const { text, redactions } = redactFindings(url);
    expect(redactions.map((r) => r.pattern)).toEqual(['twilio', 'jwt', 'db_url_credentials', 'db_url_credentials', 'db_url_credentials']);
    expect(text).toBe('<REDACTED:db_url_credentials><REDACTED:twilio><REDACTED:db_url_credentials><REDACTED:jwt><REDACTED:db_url_credentials>h/db');
  });
});

describe('format-based detectors — negatives (identifiers and public shapes stay put)', () => {
  test('uppercase 64-hex digest starting with AC is not a Twilio SID', () => {
    const digest = 'AC' + 'DEADBEEF'.repeat(7) + 'DEADBE';
    expect(digest.length).toBe(64);
    expect(scanText(`sha256: ${digest}`)).toEqual([]);
  });

  test('URLs with userinfo but no password, or non-database schemes, do not fire', () => {
    for (const s of [
      'https://user@host.example/path',
      'https://user:pw@host.example/path',   // not a database scheme — by design
      'postgres://db.internal:5432/app',     // no credentials
      'git@github.com:org/repo.git',
    ]) {
      expect(scanText(s)).toEqual([]);
    }
  });

  test('fixed-length shapes require a hard right edge (longer runs are identifiers)', () => {
    for (const s of [
      `${ASIA_ID}XYZ`,               // 19 after ASIA — not a 16-char key id
      `${TWILIO_SID}ff`,              // 34 hex after AC
      `${GOOGLE_SHAPE}zz`,            // 37 after AIza
      `${NPM_SHAPE}Q`,                // 37 after npm_
      `${SUPABASE_SBP}9`,             // 41 hex after sbp_
    ]) {
      expect(scanText(s)).toEqual([]);
    }
  });

  test('Supabase publishable keys and project refs are identifiers, not credentials', () => {
    // sb_publishable_ is public by design; a bare 20-char project ref is an
    // identifier (deliberately NOT a pattern).
    expect(scanText(`anon: sb_publishable_${'Ab12Cd34Ef56Gh78Ij90Kl12'}`)).toEqual([]);
    expect(scanText('project ref zfakerefzfakeref0000 at zfakerefzfakeref0000.supabase.co')).toEqual([]);
  });

  test('the JWT prefix alone, or two segments, does not fire', () => {
    expect(scanText(`header ${JWT_SEGMENTS[0]} only`)).toEqual([]);
    expect(scanText(`two ${JWT_SEGMENTS[0]}.${JWT_SEGMENTS[1]} segments`)).toEqual([]);
  });

  test('a JWT fires after every real wire delimiter; `-` is not a boundary (documented, closes a quadratic)', () => {
    // The jwt boundary excludes `-` (as well as `_`): with `-` admitted, every
    // `-` in a `-eyJ-eyJ…` run was a fresh start that consumed to end-of-line
    // and backtracked (secret-scan-perf pins the timing). Headers, JSON, env
    // files and URLs put one of these in front of a token instead.
    for (const prefix of ['Bearer ', '"', '=', ':', '/', '(', '\t']) {
      expect(scanText(`x${prefix}${JWT}`).map((f) => f.pattern)).toEqual(['jwt']);
    }
    expect(scanText(`x-${JWT}`)).toEqual([]);
    expect(scanText(`x_${JWT}`)).toEqual([]);
  });

  test('embedded inside an identifier, vendor prefixes still do not fire', () => {
    expect(scanText(`x_${STRIPE_LIVE}`)).toEqual([]);
    expect(scanText(`my${GITLAB_SHAPE}`)).toEqual([]);
  });
});

describe('high-entropy assignment requires a digit in the value', () => {
  test('code-shaped assignments without a digit do not fire (probe lines)', () => {
    for (const s of [
      'credentials = DefaultAzureCredential()',
      'credential_process = /usr/local/bin/aws-vault',
      'apiKeyEnvVar = "OPENAI_API_KEY_PRODUCTION"',
      'secret_name = my-app/prod/database-credentials',
      'api_key_header: X-Api-Key-Authorization-Header',
    ]) {
      expect(scanText(s, { highEntropy: true })).toEqual([]);
    }
  });

  test('a TOKEN= assignment with a digit-bearing entropic value still fires', () => {
    const v = ['aB3xK9mQ', '2pR7sT1vW4yZ8bC5'].join('');
    expect(scanText(`SMTP_TOKEN=${v}`, { highEntropy: true }).map((f) => f.pattern)).toEqual(['high_entropy_assignment']);
  });

  /** Known, accepted limitation: a 40-hex git sha assigned to a `token:` key
   * has digits AND passes the entropy gate, so it redacts. Pinned so the
   * trade-off stays visible. */
  test('a 40-hex sha after token: still redacts (documented trade-off)', () => {
    const sha = '3e365f5f1a2b4c8d9e0f1a2b3c4d5e6f70819293';
    expect(shannonEntropy(sha)).toBeGreaterThanOrEqual(3.5);
    expect(scanText(`token: ${sha}`, { highEntropy: true }).map((f) => f.pattern)).toEqual(['high_entropy_assignment']);
  });
});

// ── Preview windowing + corpus redaction (span-splice) ───────────────────────
//
// buildPreview renders a WINDOW around the hit (not the whole line) and
// redacts every claimed span inside it; redactFindings rebuilds the text by
// splicing `<REDACTED:pattern>` over exactly the CLAIMED spans (sorted by
// absolute offset, one pass) — not by replaceAll per unique value — and fills
// the unclaimed gaps with the bounded echo pass over the bearer / high-entropy
// values it claimed (pinned in its own describe below). Values below are
// synthetic and runtime-joined from >= 2 fragments.
describe('redactFindings — span-splice semantics and preview window', () => {
  const OPAQUE_VALUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');
  /** PREVIEW_MAX_CHARS (160) plus a leading and a trailing ellipsis. */
  const PREVIEW_CEILING = 162;

  test('a value that is a substring of another value: both redact whole', () => {
    // The bearer token is discovered first (line 1) and is ALSO the password
    // inside the line-2 connection string. The replaceAll form needed a
    // longest-first sort here (replacing the short value first corrupted the
    // longer span, leaving the username and a bare `<REDACTED:bearer>`).
    // Claimed spans never overlap, so the splice has no ordering hazard —
    // kept as the regression pin for that shape.
    const url = ['postgres://', 'svc', ':', OPAQUE_VALUE, '@db.internal/app'].join('');
    const { text, redactions } = redactFindings(`Authorization: Bearer ${OPAQUE_VALUE}\nDATABASE_URL=${url}\n`);
    expect(text).toBe('Authorization: Bearer <REDACTED:bearer>\nDATABASE_URL=<REDACTED:db_url_credentials>db.internal/app\n');
    expect(redactions.map((r) => r.pattern)).toEqual(['bearer', 'db_url_credentials']);
  });

  test('redacts exactly the claimed spans (every pattern outside the echo pass): the corpus write agrees with what scanText reports', () => {
    // Documented semantic delta from the replaceAll form: a claimed value's
    // bytes at a position the scanner did NOT claim (embedded past its left
    // boundary inside a longer identifier) are left as-is, so
    // `redactFindings(t).text` never redacts something `scanText(t)` would
    // not have reported. The exception is the bounded echo pass over the
    // bearer + high_entropy_assignment values (pinned in the next describe);
    // vendor shapes lose nothing by staying outside it — a repeat that clears
    // the boundary IS claimed on its own and both occurrences go.
    const text = `k=${OPENAI} again ${OPENAI}\nid=prefix${OPENAI}\nsid ${TWILIO_SID} vs x${TWILIO_SID}\n`;
    const findings = scanText(text);
    expect(findings.map((f) => [f.pattern, f.line])).toEqual([['openai', 1], ['openai', 1], ['twilio', 3]]);
    const { text: out, redactions } = redactFindings(text);
    expect(redactions.length).toBe(findings.length);
    expect(out).toBe(`k=<REDACTED:openai> again <REDACTED:openai>\nid=prefix${OPENAI}\nsid <REDACTED:twilio> vs x${TWILIO_SID}\n`);
  });

  test('a per-line span running into a PEM block: both spans redact, nothing claimed survives', () => {
    // The bearer value class admits `-`, so a token glued to a PEM header
    // claims `<token>-----BEGIN` on its line while the whole-text PEM pass
    // claims the block from `-----BEGIN`. The splice emits the later span's
    // uncovered tail as its own token instead of skipping it. (The replaceAll
    // form redacted the longer PEM value first, after which the bearer value
    // no longer existed in the text and the token survived.)
    const body = ['MIIEvQIBADANBgkqhkiG9w0BAQEF', 'AASCBKcwggSjAgEAAoIBAQC7VJTU'].join('');
    const text = `Authorization: Bearer ${OPAQUE_VALUE}${['-----BEGIN', ' RSA PRIVATE KEY', '-----'].join('')}\n${body}\n${['-----END', ' RSA PRIVATE KEY', '-----'].join('')}\nafter`;
    const { text: out, redactions } = redactFindings(text);
    expect(redactions.map((r) => r.pattern).sort()).toEqual(['bearer', 'private_key_pem']);
    expect(out).toBe('Authorization: Bearer <REDACTED:bearer><REDACTED:private_key_pem>\nafter');
    expect(out.includes(OPAQUE_VALUE)).toBe(false);
    expect(out.includes(body)).toBe(false);
  });

  test('one redaction record per occurrence even when the same value repeats', () => {
    const { text, redactions } = redactFindings(`a ${OPENAI}\nb ${OPENAI}\nc ${OPENAI}\n`);
    expect(redactions.length).toBe(3);
    expect(text).toBe('a <REDACTED:openai>\nb <REDACTED:openai>\nc <REDACTED:openai>\n');
  });

  test('a preview never carries a SIBLING secret from the same line', () => {
    const findings = scanText(`a=${OPENAI} b=${SLACK}`);
    expect(findings.map((f) => f.pattern).sort()).toEqual(['openai', 'slack']);
    for (const f of findings) {
      expect(f.redactedPreview.includes(OPENAI)).toBe(false);
      expect(f.redactedPreview.includes(SLACK)).toBe(false);
      expect(f.redactedPreview).toContain(`<REDACTED:${f.pattern}>`);
    }
    // The line is short, so the preview is the whole line with both spans redacted.
    expect(findings[0]!.redactedPreview).toBe('a=<REDACTED:openai> b=<REDACTED:slack>');
  });

  test('a preview on a long line is a window around the hit, marked with ellipses', () => {
    const pad = 'x'.repeat(300);
    const [f] = scanText(`${pad} k=${OPENAI} ${pad}`);
    expect(f!.redactedPreview).toContain('<REDACTED:openai>');
    expect(f!.redactedPreview.startsWith('…')).toBe(true);
    expect(f!.redactedPreview.endsWith('…')).toBe(true);
    expect(f!.redactedPreview.length).toBeLessThanOrEqual(PREVIEW_CEILING);
    expect(f!.redactedPreview.includes(OPENAI)).toBe(false);
    // Hit at the very start: no leading ellipsis, trailing one only.
    const [g] = scanText(`k=${OPENAI} ${pad}`);
    expect(g!.redactedPreview.startsWith('k=<REDACTED:openai> ')).toBe(true);
    expect(g!.redactedPreview.startsWith('…')).toBe(false);
    expect(g!.redactedPreview.endsWith('…')).toBe(true);
    // Short line: whole line, no ellipses (unchanged contract).
    expect(scanText(`k=${OPENAI}`)[0]!.redactedPreview).toBe('k=<REDACTED:openai>');
  });

  test('repeated occurrences of one value on a long line never leave a FRAGMENT in any preview', () => {
    // 40-char tokens spaced so a naive fixed window (hit-40 … hit+80) would
    // cut straight through the third occurrence. The window must snap to
    // span boundaries instead.
    const long = [OPAQUE_VALUE, '0123456789'].join('');
    expect(long.length).toBe(40);
    const line = Array.from({ length: 12 }, () => `Bearer ${long}`).join(' ');
    const findings = scanText(line);
    expect(findings.length).toBe(12);
    for (const f of findings) {
      expect(f.redactedPreview.includes(long.slice(0, 12))).toBe(false);
      expect(f.redactedPreview.includes(long.slice(-12))).toBe(false);
      expect(f.redactedPreview).toContain('<REDACTED:bearer>');
    }
  });
});

// ── Bounded echo pass (bearer + high_entropy_assignment) ─────────────────────
//
// A bearer token is claimed only where `Bearer ` anchors it and an entropic
// value only where its keyword does, yet a transcript routinely echoes the
// same value bare (in a tool call's header, then alone in the reply; a pasted
// `PASSWORD=` line, then the value in prose). redactFindings collects the
// values those two patterns claim (ECHO_MAX_UNIQUE unique values in claim
// order — ONE cap across both patterns — each clearing its pattern's floor
// and at most ECHO_MAX_VALUE_CHARS long) and redacts every remaining
// occurrence with that pattern's token. The pass runs per-value `indexOf`
// sweeps over the ORIGINAL text and splices into the unclaimed gaps — never
// an alternation RegExp (quadratic on prefix-sharing values, see the perf
// file), never over already-emitted tokens. It adds no findings.
describe('redactFindings — bounded echo pass', () => {
  const OPAQUE_VALUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');
  const unique = (k: number) => `${OPAQUE_VALUE}${k.toString(36).padStart(4, 'z')}`;
  const HI = ['aB3xZ9qL7m', 'Np2Rt5Vw8Yk1D4'].join('');

  test('the transcript shape: anchored in a tool call, echoed bare and embedded in the reply — every site is redacted, only the claim is counted', () => {
    const text = `tool: curl -H "Authorization: Bearer ${OPAQUE_VALUE}" https://api.example/v1\nassistant: the token ${OPAQUE_VALUE} expired; id=prefix${OPAQUE_VALUE} embeds it\n`;
    const findings = scanText(text);
    expect(findings.map((f) => [f.pattern, f.line])).toEqual([['bearer', 1]]);
    const { text: out, redactions } = redactFindings(text);
    // An echo is not a claim: `redactions` stays one record per CLAIMED occurrence.
    expect(redactions.length).toBe(1);
    expect(out).toBe('tool: curl -H "Authorization: Bearer <REDACTED:bearer>" https://api.example/v1\nassistant: the token <REDACTED:bearer> expired; id=prefix<REDACTED:bearer> embeds it\n');
    expect(out.includes(OPAQUE_VALUE)).toBe(false);
  });

  test('a keyword-anchored high-entropy value echoed bare (and embedded) is redacted as <REDACTED:high_entropy_assignment>', () => {
    // The transcripts lane runs with highEntropy on, so a pasted `.env` line
    // followed by the value in prose used to ship the prose copy.
    const text = `PASSWORD=${HI}\nthen the agent pasted ${HI} again; id=x${HI}y\n`;
    const { text: out, redactions } = redactFindings(text, { highEntropy: true });
    expect(redactions.map((r) => r.pattern)).toEqual(['high_entropy_assignment']);
    expect(out).toBe('PASSWORD=<REDACTED:high_entropy_assignment>\nthen the agent pasted <REDACTED:high_entropy_assignment> again; id=x<REDACTED:high_entropy_assignment>y\n');
  });

  test('each echo carries the token of the pattern that claimed the value', () => {
    const text = `Bearer ${OPAQUE_VALUE} TOKEN=${HI}\necho ${HI} and ${OPAQUE_VALUE}\n`;
    const { text: out } = redactFindings(text, { highEntropy: true });
    expect(out).toBe('Bearer <REDACTED:bearer> TOKEN=<REDACTED:high_entropy_assignment>\necho <REDACTED:high_entropy_assignment> and <REDACTED:bearer>\n');
  });

  test('a vendor key behind Bearer keeps its vendor attribution everywhere; the echo pass has nothing to do', () => {
    // Vendor shapes are claimed on their own wherever they appear, so both
    // occurrences are vendor tokens and no `<REDACTED:bearer>` is emitted.
    const { text: out, redactions } = redactFindings(`Bearer ${ANTHROPIC}\nbare ${ANTHROPIC}\n`);
    expect(redactions.map((r) => r.pattern)).toEqual(['anthropic', 'anthropic']);
    expect(out).toBe('Bearer <REDACTED:anthropic>\nbare <REDACTED:anthropic>\n');
  });

  test("other patterns' values are not echoed: a vendor key embedded past its boundary stays (it re-matches on its own wherever it clears the boundary)", () => {
    const { text: out } = redactFindings(`k=${OPENAI}\nid=prefix${OPENAI}\n`);
    expect(out).toBe(`k=<REDACTED:openai>\nid=prefix${OPENAI}\n`);
  });

  test(`the cap is exactly ${ECHO_MAX_UNIQUE} unique values in claim order; the next value's echo is the accepted miss`, () => {
    expect(ECHO_MAX_UNIQUE).toBe(64);
    const vals = Array.from({ length: ECHO_MAX_UNIQUE + 1 }, (_, k) => unique(k));
    const text = vals.map((v) => `Bearer ${v}`).join('\n') + `\necho ${vals[0]} ${vals[ECHO_MAX_UNIQUE - 1]} ${vals[ECHO_MAX_UNIQUE]}`;
    const { text: out, redactions } = redactFindings(text);
    // Every CLAIM past the cap is still redacted and counted — the cap bounds
    // the echo pass, not the splice.
    expect(redactions.length).toBe(ECHO_MAX_UNIQUE + 1);
    expect(out.endsWith(`echo <REDACTED:bearer> <REDACTED:bearer> ${vals[ECHO_MAX_UNIQUE]}`)).toBe(true);
    expect(out.split('<REDACTED:bearer>').length - 1).toBe(ECHO_MAX_UNIQUE + 1 + 2);
  });

  test('the cap is ONE budget across both patterns: 32 bearer + 32 entropy values fill it, a 65th (entropy) value does not echo', () => {
    const bearers = Array.from({ length: 32 }, (_, k) => unique(k));
    const entropics = Array.from({ length: 33 }, (_, k) => `${HI}${k.toString(36).padStart(4, 'q')}`);
    const text = [
      ...bearers.map((v) => `Bearer ${v}`),
      ...entropics.map((v) => `PASSWORD=${v}`),
      `echo ${bearers[0]} ${bearers[31]} ${entropics[0]} ${entropics[31]} ${entropics[32]}`,
    ].join('\n');
    const { text: out, redactions } = redactFindings(text, { highEntropy: true });
    expect(redactions.length).toBe(65);
    expect(out.endsWith(`echo <REDACTED:bearer> <REDACTED:bearer> <REDACTED:high_entropy_assignment> <REDACTED:high_entropy_assignment> ${entropics[32]}`)).toBe(true);
  });

  test('repeated claims of one value take one cap slot (the cap counts unique values, not occurrences)', () => {
    const text = Array.from({ length: ECHO_MAX_UNIQUE }, () => `Bearer ${unique(0)}`).join('\n') + `\nBearer ${unique(1)}\necho ${unique(1)}`;
    const { text: out, redactions } = redactFindings(text);
    expect(redactions.length).toBe(ECHO_MAX_UNIQUE + 1);
    expect(out.endsWith('echo <REDACTED:bearer>')).toBe(true);
  });

  test(`the floors are exactly ${ECHO_MIN_CHARS_BEARER} (bearer) and ${ECHO_MIN_CHARS_ENTROPY} (high_entropy_assignment) — each rule's own floor, restated (pinned so an edit is a visible edit)`, () => {
    expect(ECHO_MIN_CHARS_BEARER).toBe(20);
    expect(ECHO_MIN_CHARS_ENTROPY).toBe(12);
    const v20 = ['opaque', 'Tok0123456789X'].join('');
    expect(v20.length).toBe(20);
    expect(redactFindings(`Bearer ${v20}\necho ${v20}`).text).toBe('Bearer <REDACTED:bearer>\necho <REDACTED:bearer>');
    const v12 = ['aB3x', 'Z9qL7mN2'].join('');
    expect(v12.length).toBe(12);
    expect(redactFindings(`TOKEN=${v12}\necho ${v12}`, { highEntropy: true }).text).toBe('TOKEN=<REDACTED:high_entropy_assignment>\necho <REDACTED:high_entropy_assignment>');
  });

  test(`a value longer than ${ECHO_MAX_VALUE_CHARS} chars is redacted at its claim but does not echo (the length cap)`, () => {
    expect(ECHO_MAX_VALUE_CHARS).toBe(512);
    const v512 = 'aB3xZ9qL7m'.repeat(51) + 'Q2';
    expect(v512.length).toBe(512);
    expect(redactFindings(`Bearer ${v512}\necho ${v512}`).text).toBe('Bearer <REDACTED:bearer>\necho <REDACTED:bearer>');
    const v513 = v512 + 'z';
    expect(redactFindings(`Bearer ${v513}\necho ${v513}`).text).toBe(`Bearer <REDACTED:bearer>\necho ${v513}`);
  });

  test('an allowlisted bearer value is neither claimed nor echo-redacted (declared safe)', () => {
    const text = `Bearer ${OPAQUE_VALUE}\necho ${OPAQUE_VALUE}`;
    const [f] = scanText(text);
    const { text: out, redactions } = redactFindings(text, { allowlist: [f!.fingerprint] });
    expect(redactions).toEqual([]);
    expect(out).toBe(text);
  });

  test('a claimed value that is a prefix of another: leftmost-longest, neither echo is cut short', () => {
    const short = OPAQUE_VALUE;
    const long = OPAQUE_VALUE + 'MORE0';
    const text = `Bearer ${short}\nBearer ${long}\necho ${long} then ${short}`;
    expect(redactFindings(text).text).toBe('Bearer <REDACTED:bearer>\nBearer <REDACTED:bearer>\necho <REDACTED:bearer> then <REDACTED:bearer>');
  });

  test('values match literally: `.` and `+` in the bearer class are not metacharacters', () => {
    const v = ['abc.def+ghi', '=jkl~mno/pqr012345'].join('');
    expect(redactFindings(`Bearer ${v}\nbare ${v}`).text).toBe('Bearer <REDACTED:bearer>\nbare <REDACTED:bearer>');
    const nearMiss = v.replace('.', 'X');
    expect(redactFindings(`Bearer ${v}\nbare ${nearMiss}`).text).toBe(`Bearer <REDACTED:bearer>\nbare ${nearMiss}`);
  });

  test('the echo pass never touches an emitted token: a bearer value spelling a pattern name cannot nest', () => {
    // `high_entropy_assignment` is 23 bearer-class characters. Running the
    // echo pass over the SPLICED output turned the sibling token into
    // `<REDACTED:<REDACTED:bearer>>`; matching over the original text's
    // unclaimed gaps cannot.
    const text = `Authorization: Bearer high_entropy_assignment\nPASSWORD=${HI}\n`;
    const { text: out, redactions } = redactFindings(text, { highEntropy: true });
    expect(redactions.map((r) => r.pattern)).toEqual(['bearer', 'high_entropy_assignment']);
    expect(out).toBe('Authorization: Bearer <REDACTED:bearer>\nPASSWORD=<REDACTED:high_entropy_assignment>\n');
    expect(out.includes('<REDACTED:<')).toBe(false);
  });

  test('an echo that straddles a claimed span is left to the claim (nothing is emitted twice, nothing is skipped)', () => {
    // Line 2's connection string claims `…:<OPAQUE>@`; the bearer echo of
    // OPAQUE inside it is entirely within the claimed span and is not
    // re-emitted; the bare echo on line 3 is.
    const url = ['postgres://', 'svc', ':', OPAQUE_VALUE, '@db.internal/app'].join('');
    const { text: out } = redactFindings(`Bearer ${OPAQUE_VALUE}\n${url}\nbare ${OPAQUE_VALUE}\n`);
    expect(out).toBe('Bearer <REDACTED:bearer>\n<REDACTED:db_url_credentials>db.internal/app\nbare <REDACTED:bearer>\n');
  });
});

// ── Session-wide dictionary: planRedaction + applyRedaction ──────────────────
//
// A multi-field document (a transcript session) plans every field into ONE
// shared map first and applies afterwards, so an echo in an earlier field of
// a value claimed in a later field is scrubbed too. Same floors, same single
// cap; the plan's `redactions` are unchanged by the echo pass.
describe('planRedaction / applyRedaction — one echo dictionary across several texts', () => {
  const OPAQUE_VALUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');
  const HI = ['aB3xZ9qL7m', 'Np2Rt5Vw8Yk1D4'].join('');

  test('a value claimed in a LATER text is scrubbed from an EARLIER one once every plan is applied after every scan', () => {
    const echoValues = new Map<string, string>();
    const a = planRedaction(`the token ${OPAQUE_VALUE} expired`, { echoValues });
    const b = planRedaction(`Authorization: Bearer ${OPAQUE_VALUE}`, { echoValues });
    const c = planRedaction(`pasted ${HI} into the env`, { echoValues, highEntropy: true });
    const d = planRedaction(`SMTP_PASSWORD=${HI}`, { echoValues, highEntropy: true });
    expect(a.redactions).toEqual([]);
    expect(b.redactions.map((r) => r.pattern)).toEqual(['bearer']);
    expect(c.redactions).toEqual([]);
    expect(d.redactions.map((r) => r.pattern)).toEqual(['high_entropy_assignment']);
    expect([...echoValues]).toEqual([[OPAQUE_VALUE, 'bearer'], [HI, 'high_entropy_assignment']]);
    expect(applyRedaction(a)).toBe('the token <REDACTED:bearer> expired');
    expect(applyRedaction(b)).toBe('Authorization: Bearer <REDACTED:bearer>');
    expect(applyRedaction(c)).toBe('pasted <REDACTED:high_entropy_assignment> into the env');
    expect(applyRedaction(d)).toBe('SMTP_PASSWORD=<REDACTED:high_entropy_assignment>');
  });

  test('the shared map is one budget across texts: a value claimed past the cap in a later text does not echo anywhere', () => {
    const echoValues = new Map<string, string>();
    const vals = Array.from({ length: ECHO_MAX_UNIQUE + 1 }, (_, k) => `${OPAQUE_VALUE}${k.toString(36).padStart(4, 'z')}`);
    const early = planRedaction(`seen first: ${vals[ECHO_MAX_UNIQUE]} and ${vals[0]}`, { echoValues });
    const plans = vals.map((v) => planRedaction(`Bearer ${v}`, { echoValues }));
    expect(echoValues.size).toBe(ECHO_MAX_UNIQUE);
    expect(echoValues.has(vals[ECHO_MAX_UNIQUE]!)).toBe(false);
    expect(applyRedaction(early)).toBe(`seen first: ${vals[ECHO_MAX_UNIQUE]} and <REDACTED:bearer>`);
    // The over-cap CLAIM is still redacted at its own span.
    expect(applyRedaction(plans[ECHO_MAX_UNIQUE]!)).toBe('Bearer <REDACTED:bearer>');
  });

  test('redactFindings returns the dictionary it collected', () => {
    const { echoValues } = redactFindings(`Bearer ${OPAQUE_VALUE}`);
    expect([...echoValues]).toEqual([[OPAQUE_VALUE, 'bearer']]);
    expect(redactFindings('nothing here').echoValues.size).toBe(0);
  });

  test('a text with no claims and a non-empty shared map is still swept (the echo pass is not gated on local claims)', () => {
    const echoValues = new Map<string, string>([[OPAQUE_VALUE, 'bearer']]);
    expect(applyRedaction(planRedaction(`just ${OPAQUE_VALUE}`, { echoValues }))).toBe('just <REDACTED:bearer>');
  });
});
