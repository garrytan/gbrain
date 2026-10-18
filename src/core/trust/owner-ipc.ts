/**
 * Owner trust actions over the resident owner's local administration socket
 * (#5575: DX-2, ENG-15). When a `gbrain serve` holds a PGLite brain, the CLI
 * cannot open it, so `gbrain trust` sends three administration requests over
 * the 0600 persistence socket (persistence/ipc.ts `kind: 'administration'`,
 * CLI lane only, verified against the CLI's durable registration):
 *
 *   trust_read     the review listing or an explanation (read-only)
 *   trust_preview  what the owner approves: summary, typed token, binding
 *   trust_apply    the approved action with that binding
 *
 * The typed-token prompt runs in the invoking CLI between preview and apply.
 * The owner re-runs the preview, refuses a moved binding (`preview_changed`)
 * and accepts the confirmation only from the verified local CLI registration.
 * None of these are operations: an MCP session hosted by the same process
 * (stdio or HTTP) has no path to them.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { currentVerifiedLocalWriter } from '../persistence/identity.ts';
import { OWNER_ACTIONS, applyOwnerAction, previewOwnerAction, type OwnerActionInput } from './owner-actions.ts';
import { buildTrustReview, explainTrust, parseTrustReviewKind } from './review.ts';

export const TRUST_ADMIN_OPERATIONS = ['trust_read', 'trust_preview', 'trust_apply'] as const;
export type TrustAdminOperation = typeof TRUST_ADMIN_OPERATIONS[number];

const bad = (message: string) => opError('invalid_params', message,
  'This gbrain CLI and the running owner disagree on the trust request shape; run the same release on both (restart the serve after upgrading).');
const optString = (value: unknown, key: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw bad(`${key} must be a string.`);
  return value;
};

/** Validates the action input exactly; unknown keys refuse. */
export function parseOwnerActionInput(value: unknown): OwnerActionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('input must be an object.');
  const v = value as Record<string, unknown>;
  const allowed = ['action', 'ref', 'source', 'version', 'uri_prefix', 'reason_family', 'reason'];
  const extra = Object.keys(v).filter(k => !allowed.includes(k));
  if (extra.length) throw bad(`Unsupported trust input keys: ${extra.join(', ')}.`);
  if (!(OWNER_ACTIONS as readonly string[]).includes(String(v.action))) throw bad(`Unknown trust action ${JSON.stringify(v.action)}.`);
  if (v.version !== undefined && !(typeof v.version === 'number' && Number.isSafeInteger(v.version) && v.version > 0)) throw bad('version must be a positive integer.');
  return {
    action: v.action as OwnerActionInput['action'], ref: optString(v.ref, 'ref'), source: optString(v.source, 'source') ?? null,
    ...(v.version !== undefined ? { version: v.version as number } : {}),
    uri_prefix: optString(v.uri_prefix, 'uri_prefix') ?? null, reason_family: optString(v.reason_family, 'reason_family') ?? null, reason: optString(v.reason, 'reason') ?? null,
  };
}

export async function runTrustAdministration(engine: BrainEngine, operation: TrustAdminOperation, params: Record<string, unknown>, config?: GBrainConfig): Promise<Record<string, unknown>> {
  const writer = currentVerifiedLocalWriter();
  if (!writer || writer.remote || writer.principal.kind !== 'local_cli') {
    throw trustedCliRequired('Owner trust actions run only from this brain\'s trusted local CLI registration.');
  }
  if (operation === 'trust_read') {
    if (params.view === 'review') {
      const f = (params.filter ?? {}) as Record<string, unknown>;
      return { ...await buildTrustReview(engine, {
        ...(typeof f.source === 'string' ? { sourceId: f.source } : {}),
        ...(typeof f.kind === 'string' ? { kind: parseTrustReviewKind(f.kind) } : {}),
        ...(typeof f.since === 'string' ? { since: new Date(f.since) } : {}),
      }) };
    }
    if (params.view === 'explain' && typeof params.query === 'string') {
      return { items: await explainTrust(engine, params.query, { source: optString(params.source, 'source') ?? null }) };
    }
    throw bad('trust_read needs view review, or view explain with a query.');
  }
  const input = parseOwnerActionInput(params.input);
  if (operation === 'trust_preview') return { ...await previewOwnerAction(engine, input) };
  if (typeof params.binding !== 'string') throw bad('trust_apply needs the binding from trust_preview.');
  if (params.confirmed !== undefined && params.confirmed !== 'tty') throw bad('confirmed must be "tty" when present.');
  return { ...await applyOwnerAction(engine, input, {
    binding: params.binding, confirmation: params.confirmed === 'tty' ? { via: 'tty' } : null, by: writer.principal, config,
  }) };
}
