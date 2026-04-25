import type { BrainEngine } from '../engine.ts';
import type {
  CodeClaim,
  CodeClaimVerificationResult,
  TaskThread,
  TaskWorkingSet,
} from '../types.ts';
import {
  extractCodeClaimsFromTrace,
  verifyCodeClaims,
} from './code-claim-verification-service.ts';

export interface TaskResumeCard {
  task_id: string;
  title: string;
  status: string;
  goal: string;
  current_summary: string;
  active_paths: string[];
  active_symbols: string[];
  blockers: string[];
  open_questions: string[];
  next_steps: string[];
  failed_attempts: string[];
  active_decisions: string[];
  latest_trace_route: string[];
  code_claim_verification: CodeClaimVerificationResult[];
  stale: boolean;
}

export async function buildTaskResumeCard(engine: BrainEngine, taskId: string): Promise<TaskResumeCard> {
  const thread = await engine.getTaskThread(taskId);
  if (!thread) {
    throw new Error(`Task thread not found: ${taskId}`);
  }

  const workingSet = await engine.getTaskWorkingSet(taskId);
  const attempts = await engine.listTaskAttempts(taskId, { limit: 5 });
  const decisions = await engine.listTaskDecisions(taskId, { limit: 5 });
  const traces = await expandCodeClaimSourceTraces(
    engine,
    await engine.listRetrievalTraces(taskId, { limit: 10 }),
  );
  const codeClaimVerification = verifyTaskCodeClaims(thread, workingSet, traces);
  const activePaths = workingSet?.active_paths ?? [];
  const activeSymbols = workingSet?.active_symbols ?? [];

  return {
    task_id: thread.id,
    title: thread.title,
    status: thread.status,
    goal: thread.goal,
    current_summary: sanitizeCodeSensitiveSummary(thread.current_summary, codeClaimVerification),
    active_paths: filterVerifiedActivePaths(activePaths, codeClaimVerification),
    active_symbols: filterVerifiedActiveSymbols(activeSymbols, activePaths, codeClaimVerification),
    blockers: workingSet?.blockers ?? [],
    open_questions: workingSet?.open_questions ?? [],
    next_steps: workingSet?.next_steps ?? [],
    failed_attempts: attempts
      .filter((attempt) => attempt.outcome === 'failed')
      .map((attempt) => attempt.summary),
    active_decisions: decisions.map((decision) => decision.summary),
    latest_trace_route: traces[0]?.route ?? [],
    code_claim_verification: codeClaimVerification,
    stale: workingSet?.last_verified_at == null
      || codeClaimVerification.some((result) => result.status === 'stale'),
  };
}

function verifyTaskCodeClaims(
  thread: TaskThread,
  workingSet: TaskWorkingSet | null,
  traces: Awaited<ReturnType<BrainEngine['listRetrievalTraces']>>,
): CodeClaimVerificationResult[] {
  const claims = collectTaskCodeClaims(thread, workingSet, traces);
  const unlocatedActiveSymbolClaims = collectUnlocatedActiveSymbolClaims(workingSet, claims);
  if (claims.length === 0 && unlocatedActiveSymbolClaims.length === 0) {
    return [];
  }
  if (!thread.repo_path) {
    const checkedAt = new Date().toISOString();
    return dedupeCodeClaimVerificationResults([...claims, ...unlocatedActiveSymbolClaims].map((claim) => ({
      claim,
      status: 'unverifiable',
      reason: 'repo_missing',
      checked_at: checkedAt,
    })));
  }

  const verifiedClaims = verifyCodeClaims({
    repo_path: thread.repo_path,
    branch_name: thread.branch_name,
    claims,
  });
  if (verifiedClaims.every((result) => result.reason === 'repo_missing')) {
    const checkedAt = new Date().toISOString();
    return dedupeCodeClaimVerificationResults([
      ...verifiedClaims,
      ...unlocatedActiveSymbolClaims.map((claim) => ({
        claim,
        status: 'unverifiable' as const,
        reason: 'repo_missing' as const,
        checked_at: checkedAt,
      })),
    ]);
  }

  return dedupeCodeClaimVerificationResults([
    ...verifiedClaims,
    ...verifyUnlocatedActiveSymbolsAgainstActivePaths(thread, workingSet, claims),
  ]);
}

function collectTaskCodeClaims(
  thread: TaskThread,
  workingSet: TaskWorkingSet | null,
  traces: Awaited<ReturnType<BrainEngine['listRetrievalTraces']>>,
): CodeClaim[] {
  const traceClaims = traces.flatMap((trace) => extractCodeClaimsFromTrace(trace));
  const claims: CodeClaim[] = [...traceClaims];
  const activePaths = workingSet?.active_paths ?? [];

  for (const path of activePaths) {
    claims.push({ path });
  }
  for (const path of extractCodeLikePaths(thread.current_summary)) {
    claims.push({ path });
  }
  for (const claim of extractPathScopedBareSymbolClaims(thread.current_summary)) {
    claims.push(claim);
  }
  for (const symbol of extractBacktickedCodeLikeSymbols(thread.current_summary)) {
    const hasLocatedClaim = claims.some((claim) => claim.symbol === symbol && claim.path);
    if (!hasLocatedClaim) {
      claims.push({ symbol });
    }
  }

  for (const symbol of workingSet?.active_symbols ?? []) {
    if (activePaths.length > 0) {
      for (const path of activePaths) {
        claims.push({ path, symbol });
      }
    } else {
      claims.push({ symbol });
    }
  }

  return dedupeCodeClaims(claims);
}

function collectUnlocatedActiveSymbolClaims(
  workingSet: TaskWorkingSet | null,
  claims: CodeClaim[],
): CodeClaim[] {
  const activeSymbols = workingSet?.active_symbols ?? [];
  return activeSymbols
    .filter((symbol) => !claims.some((claim) => claim.symbol === symbol))
    .map((symbol) => ({ symbol }));
}

function verifyUnlocatedActiveSymbolsAgainstActivePaths(
  thread: TaskThread,
  workingSet: TaskWorkingSet | null,
  claims: CodeClaim[],
): CodeClaimVerificationResult[] {
  const activePaths = workingSet?.active_paths ?? [];
  if (activePaths.length === 0) return [];

  const claimsToVerify = (workingSet?.active_symbols ?? [])
    .flatMap((symbol) => activePaths
      .filter((path) => !claims.some((claim) => claim.symbol === symbol && claim.path === path))
      .map((path) => ({ path, symbol })));
  if (claimsToVerify.length === 0) return [];

  const results = verifyCodeClaims({
    repo_path: thread.repo_path as string,
    branch_name: thread.branch_name,
    claims: dedupeCodeClaims(claimsToVerify),
  });
  const bySymbol = new Map<string, CodeClaimVerificationResult[]>();
  for (const result of results) {
    if (!result.claim.symbol) continue;
    bySymbol.set(result.claim.symbol, [...(bySymbol.get(result.claim.symbol) ?? []), result]);
  }

  const scopedResults: CodeClaimVerificationResult[] = [];
  for (const symbolResults of bySymbol.values()) {
    const currentResults = symbolResults.filter((result) => result.status === 'current');
    scopedResults.push(...(currentResults.length > 0 ? currentResults : symbolResults));
  }
  return scopedResults;
}

function dedupeCodeClaims(claims: CodeClaim[]): CodeClaim[] {
  const byKey = new Map<string, CodeClaim>();
  for (const claim of claims) {
    const key = [
      claim.path ?? '',
      claim.symbol ?? '',
      claim.branch_name ?? '',
      claim.source_trace_id ?? '',
    ].join('\0');
    if (!byKey.has(key)) {
      byKey.set(key, claim);
    }
  }
  return [...byKey.values()];
}

function dedupeCodeClaimVerificationResults(
  results: CodeClaimVerificationResult[],
): CodeClaimVerificationResult[] {
  const byKey = new Map<string, CodeClaimVerificationResult>();
  for (const result of results) {
    const key = [
      result.claim.path ?? '',
      result.claim.symbol ?? '',
      result.claim.branch_name ?? '',
      result.claim.source_trace_id ?? '',
      result.status,
      result.reason,
    ].join('\0');
    if (!byKey.has(key)) {
      byKey.set(key, result);
    }
  }
  return [...byKey.values()];
}

function extractCodeLikePaths(text: string): string[] {
  const paths: string[] = [];
  const pathPattern = /(^|[\s([{"'`])((?:(?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+)\.[A-Za-z0-9_+-]+)(?=$|[\s)\]}",.'`;:])/g;
  for (const match of text.matchAll(pathPattern)) {
    const path = match[2]?.trim();
    if (path && isCodeLikePath(path) && !paths.includes(path)) paths.push(path);
  }

  const extensionlessRootPattern = /(^|[\s([{"'`])((?:README|CHANGELOG|LICENSE|Dockerfile))(?!\.[A-Za-z0-9_+-])(?=$|[\s)\]}",.'`;:])/gi;
  for (const match of text.matchAll(extensionlessRootPattern)) {
    const path = match[2]?.trim();
    if (path && isCodeLikePath(path) && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function isCodeLikePath(path: string): boolean {
  if (/^(README|CHANGELOG|LICENSE|Dockerfile)(\.[A-Za-z0-9_+-]+)?$/i.test(path)) return true;
  if (/^(package|tsconfig|jsconfig|bunfig|eslint\.config|vite\.config)\.[A-Za-z0-9_+-]+$/i.test(path)) return true;
  const extension = path.split('.').pop()?.toLowerCase();
  return [
    'cjs',
    'css',
    'cts',
    'go',
    'html',
    'js',
    'json',
    'jsx',
    'md',
    'mjs',
    'mts',
    'py',
    'rs',
    'sql',
    'tsx',
    'ts',
    'yaml',
    'yml',
  ].includes(extension ?? '');
}

function extractBacktickedCodeLikeSymbols(text: string): string[] {
  const symbols: string[] = [];
  const symbolPattern = /`([A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|\.)[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(\))?)`/g;
  for (const match of text.matchAll(symbolPattern)) {
    const symbol = match[1]?.trim();
    if (symbol && !symbol.includes('/')) symbols.push(symbol);
  }
  return symbols;
}

function extractPathScopedBareSymbolClaims(text: string): CodeClaim[] {
  const claims: CodeClaim[] = [];
  for (const path of extractCodeLikePaths(text)) {
    const escapedPath = escapeRegExp(path);
    const symbolTokenPattern = '`?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|\\.)[A-Za-z_$][A-Za-z0-9_$]*)*(?:\\(\\))?`?';
    const symbolListSeparatorPattern = `(?:\\s*,\\s*(?:(?:and|or)\\s+)?|\\s+(?:and|or)\\s+)`;
    const symbolListPattern = `${symbolTokenPattern}(?:${symbolListSeparatorPattern}${symbolTokenPattern})*`;
    const symbolCapturePattern = '`?([A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|\\.)[A-Za-z_$][A-Za-z0-9_$]*)*(?:\\(\\))?)`?';
    const strongPathThenSymbols = new RegExp(
      `${escapedPath}\\s+(?:now\\s+)?(?:implements|defines|exports)\\s+(?:the\\s+)?(${symbolListPattern})`,
      'g',
    );
    const weakPathThenSymbol = new RegExp(
      `${escapedPath}\\s+(?:now\\s+)?(?:contains|uses|calls|references|handles|verifies)\\s+(?:the\\s+)?${symbolCapturePattern}`,
      'g',
    );
    const strongSymbolsThenPath = new RegExp(
      `(${symbolListPattern})\\s+(?:is\\s+|are\\s+)?(?:implemented|defined|exported|declared)\\s+(?:in|by|from|within|inside)\\s+${escapedPath}`,
      'g',
    );
    const weakSymbolThenPath = new RegExp(
      `${symbolCapturePattern}\\s+(?:is\\s+)?(?:used|called|referenced|handled|verified)\\s+(?:in|by|from|within|inside)\\s+${escapedPath}`,
      'g',
    );

    for (const match of text.matchAll(strongPathThenSymbols)) {
      for (const symbol of extractSymbolsFromSummaryList(match[1], { allowPlainIdentifier: true })) {
        claims.push({ path, symbol });
      }
    }
    for (const match of text.matchAll(weakPathThenSymbol)) {
      const symbol = normalizeSummarySymbol(match[1], { allowPlainIdentifier: false });
      if (symbol) claims.push({ path, symbol });
    }
    for (const match of text.matchAll(strongSymbolsThenPath)) {
      for (const symbol of extractSymbolsFromSummaryList(match[1], { allowPlainIdentifier: true })) {
        claims.push({ path, symbol });
      }
    }
    for (const match of text.matchAll(weakSymbolThenPath)) {
      const symbol = normalizeSummarySymbol(match[1], { allowPlainIdentifier: false });
      if (symbol) claims.push({ path, symbol });
    }
  }
  return dedupeCodeClaims(claims);
}

function extractSymbolsFromSummaryList(
  symbolList: string | undefined,
  options: { allowPlainIdentifier: boolean },
): string[] {
  return (symbolList ?? '')
    .split(/(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)/)
    .map((symbol) => normalizeSummarySymbol(symbol, options))
    .filter((symbol): symbol is string => symbol != null);
}

function normalizeSummarySymbol(
  symbol: string | undefined,
  options: { allowPlainIdentifier: boolean },
): string | null {
  const normalized = symbol?.trim().replace(/^`|`$/g, '').replace(/\(\)$/, '');
  if (!normalized || !isSummarySymbol(normalized)) return null;
  if (!options.allowPlainIdentifier && !isLikelyCodeSymbol(normalized)) return null;
  return normalized;
}

function isSummarySymbol(symbol: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|\.)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(symbol);
}

function isLikelyCodeSymbol(symbol: string): boolean {
  return /[A-Z_$]/.test(symbol)
    || symbol.includes('.')
    || symbol.includes('::');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function filterVerifiedActivePaths(
  activePaths: string[],
  results: CodeClaimVerificationResult[],
): string[] {
  return activePaths.filter((path) => {
    const pathResults = results.filter((result) => result.claim.path === path);
    if (pathResults.some((result) => result.reason === 'branch_unknown')) return false;
    if (pathResults.some((result) => result.status === 'current')) return true;
    return !pathResults.some((result) => isBlockingPathCodeClaim(result));
  });
}

function filterVerifiedActiveSymbols(
  activeSymbols: string[],
  activePaths: string[],
  results: CodeClaimVerificationResult[],
): string[] {
  return activeSymbols.filter((symbol) => {
    const symbolResults = results.filter((result) => result.claim.symbol === symbol);
    if (symbolResults.some((result) =>
      result.reason === 'branch_unknown' && claimAppliesToActivePaths(result.claim, activePaths))) {
      return false;
    }
    if (hasCurrentSymbolClaimOnActivePath(symbolResults, activePaths)) return true;
    return !symbolResults.some((result) =>
      isBlockingFailedCodeClaim(result) && claimAppliesToActivePaths(result.claim, activePaths));
  });
}

function sanitizeCodeSensitiveSummary(
  summary: string,
  results: CodeClaimVerificationResult[],
): string {
  const hasFailedReferencedClaim = results.some((result) =>
    isBlockingSummaryCodeClaim(summary, result, results));
  if (!hasFailedReferencedClaim) return summary;
  return 'Code-sensitive summary withheld: one or more referenced code claims failed verification.';
}

function isBlockingFailedCodeClaim(result: CodeClaimVerificationResult): boolean {
  return result.status === 'stale'
    || result.reason === 'symbol_path_missing'
    || result.reason === 'branch_unknown';
}

function isBlockingPathCodeClaim(result: CodeClaimVerificationResult): boolean {
  return result.reason === 'file_missing'
    || result.reason === 'branch_mismatch'
    || result.reason === 'branch_unknown';
}

function isBlockingSummaryCodeClaim(
  summary: string,
  result: CodeClaimVerificationResult,
  results: CodeClaimVerificationResult[],
): boolean {
  if (result.claim.symbol && summaryReferencesSymbol(summary, result.claim.symbol)) {
    if (result.reason === 'branch_unknown') {
      return branchUnknownAppliesToSummary(summary, result, results);
    }
    if (summaryReferencesStaleBranch(summary, result)) return true;
    if (result.claim.path && summary.includes(result.claim.path)) {
      if (hasCurrentSummaryClaimForExactClaim(summary, result.claim, results)) return false;
      return isBlockingFailedCodeClaim(result) || result.reason === 'repo_missing';
    }
    if (hasCurrentSummaryClaimForSymbol(summary, result.claim.symbol, results)) return false;
    return isBlockingFailedCodeClaim(result) || result.reason === 'repo_missing';
  }
  if (result.claim.path && summary.includes(result.claim.path)) {
    if (result.reason === 'branch_unknown') {
      return branchUnknownAppliesToSummary(summary, result, results);
    }
    if (summaryReferencesStaleBranch(summary, result)) return true;
    if (hasCurrentSummaryClaimForPath(summary, result.claim.path, results)) return false;
    return isBlockingPathCodeClaim(result) || result.reason === 'repo_missing';
  }
  return false;
}

function branchUnknownAppliesToSummary(
  summary: string,
  result: CodeClaimVerificationResult,
  results: CodeClaimVerificationResult[],
): boolean {
  if (result.claim.branch_name && summary.includes(result.claim.branch_name)) return true;
  if (result.claim.path && summary.includes(result.claim.path)) return true;
  if (result.claim.symbol && hasCurrentSummaryClaimForSymbol(summary, result.claim.symbol, results)) return false;
  return true;
}

function summaryReferencesStaleBranch(
  summary: string,
  result: CodeClaimVerificationResult,
): boolean {
  return result.reason === 'branch_mismatch'
    && result.claim.branch_name != null
    && summary.includes(result.claim.branch_name);
}

function hasCurrentSymbolClaimOnActivePath(
  symbolResults: CodeClaimVerificationResult[],
  activePaths: string[],
): boolean {
  return symbolResults.some((result) =>
    result.status === 'current'
      && result.claim.symbol
      && claimAppliesToActivePaths(result.claim, activePaths));
}

function claimAppliesToActivePaths(claim: CodeClaim, activePaths: string[]): boolean {
  return activePaths.length === 0
    || !claim.path
    || activePaths.includes(claim.path);
}

function hasCurrentSummaryClaimForSymbol(
  summary: string,
  symbol: string,
  results: CodeClaimVerificationResult[],
): boolean {
  return results.some((result) =>
    result.status === 'current'
      && result.claim.symbol === symbol
      && (!result.claim.path || summary.includes(result.claim.path)));
}

function hasCurrentSummaryClaimForExactClaim(
  summary: string,
  claim: CodeClaim,
  results: CodeClaimVerificationResult[],
): boolean {
  return results.some((result) =>
    result.status === 'current'
      && result.claim.path === claim.path
      && result.claim.symbol === claim.symbol
      && (!result.claim.path || summary.includes(result.claim.path)));
}

function hasCurrentSummaryClaimForPath(
  summary: string,
  path: string,
  results: CodeClaimVerificationResult[],
): boolean {
  return results.some((result) =>
    result.status === 'current'
      && result.claim.path === path
      && summary.includes(result.claim.path));
}

function summaryReferencesSymbol(summary: string, symbol: string): boolean {
  return containsIdentifier(summary, symbol);
}

function containsIdentifier(text: string, identifier: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier)) return text.includes(identifier);
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(text);
}

async function expandCodeClaimSourceTraces(
  engine: BrainEngine,
  traces: Awaited<ReturnType<BrainEngine['listRetrievalTraces']>>,
): Promise<Awaited<ReturnType<BrainEngine['listRetrievalTraces']>>> {
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const referencedTraceIds = traces.flatMap((trace) =>
    trace.source_refs
      .filter((sourceRef) => sourceRef.startsWith('retrieval_trace:'))
      .map((sourceRef) => sourceRef.slice('retrieval_trace:'.length)));

  for (const traceId of referencedTraceIds) {
    if (byId.has(traceId)) continue;
    const sourceTrace = await engine.getRetrievalTrace(traceId);
    if (sourceTrace) {
      byId.set(sourceTrace.id, sourceTrace);
    }
  }

  return [...byId.values()];
}
