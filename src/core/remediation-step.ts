/**
 * RemediationStep (v0.40.3.0 — D6 refactor)
 *
 * Canonical structured-remediation type. Any doctor check that wants to
 * produce a paste-ready agent fix returns RemediationStep[] from its
 * check function. The `doctor --remediate` orchestrator walks them in
 * dependency order, submitting each as a Minion job and re-checking
 * between steps.
 *
 * Previously lived as `Remediation` inside
 * `src/core/brain-score-recommendations.ts`. Lifted here so other
 * check producers (lint, integrity, sync_failures) can emit
 * RemediationStep without circular-importing brain-score code that
 * doesn't apply to them. Same shape, just relocated + renamed for
 * clarity.
 *
 * Factory: `makeRemediationStep()` builds a step with content-stable
 * IDs via canonical JSON serialization per codex D12 Bug 2. Identical
 * params (regardless of key ordering) produce identical IDs so
 * idempotency_key dedup works across retries and across runtime
 * JSON-stringify ordering.
 */

import { createHash } from 'node:crypto';

/**
 * Severity buckets — drive ordering (critical first) and operator UX.
 */
export type RemediationSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Triage status of an individual check's autofix path. */
export type RemediationStatus = 'remediable' | 'human_only' | 'blocked';

/**
 * Structured remediation step emitted by doctor checks.
 *
 * Fields:
 *   id              — stable identifier (e.g. 'sync.repo', 'lint.fix:<slug>').
 *                     References other steps via depends_on.
 *   job             — Minion handler name. Must match a registered handler.
 *   params          — passed verbatim to the handler.
 *   idempotency_key — content-hash dedup key. Same (job, params) →
 *                     same key. Across retries (--remediate re-runs)
 *                     pre-existing failed jobs append `:r<N>` suffix.
 *   severity        — drives ordering.
 *   est_seconds     — upper-bound runtime estimate for budgeting.
 *   est_usd_cost    — USD cost estimate when applicable.
 *   depends_on      — other RemediationStep.id values that MUST complete
 *                     first. References ids, NOT check names.
 *   rationale       — one-line "what this fixes" for human output.
 *   protected       — true if `job` is in PROTECTED_JOB_NAMES.
 *   status          — always 'remediable' for executable plans;
 *                     `blocked` entries surface separately.
 *   blocked_reason  — populated when status === 'blocked'.
 */
export interface RemediationStep {
  id: string;
  job: string;
  params: Record<string, unknown>;
  idempotency_key: string;
  severity: RemediationSeverity;
  est_seconds: number;
  est_usd_cost?: number;
  depends_on?: string[];
  rationale: string;
  protected?: boolean;
  status: RemediationStatus;
  blocked_reason?: string;
}

/**
 * Canonical JSON serializer per codex D12 Bug 2: sorts object keys
 * recursively before stringify so the same logical params always
 * hash to the same value regardless of insertion order.
 *
 * Pure function; no external deps (deliberately not `fast-json-stable-stringify`
 * — we own this surface and it must stay zero-dep stable).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) =>
    JSON.stringify(k) + ':' + canonicalJson(obj[k])
  ).join(',') + '}';
}

/**
 * SHA-256 of a UTF-8 string, hex-encoded.
 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Build a content-stable IDEMPOTENCY KEY for a remediation step.
 *
 * Pattern: `<source>:<job>:sha8(canonical-JSON(params))` — same scheme
 * as the legacy `idemKey()` in brain-score-recommendations.ts. Factor
 * this helper so future check authors don't hand-roll the shape.
 */
export function idempotencyKey(
  source: string,
  job: string,
  params: Record<string, unknown>,
): string {
  return `${source}:${job}:${sha256Hex(canonicalJson(params)).slice(0, 8)}`;
}

/**
 * Canonical RemediationStep constructor. All check authors should use
 * this; never hand-roll the shape (drift hazard).
 *
 * Default `id` is the same content-hash idempotency_key. Override `id`
 * when you want a human-readable identifier (e.g. 'sync.repo').
 *
 * Codex D12 Bug 2 invariance: makeRemediationStep with {a:1, b:2} and
 * {b:2, a:1} produces IDENTICAL ids (pinned in test/remediation-step.test.ts).
 */
export function makeRemediationStep(opts: {
  job: string;
  params: Record<string, unknown>;
  severity: RemediationSeverity;
  est_seconds: number;
  est_usd_cost?: number;
  depends_on?: string[];
  rationale: string;
  protected?: boolean;
  /** Optional human-readable id. Defaults to the idempotency key. */
  id?: string;
  /** Source for the idempotency-key namespace. Defaults to 'default'. */
  source?: string;
  /** Status. Defaults to 'remediable' (the only kind that ships in plans). */
  status?: RemediationStatus;
}): RemediationStep {
  const source = opts.source ?? 'default';
  const idemKey = idempotencyKey(source, opts.job, opts.params);
  return {
    id: opts.id ?? idemKey,
    job: opts.job,
    params: opts.params,
    idempotency_key: idemKey,
    severity: opts.severity,
    est_seconds: opts.est_seconds,
    est_usd_cost: opts.est_usd_cost,
    depends_on: opts.depends_on,
    rationale: opts.rationale,
    protected: opts.protected,
    status: opts.status ?? 'remediable',
  };
}
