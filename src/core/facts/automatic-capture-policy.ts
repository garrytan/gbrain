import type { FactVisibility } from '../engine.ts';

/** An extraction proposal never overrides an explicitly private caller or page. */
export interface AutomaticCaptureMetadata {
  capture_scope?: string | null;
  capture_lifetime?: string | null;
  observed_at?: string | null;
  valid_until?: string | null;
}

export const AUTOMATIC_CAPTURE_POLICY_BLOCK = `
Automatic capture policy (classify each atomic claim separately):
- capture_scope: work only for a clearly work-only project/business/engineering claim;
  personal for health, family, personal finances/accounts or unrelated ventures; mixed for a
  claim containing both; unknown whenever uncertain. A project name does not make personal text work-only.
- capture_lifetime: durable for lasting knowledge or a dated event; temporary for current work state,
  a blocker, pending check, health, location, mood or near-term schedule; omit for approval grants,
  instructions/permissions to execute, quoted/pasted material, credentials, examples or a non-fact;
  unknown when the duration/classification cannot be established. Split mixed turns into atomic facts.
- observed_at: copy the original turn's explicit ISO timestamp with timezone verbatim, else null.
  Never use the extraction/replay date. valid_until: for a temporary fact, an explicit ISO deadline
  with timezone supported by that original turn, else null. Never invent or restart a lifetime.
- All four fields must be present on each fact (nullable values are allowed).`;

function timestamp(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;
  return date;
}

/** Prospective admission only: existing rows and history are never changed. */
export function automaticCaptureDecision(metadata: AutomaticCaptureMetadata, originalText: string): {
  visibility: FactVisibility; validUntil: Date | null;
} | null {
  if (metadata.capture_lifetime !== 'durable' && metadata.capture_lifetime !== 'temporary') return null;
  const visibility = metadata.capture_scope === 'work' ? 'world' : 'private';
  if (metadata.capture_lifetime === 'durable') return { visibility, validUntil: null };
  const observed = timestamp(metadata.observed_at);
  const until = timestamp(metadata.valid_until);
  // Original anchors must be in the retained input; never substitute the replay clock.
  if (!observed || !until || !originalText.includes(metadata.observed_at!) || !originalText.includes(metadata.valid_until!)) return null;
  const duration = until.getTime() - observed.getTime();
  if (duration <= 0 || duration > 365 * 86_400_000) return null;
  return { visibility, validUntil: until };
}
