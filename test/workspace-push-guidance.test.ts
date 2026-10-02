/**
 * Push-refusal guidance (security wave DX-3/ENG-11/CEO-21/DX-4): the
 * per-finding fix steps that ride `findings[]`, the short `reason` that has to
 * survive `sanitizePushReason`, and the stale header-only private-key
 * allowlist hint. Pure functions: no git, no engine, no env mutation.
 *
 * Credential-shaped fixtures (key fences, key bodies) are assembled at
 * runtime from parts; key bodies are random bytes, never a real key.
 */
import { describe, test, expect } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  blockedSecretsReason, buildPushFindings, formatBlockedSecrets, sanitizePushReason, SECRET_SCAN_REFUSAL_DOCS,
  type PushSecretFinding,
} from '../src/core/workspace-push.ts';
import { loadWorkspaceAllowlist, scanText, SCAN_ALLOW_FILENAME, type SecretFinding } from '../src/core/secret-scan.ts';

const KEY_LABEL = ['PRIVATE', 'KEY'].join(' ');
const BEGIN = `${'-'.repeat(5)}BEGIN RSA ${KEY_LABEL}${'-'.repeat(5)}`;
const END = `${'-'.repeat(5)}END RSA ${KEY_LABEL}${'-'.repeat(5)}`;

function bodyLines(n: number): string[] {
  return Array.from({ length: n }, () => randomBytes(48).toString('base64'));
}

function fp(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function finding(over: Partial<SecretFinding & { since: string }> = {}): SecretFinding {
  return {
    pattern: 'private_key_pem',
    line: 2,
    redactedPreview: '<REDACTED:private_key_pem>',
    fingerprint: 'sha256:0123456789abcdef',
    ...over,
  };
}

function build(findings: SecretFinding[], allowlist: string[] = []): PushSecretFinding[] {
  return buildPushFindings({
    file: 'notes/key.md',
    findings,
    allowlist,
    allowlistPath: '/ws/.gbrain-scan-allow',
    retryCommand: 'gbrain sources push --path /ws',
  });
}

describe('blockedSecretsReason (ENG-11: reason survives sanitizePushReason)', () => {
  test('a long path and long pattern name stay within 140 chars, unclipped and readable', () => {
    const file = `${'deeply/nested/'.repeat(12)}meeting-notes.md`;
    const reason = blockedSecretsReason([
      { ...build([finding({ pattern: 'high_entropy_assignment', line: 1234 })])[0]!, file },
      { ...build([finding()])[0]!, file: 'b.md' },
    ]);
    expect(reason.length).toBeLessThanOrEqual(140);
    expect(sanitizePushReason(reason)).toBe(reason);
    expect(reason).toStartWith('2 secret finding(s), first ...');
    expect(reason).toContain('/meeting-notes.md:1234 [high_entropy_assignment]');
    expect(reason).toContain('nothing committed');
    expect(reason).toContain('gbrain sources push');
  });

  test('a short location is shown whole', () => {
    const reason = blockedSecretsReason(build([finding({ pattern: 'openai', line: 3 })]));
    expect(reason).toBe('1 secret finding(s), first notes/key.md:3 [openai]; nothing committed. Run gbrain sources push for fix steps');
    expect(sanitizePushReason(reason)).toBe(reason);
  });
});

describe('buildPushFindings (DX-3: per-finding guidance)', () => {
  test('carries the fingerprint, allowlist path, append + retry commands and docs anchor', () => {
    const [f] = build([finding({ pattern: 'openai', fingerprint: 'sha256:aaaabbbbccccdddd' })]);
    expect(f!.file).toBe('notes/key.md');
    expect(f!.fingerprint).toBe('sha256:aaaabbbbccccdddd');
    expect(f!.allowlistPath).toBe('/ws/.gbrain-scan-allow');
    expect(f!.allowCommand).toBe("printf '\\n%s\\n' sha256:aaaabbbbccccdddd >> /ws/.gbrain-scan-allow");
    expect(f!.retryCommand).toBe('gbrain sources push --path /ws');
    expect(f!.docs).toBe(SECRET_SCAN_REFUSAL_DOCS);
    expect(f!.docs).toEndWith('write-refusals.md#secret-scan-refusals-and-redaction');
    expect(f!.since).toBeUndefined();
    expect(f!.staleAllowlistEntry).toBeUndefined();
  });

  test("CEO-21: the finding's since version rides through when the scanner reports one", () => {
    const [f] = build([finding({ pattern: 'basic_auth', since: '0.60.31.0' } as Partial<SecretFinding>)]);
    expect(f!.since).toBe('0.60.31.0');
  });

  test('the append command works verbatim on a path with spaces and quotes, from any cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'wspg-'));
    try {
      const ws = join(root, "my brain's dir");
      mkdirSync(ws);
      const allowlistPath = join(ws, SCAN_ALLOW_FILENAME);
      writeFileSync(allowlistPath, '# reviewed\nnotes/*.tmp');
      const [f] = buildPushFindings({
        file: 'a.md', allowlist: [], allowlistPath, retryCommand: 'x',
        findings: [finding({ pattern: 'openai', fingerprint: 'sha256:1111222233334444' })],
      });
      const r = spawnSync('bash', ['-c', f!.allowCommand], { cwd: tmpdir(), encoding: 'utf-8' });
      expect(r.status).toBe(0);
      expect(loadWorkspaceAllowlist(ws)).toEqual(['notes/*.tmp', 'sha256:1111222233334444']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stale header-only private-key allowlist hint (DX-4)', () => {
  const truncated = ['intro prose', BEGIN, ...bodyLines(6)].join('\n');
  const headerOnly = fp(BEGIN);
  const bodyFp = 'sha256:fedcba9876543210';

  test('a header-only allowlist entry is named with the replacement fingerprint', () => {
    const [f] = build([finding({ fingerprint: bodyFp, legacyFingerprint: headerOnly })], ['notes/*.tmp', headerOnly]);
    expect(f!.staleAllowlistEntry).toEqual({ entry: headerOnly, replacement: bodyFp });
    expect(f).not.toHaveProperty('legacyFingerprint');
  });

  test('no hint without a legacy fingerprint, or without a matching entry', () => {
    expect(build([finding({ fingerprint: bodyFp })], [headerOnly])[0]!.staleAllowlistEntry).toBeUndefined();
    expect(build([finding({ legacyFingerprint: headerOnly })], ['sha256:9999999999999999'])[0]!.staleAllowlistEntry).toBeUndefined();
  });

  test('a short (< 16 hex) prefix of the header fingerprint does not count as a match', () => {
    const [f] = build([finding({ fingerprint: bodyFp, legacyFingerprint: headerOnly })], [headerOnly.slice(0, 'sha256:'.length + 12)]);
    expect(f!.staleAllowlistEntry).toBeUndefined();
  });

  test('with the real scanner, the old entry yields a body finding plus the hint', () => {
    const allowlist = [headerOnly];
    const findings = scanText(truncated, { allowlist });
    expect(findings.length).toBe(1);
    expect(findings[0]!.fingerprint).not.toBe(headerOnly);
    const [f] = build(findings, allowlist);
    expect(f!.staleAllowlistEntry).toEqual({ entry: headerOnly, replacement: findings[0]!.fingerprint });
  });

  test('with the real scanner, a complete block (END in view) gets no hint', () => {
    const complete = ['intro', BEGIN, ...bodyLines(6), END].join('\n');
    const findings = scanText(complete, { allowlist: [headerOnly] });
    expect(build(findings, [headerOnly])[0]!.staleAllowlistEntry).toBeUndefined();
  });
});

describe('formatBlockedSecrets (CLI rendering of the structured findings)', () => {
  const allowlistPath = "/home/u/my brain/.gbrain-scan-allow";
  function one(over: Partial<SecretFinding & { since: string }>, allowlist: string[] = []): PushSecretFinding[] {
    return buildPushFindings({
      file: 'k.md', findings: [finding(over)], allowlist, allowlistPath,
      retryCommand: "gbrain sources push --path '/home/u/my brain'",
    });
  }

  test('fingerprint, append command, remove-first advice, retry and docs; no since line without since', () => {
    const lines = formatBlockedSecrets(one({ pattern: 'openai', line: 4, fingerprint: 'sha256:aaaabbbbccccdddd' }));
    expect(lines).toEqual([
      'PUSH BLOCKED — secret scan findings (nothing committed):',
      '  k.md:4 [openai] <REDACTED:private_key_pem>',
      '    fingerprint: sha256:aaaabbbbccccdddd',
      "    allow this finding: printf '\\n%s\\n' sha256:aaaabbbbccccdddd >> '/home/u/my brain/.gbrain-scan-allow'",
      'Remove a real credential from the file (and rotate it) first. Allowlist only a reviewed false positive',
      "with the \"allow this finding\" command above (it appends to '/home/u/my brain/.gbrain-scan-allow'), then retry:",
      "  gbrain sources push --path '/home/u/my brain'",
      `Docs: ${SECRET_SCAN_REFUSAL_DOCS}`,
    ]);
  });

  test("CEO-21: a finding's since version names the gbrain version that made the shape blocking", () => {
    for (const [pattern, since] of [['url_credentials', '0.60.31.0'], ['basic_auth', 'v0.60.31.0'], ['digitalocean', '0.60.31.0']]) {
      const out = formatBlockedSecrets(one({ pattern, since } as Partial<SecretFinding>)).join('\n');
      expect(out).toContain(`    rule [${pattern}] blocks pushes since gbrain v0.60.31.0`);
    }
  });

  test('DX-4: the stale header-only entry is named with the replacement line', () => {
    const headerOnly = fp(BEGIN);
    const out = formatBlockedSecrets(one(
      { line: 1, fingerprint: 'sha256:fedcba9876543210', since: '0.60.31.0', legacyFingerprint: headerOnly },
      [headerOnly],
    )).join('\n');
    expect(out).toContain(
      `    stale allowlist entry: ${headerOnly} matched only this key's BEGIN header before gbrain v0.60.31.0; the fingerprint now covers the key body.`,
    );
    expect(out).toContain(
      "    if the key is a reviewed false positive, replace that line in '/home/u/my brain/.gbrain-scan-allow' with: sha256:fedcba9876543210",
    );
  });

  test('an empty finding list renders only the header', () => {
    expect(formatBlockedSecrets([])).toEqual(['PUSH BLOCKED — secret scan findings (nothing committed):']);
  });
});
