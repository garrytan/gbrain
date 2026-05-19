import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseCodeClaimVerificationEntry,
  verifyCodeClaims,
} from '../src/core/services/code-claim-verification-service.ts';

test('code claim verification marks an existing file and symbol current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-current-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const [result] = verifyCodeClaims({
      repo_path: dir,
      branch_name: 'main',
      now: new Date('2026-04-25T00:00:00.000Z'),
      claims: [{ path: 'src/example.ts', symbol: 'presentSymbol', branch_name: 'main' }],
    });

    expect(result?.status).toBe('current');
    expect(result?.reason).toBe('ok');
    expect(result?.checked_at).toBe('2026-04-25T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification marks a missing file stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-file-missing-'));

  try {
    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: 'src/missing.ts', symbol: 'MissingSymbol' }],
      now: new Date('2026-04-25T00:01:00.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('file_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification marks a missing symbol stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-symbol-missing-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function otherSymbol() { return true; }\n');

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: 'src/example.ts', symbol: 'MissingSymbol' }],
      now: new Date('2026-04-25T00:02:00.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('symbol_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification marks content hash mismatches stale before symbol matching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-hash-mismatch-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{
        path: 'src/example.ts',
        symbol: 'presentSymbol',
        expected_content_hash: 'sha256:not-current',
      }],
      now: new Date('2026-05-19T00:00:00.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('content_hash_mismatch');
    expect(result?.actual_content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification requires branch and content hash for live-workspace mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-live-workspace-mode-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const [missingBranch] = verifyCodeClaims({
      repo_path: dir,
      branch_name: 'main',
      claims: [{
        path: 'src/example.ts',
        symbol: 'presentSymbol',
        expected_content_hash: 'sha256:not-current',
        verification_mode: 'live_workspace_check',
      }],
      now: new Date('2026-05-19T00:00:01.000Z'),
    });
    const [missingHash] = verifyCodeClaims({
      repo_path: dir,
      branch_name: 'main',
      claims: [{
        path: 'src/example.ts',
        symbol: 'presentSymbol',
        branch_name: 'main',
        verification_mode: 'live_workspace_check',
      }],
      now: new Date('2026-05-19T00:00:02.000Z'),
    });

    expect(missingBranch?.status).toBe('unverifiable');
    expect(missingBranch?.reason).toBe('branch_required');
    expect(missingHash?.status).toBe('unverifiable');
    expect(missingHash?.reason).toBe('content_hash_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification treats code-lane claims as live-workspace checks even without explicit mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-code-lane-strict-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const [missingBranch] = verifyCodeClaims({
      repo_path: dir,
      branch_name: 'main',
      claims: [{
        path: 'src/example.ts',
        symbol: 'presentSymbol',
        expected_content_hash: 'sha256:not-current',
        source_ref: 'test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json#definition_lookup',
        symbol_id: 'code:symbol:systems/example:/workspace/src/example.ts#presentSymbol',
      }],
      now: new Date('2026-05-19T00:00:03.000Z'),
    });
    const [missingHash] = verifyCodeClaims({
      repo_path: dir,
      branch_name: 'main',
      claims: [{
        path: 'src/example.ts',
        symbol: 'presentSymbol',
        branch_name: 'main',
        symbol_id: 'code:symbol:systems/example:/workspace/src/example.ts#presentSymbol',
      }],
      now: new Date('2026-05-19T00:00:04.000Z'),
    });

    expect(missingBranch?.status).toBe('unverifiable');
    expect(missingBranch?.reason).toBe('branch_required');
    expect(missingHash?.status).toBe('unverifiable');
    expect(missingHash?.reason).toBe('content_hash_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification does not accept identifier substrings as symbols', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-symbol-substring-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function fooBar() { return true; }\n');

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: 'src/example.ts', symbol: 'foo' }],
      now: new Date('2026-04-25T00:02:30.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('symbol_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification ignores symbols that only appear in comments or strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-symbol-comment-string-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), [
      '// MissingSymbol used to exist here',
      'const message = "MissingSymbol";',
      'export function otherSymbol() { return message; }',
      '',
    ].join('\n'));

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: 'src/example.ts', symbol: 'MissingSymbol' }],
      now: new Date('2026-04-25T00:02:45.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('symbol_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification ignores symbols that only appear in regex literals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-symbol-regex-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), [
      'const matcher = /MissingSymbol/;',
      'export function otherSymbol() { return matcher.test("x"); }',
      '',
    ].join('\n'));

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: 'src/example.ts', symbol: 'MissingSymbol' }],
      now: new Date('2026-04-25T00:02:48.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('symbol_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification ignores regex literals after return keywords', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-symbol-return-regex-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), [
      'export function makeRegex() {',
      '  return /MissingSymbol/;',
      '}',
      '',
    ].join('\n'));

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: 'src/example.ts', symbol: 'MissingSymbol' }],
      now: new Date('2026-04-25T00:02:49.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('symbol_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification does not accept complex symbol substrings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-complex-substring-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), [
      'export function barfoo() { return true; }',
      'const value = foo.barBaz;',
      '',
    ].join('\n'));

    const [functionResult, memberResult] = verifyCodeClaims({
      repo_path: dir,
      claims: [
        { path: 'src/example.ts', symbol: 'foo()' },
        { path: 'src/example.ts', symbol: 'foo.bar' },
      ],
      now: new Date('2026-04-25T00:02:50.000Z'),
    });

    expect(functionResult?.status).toBe('stale');
    expect(functionResult?.reason).toBe('symbol_missing');
    expect(memberResult?.status).toBe('stale');
    expect(memberResult?.reason).toBe('symbol_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim parser accepts pathless symbol claims as unverifiable inputs', () => {
  const claim = parseCodeClaimVerificationEntry(
    'code_claim:{"symbol":"MissingSymbol"}',
    'trace-symbol-only',
  );

  expect(claim).toEqual({
    symbol: 'MissingSymbol',
    source_trace_id: 'trace-symbol-only',
  });
});

test('code claim parser preserves JSON verification metadata fields', () => {
  const claim = parseCodeClaimVerificationEntry(
    'code_claim:{"path":"src/example.ts","symbol":"presentSymbol","expected_content_hash":"sha256:abc","verification_hint":"run rg","verification_mode":"live_workspace_check","source_ref":"brain/systems/example.md","symbol_id":"system:src/example.ts#presentSymbol"}',
    'trace-json-metadata',
  );

  expect(claim).toEqual({
    path: 'src/example.ts',
    symbol: 'presentSymbol',
    expected_content_hash: 'sha256:abc',
    verification_hint: 'run rg',
    verification_mode: 'live_workspace_check',
    source_ref: 'brain/systems/example.md',
    symbol_id: 'system:src/example.ts#presentSymbol',
    source_trace_id: 'trace-json-metadata',
  });
});

test('code claim verification marks a branch mismatch stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-branch-mismatch-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const [result] = verifyCodeClaims({
      repo_path: dir,
      branch_name: 'branch-b',
      claims: [{ path: 'src/example.ts', symbol: 'presentSymbol', branch_name: 'branch-a' }],
      now: new Date('2026-04-25T00:03:00.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('branch_mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification marks claims unverifiable when the repo is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-repo-missing-'));
  const missingRepo = join(dir, 'missing-repo');

  try {
    const [result] = verifyCodeClaims({
      repo_path: missingRepo,
      claims: [{ path: 'src/example.ts', symbol: 'presentSymbol' }],
      now: new Date('2026-04-25T00:04:00.000Z'),
    });

    expect(result?.status).toBe('unverifiable');
    expect(result?.reason).toBe('repo_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim parser preserves symbols that contain namespace separators', () => {
  const claim = parseCodeClaimVerificationEntry('code_claim:src/x.ts:Old::Symbol():branch=main');

  expect(claim).toEqual({
    path: 'src/x.ts',
    symbol: 'Old::Symbol()',
    branch_name: 'main',
  });
});

test('code claim verification rejects symlink escapes from the repo root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-symlink-escape-'));
  const repoPath = join(dir, 'repo');
  const outsidePath = join(dir, 'outside.ts');

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(outsidePath, 'export function leakedSymbol() { return true; }\n');
    symlinkSync(outsidePath, join(repoPath, 'src/link.ts'));

    const [result] = verifyCodeClaims({
      repo_path: repoPath,
      claims: [{ path: 'src/link.ts', symbol: 'leakedSymbol' }],
      now: new Date('2026-04-25T00:05:00.000Z'),
    });

    expect(result?.status).toBe('stale');
    expect(result?.reason).toBe('file_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification treats directory paths as missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-directory-'));

  try {
    mkdirSync(join(dir, 'src/directory-claim'), { recursive: true });

    const [withoutSymbol, withSymbol] = verifyCodeClaims({
      repo_path: dir,
      claims: [
        { path: 'src/directory-claim' },
        { path: 'src/directory-claim', symbol: 'AnySymbol' },
      ],
      now: new Date('2026-04-25T00:06:00.000Z'),
    });

    expect(withoutSymbol?.status).toBe('stale');
    expect(withoutSymbol?.reason).toBe('file_missing');
    expect(withSymbol?.status).toBe('stale');
    expect(withSymbol?.reason).toBe('file_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification marks branch-specific claims unverifiable when current branch is unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-branch-unknown-'));

  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: 'src/example.ts', symbol: 'presentSymbol', branch_name: 'main' }],
      now: new Date('2026-04-25T00:07:00.000Z'),
    });

    expect(result?.status).toBe('unverifiable');
    expect(result?.reason).toBe('branch_unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code claim verification allows in-repo paths whose segment starts with dots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-dot-prefix-'));

  try {
    mkdirSync(join(dir, '..generated'), { recursive: true });
    writeFileSync(join(dir, '..generated/file.ts'), 'export function generatedSymbol() { return true; }\n');

    const [result] = verifyCodeClaims({
      repo_path: dir,
      claims: [{ path: '..generated/file.ts', symbol: 'generatedSymbol' }],
      now: new Date('2026-04-25T00:08:00.000Z'),
    });

    expect(result?.status).toBe('current');
    expect(result?.reason).toBe('ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
