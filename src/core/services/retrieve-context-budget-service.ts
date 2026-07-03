const DEFAULT_READ_CONTEXT_MAX_SELECTORS = 3;
const TOKEN_BUDGET_CANDIDATE_DIVISOR = 600;
const TOKEN_BUDGET_READ_DIVISOR = 1200;
const TOKEN_BUDGET_ORIENTATION_FLOOR = 2000;

export function candidateLimitForTokenBudget(requestedLimit: number, tokenBudget: number | undefined): number {
  if (tokenBudget === undefined) return requestedLimit;
  return Math.min(requestedLimit, Math.max(3, Math.floor(tokenBudget / TOKEN_BUDGET_CANDIDATE_DIVISOR)));
}

export function requiredReadLimitForTokenBudget(candidateLimit: number, tokenBudget: number | undefined): number {
  if (tokenBudget === undefined) return Math.min(candidateLimit, DEFAULT_READ_CONTEXT_MAX_SELECTORS);
  return Math.min(
    candidateLimit,
    DEFAULT_READ_CONTEXT_MAX_SELECTORS,
    Math.max(1, Math.floor(tokenBudget / TOKEN_BUDGET_READ_DIVISOR)),
  );
}

export function shouldIncludeOrientationForTokenBudget(
  tokenBudget: number | undefined,
  includeOrientation: boolean,
): boolean {
  if (!includeOrientation) return false;
  return tokenBudget === undefined || tokenBudget >= TOKEN_BUDGET_ORIENTATION_FLOOR;
}
