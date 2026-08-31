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
