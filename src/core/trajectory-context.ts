/**
 * Optional producer evidence for trajectory points, carried in the existing
 * `facts.context` column as JSON: `{"trajectory": {"time_basis", "scope",
 * "reported_on"}}`.
 *
 *   - `time_basis: 'valid'`: `valid_from` is when the value was true.
 *   - `time_basis: 'reported'`: `valid_from` is only when it was reported.
 *   - `scope`: the population or cohort the value measures; values with
 *     different scopes are different series.
 *
 * A context without a `trajectory` key keeps legacy behavior. An explicit but
 * malformed `trajectory` degrades to `time_basis: 'unknown'`, never to legacy
 * eligibility. Only these fields are projected; other context keys stay out.
 */
export interface TrajectoryEvidence {
  scope: string | null;
  time_basis: 'valid' | 'reported' | 'unknown';
  reported_on: string | null;
}

export function parseTrajectoryEvidence(context: string | null | undefined): TrajectoryEvidence | undefined {
  if (!context) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(context); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'trajectory')) return undefined;
  const raw = (parsed as Record<string, unknown>).trajectory;
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const scope = typeof value.scope === 'string' && value.scope.trim() ? value.scope.trim() : null;
  const basis = value.time_basis;
  return {
    scope,
    time_basis: basis === 'valid' || basis === 'reported' ? basis : 'unknown',
    reported_on: typeof value.reported_on === 'string' ? value.reported_on : null,
  };
}
