import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  CodeClaim,
  CodeClaimVerificationResult,
  RetrievalTrace,
} from '../types.ts';

const CODE_CLAIM_PREFIX = 'code_claim:';

export function verifyCodeClaims(input: {
  repo_path: string;
  branch_name?: string | null;
  claims: CodeClaim[];
  now?: Date;
}): CodeClaimVerificationResult[] {
  const checkedAt = (input.now ?? new Date()).toISOString();
  if (!isExistingDirectory(input.repo_path)) {
    return input.claims.map((claim) => ({
      claim,
      status: 'unverifiable',
      reason: 'repo_missing',
      checked_at: checkedAt,
    }));
  }

  return input.claims.map((claim) =>
    verifyOneClaim({
      repoPath: input.repo_path,
      branchName: input.branch_name ?? undefined,
      claim,
      checkedAt,
    }));
}

export function extractCodeClaimsFromTrace(trace: RetrievalTrace): CodeClaim[] {
  return trace.verification
    .map((entry) => parseCodeClaimVerificationEntry(entry, trace.id))
    .filter((claim): claim is CodeClaim => claim !== null);
}

export function parseCodeClaimVerificationEntry(
  entry: string,
  sourceTraceId?: string,
): CodeClaim | null {
  if (!entry.startsWith(CODE_CLAIM_PREFIX)) return null;
  const payload = entry.slice(CODE_CLAIM_PREFIX.length).trim();
  if (!payload) return null;

  if (payload.startsWith('{')) {
    return parseJsonCodeClaim(payload, sourceTraceId);
  }

  const separatorIndex = payload.indexOf(':');
  const path = (separatorIndex === -1 ? payload : payload.slice(0, separatorIndex)).trim();
  if (!path) return null;

  let symbolSegment = separatorIndex === -1 ? '' : payload.slice(separatorIndex + 1).trim();
  let branchName: string | undefined;
  const branchSuffixIndex = symbolSegment.lastIndexOf(':branch=');
  if (branchSuffixIndex >= 0) {
    branchName = symbolSegment.slice(branchSuffixIndex + ':branch='.length).trim() || undefined;
    symbolSegment = symbolSegment.slice(0, branchSuffixIndex).trim();
  } else if (symbolSegment.startsWith('branch=')) {
    branchName = symbolSegment.slice('branch='.length).trim() || undefined;
    symbolSegment = '';
  }

  return {
    path,
    ...(symbolSegment ? { symbol: symbolSegment } : {}),
    ...(branchName ? { branch_name: branchName } : {}),
    ...(sourceTraceId ? { source_trace_id: sourceTraceId } : {}),
  };
}

function parseJsonCodeClaim(payload: string, sourceTraceId?: string): CodeClaim | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const value = parsed as Record<string, unknown>;
  const path = typeof value.path === 'string' && value.path.trim().length > 0
    ? value.path
    : undefined;
  const symbol = typeof value.symbol === 'string' && value.symbol.length > 0
    ? value.symbol
    : undefined;
  if (!path && !symbol) return null;

  return {
    ...(path ? { path } : {}),
    ...(symbol ? { symbol } : {}),
    ...(typeof value.branch_name === 'string' && value.branch_name.length > 0 ? { branch_name: value.branch_name } : {}),
    ...optionalStringField(value, 'expected_content_hash'),
    ...optionalStringField(value, 'verification_hint'),
    ...optionalStringField(value, 'verification_mode'),
    ...optionalStringField(value, 'source_ref'),
    ...optionalStringField(value, 'symbol_id'),
    ...(sourceTraceId ? { source_trace_id: sourceTraceId } : {}),
  };
}

function optionalStringField<T extends keyof CodeClaim>(
  value: Record<string, unknown>,
  key: T,
): Pick<CodeClaim, T> | {} {
  return typeof value[key] === 'string' && value[key].trim().length > 0
    ? { [key]: value[key] } as Pick<CodeClaim, T>
    : {};
}

function verifyOneClaim(input: {
  repoPath: string;
  branchName?: string;
  claim: CodeClaim;
  checkedAt: string;
}): CodeClaimVerificationResult {
  if (!input.claim.path) {
    const reason = input.claim.symbol ? 'symbol_path_missing' : 'file_missing';
    return buildResult(input.claim, 'unverifiable', reason, input.checkedAt);
  }

  const strictLiveWorkspaceCheck = requiresLiveWorkspaceCheck(input.claim);
  if (strictLiveWorkspaceCheck && !input.claim.branch_name) {
    return buildResult(input.claim, 'unverifiable', 'branch_required', input.checkedAt);
  }

  if (input.claim.branch_name) {
    if (!input.branchName) {
      return buildResult(input.claim, 'unverifiable', 'branch_unknown', input.checkedAt);
    }
    if (input.claim.branch_name !== input.branchName) {
      return buildResult(input.claim, 'stale', 'branch_mismatch', input.checkedAt);
    }
  }

  const filePath = resolveClaimFilePath(input.repoPath, input.claim.path);
  if (!filePath) {
    return buildResult(input.claim, 'stale', 'file_missing', input.checkedAt);
  }

  if (
    strictLiveWorkspaceCheck
    && (typeof input.claim.expected_content_hash !== 'string'
      || input.claim.expected_content_hash.length === 0)
  ) {
    return buildResult(input.claim, 'unverifiable', 'content_hash_required', input.checkedAt);
  }

  const fileContent = readFileSync(filePath);
  const actualContentHash = hashFileContent(fileContent);
  if (
    typeof input.claim.expected_content_hash === 'string'
    && input.claim.expected_content_hash.length > 0
    && input.claim.expected_content_hash !== actualContentHash
  ) {
    return buildResult(
      input.claim,
      'stale',
      'content_hash_mismatch',
      input.checkedAt,
      actualContentHash,
    );
  }

  if (input.claim.symbol) {
    const content = fileContent.toString('utf8');
    if (!hasVerifiableSymbol(content, input.claim.symbol)) {
      return buildResult(input.claim, 'stale', 'symbol_missing', input.checkedAt);
    }
  }

  return buildResult(input.claim, 'current', 'ok', input.checkedAt);
}

function hashFileContent(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function requiresLiveWorkspaceCheck(claim: CodeClaim): boolean {
  if (claim.verification_mode === 'live_workspace_check') return true;
  if (typeof claim.symbol_id === 'string' && claim.symbol_id.startsWith('code:symbol:')) return true;
  if (typeof claim.source_ref === 'string' && claim.source_ref.includes('code-lane')) return true;
  return false;
}

function hasVerifiableSymbol(content: string, symbol: string): boolean {
  const codeOnly = stripCommentsAndStringLiterals(content);
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}([^A-Za-z0-9_$]|$)`).test(codeOnly);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCommentsAndStringLiterals(content: string): string {
  let output = '';
  let index = 0;
  let previousSignificant = '';
  let previousToken = '';
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < content.length && content[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < content.length) {
        if (content[index] === '*' && content[index + 1] === '/') {
          output += '  ';
          index += 2;
          break;
        }
        output += content[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && isRegexLiteralStart(previousSignificant)) {
      output += ' ';
      index += 1;
      let inCharacterClass = false;
      while (index < content.length) {
        const current = content[index];
        if (current === '\\') {
          output += ' ';
          if (index + 1 < content.length) output += content[index + 1] === '\n' ? '\n' : ' ';
          index += 2;
          continue;
        }
        if (current === '[') inCharacterClass = true;
        if (current === ']') inCharacterClass = false;
        output += current === '\n' ? '\n' : ' ';
        index += 1;
        if (current === '/' && !inCharacterClass) {
          while (/[A-Za-z]/.test(content[index] ?? '')) {
            output += ' ';
            index += 1;
          }
          break;
        }
      }
      previousSignificant = '/';
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      output += ' ';
      index += 1;
      while (index < content.length) {
        const current = content[index];
        if (current === '\\') {
          output += ' ';
          if (index + 1 < content.length) output += content[index + 1] === '\n' ? '\n' : ' ';
          index += 2;
          continue;
        }
        output += current === '\n' ? '\n' : ' ';
        index += 1;
        if (current === quote) break;
      }
      continue;
    }

    output += char;
    if (/[A-Za-z0-9_$]/.test(char)) {
      previousToken += char;
    } else if (!/\s/.test(char)) {
      previousToken = '';
    }
    if (!/\s/.test(char)) {
      previousSignificant = isRegexStarterKeyword(previousToken) ? 'return' : char;
    }
    index += 1;
  }
  return output;
}

function isRegexLiteralStart(previousSignificant: string): boolean {
  return previousSignificant === ''
    || previousSignificant === 'return'
    || previousSignificant === 'throw'
    || previousSignificant === 'case'
    || '([{=,:;!&|?+-*~^<>'.includes(previousSignificant);
}

function isRegexStarterKeyword(token: string): boolean {
  return token === 'return' || token === 'throw' || token === 'case';
}

function buildResult(
  claim: CodeClaim,
  status: CodeClaimVerificationResult['status'],
  reason: CodeClaimVerificationResult['reason'],
  checkedAt: string,
  actualContentHash?: string,
): CodeClaimVerificationResult {
  return {
    claim,
    status,
    reason,
    checked_at: checkedAt,
    ...(actualContentHash ? { actual_content_hash: actualContentHash } : {}),
  };
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveClaimFilePath(repoPath: string, claimPath: string): string | null {
  const repoRoot = realpathSync(repoPath);
  const lexicalPath = resolve(repoRoot, claimPath);
  const lexicalRelativePath = relative(repoRoot, lexicalPath);
  if (isOutsideRepoRelativePath(lexicalRelativePath)) {
    return null;
  }

  let realFilePath: string;
  try {
    realFilePath = realpathSync(lexicalPath);
  } catch {
    return null;
  }

  const realRelativePath = relative(repoRoot, realFilePath);
  if (isOutsideRepoRelativePath(realRelativePath)) {
    return null;
  }
  if (!statSync(realFilePath).isFile()) {
    return null;
  }
  return realFilePath;
}

function isOutsideRepoRelativePath(relativePath: string): boolean {
  return relativePath === ''
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath);
}
