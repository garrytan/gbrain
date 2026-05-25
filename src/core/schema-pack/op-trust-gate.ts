// v0.38 T8: operations-layer trust gate for per-call schema_pack param.
//
// D13 + codex F4: per-call schema_pack opt (tier 1 in the resolution
// chain) can ONLY be honored when ctx.remote === false. Remote/MCP
// callers passing schema_pack — even with read+write scope — could
// broaden their effective read closure or escape strict-mode validation
// by pointing at a more-permissive pack. The v0.26.9 + v0.34.1.0 trust-
// boundary hardening waves spent weeks closing this exact class of bug
// for source_id; v0.38 re-applies the same posture for schema_pack.
//
// CLI callers (ctx.remote === false) override freely. MCP callers
// (ctx.remote === true) get the trust gate's permission_denied throw.
// Undefined/missing `remote` defaults to REMOTE (fail-closed per v0.26.9
// F7b — anything not strictly false is treated as untrusted).

import type { OperationContext } from '../operations.ts';
import { loadActivePack, type LoadActivePackInput } from './load-active.ts';
import { sourceScopeOpts } from '../operations.ts';
import type { ResolvedPack } from './registry.ts';
import { loadConfig } from '../config.ts';

/**
 * Thrown when a remote caller (ctx.remote !== false) passes the
 * per-call schema_pack param. Surfaced as `permission_denied` by the
 * operations.ts dispatch path with the standard error envelope.
 */
export class SchemaPackTrustGateError extends Error {
  readonly code: 'permission_denied' = 'permission_denied';
  constructor(message: string) {
    super(message);
    this.name = 'SchemaPackTrustGateError';
  }
}

/**
 * Validate the per-call schema_pack param against the trust gate.
 * Throws if a remote caller passes schema_pack; returns the validated
 * pack name (or undefined when not set) for downstream resolution.
 *
 * Pass the param value extracted from op params; the function expects
 * a string or undefined.
 */
export function validateSchemaPackTrustGate(
  ctx: OperationContext,
  schemaPackParam: unknown,
): string | undefined {
  if (schemaPackParam === undefined || schemaPackParam === null) {
    return undefined;
  }
  if (typeof schemaPackParam !== 'string') {
    throw new SchemaPackTrustGateError(
      `schema_pack must be a string; got ${typeof schemaPackParam}`,
    );
  }
  // Fail-closed: anything that isn't strictly remote=false is treated
  // as remote per the v0.26.9 F7b hardening posture.
  if (ctx.remote !== false) {
    throw new SchemaPackTrustGateError(
      'per-call schema_pack opt is rejected for remote/MCP callers. ' +
      'Pass via gbrain.yml `schema:` section, ~/.gbrain/config.json `schema_pack`, ' +
      'GBRAIN_SCHEMA_PACK env var, or `gbrain config set schema_pack <name>`. ' +
      'CLI callers (ctx.remote === false) can pass per-call.',
    );
  }
  return schemaPackParam;
}

/**
 * Convenience wrapper for op handlers — does the trust gate + loads
 * the active pack in one call. Returns the ResolvedPack. Throws
 * SchemaPackTrustGateError on trust violation; throws UnknownPackError
 * if the resolved pack isn't on disk.
 *
 * The handler typically calls this once at entry and stores the result
 * on a local for use across the handler body. For per-source ops, pass
 * `sourceId` from `sourceScopeOpts(ctx)`.
 */
export async function loadActivePackForOp(
  ctx: OperationContext,
  params: { schema_pack?: unknown },
): Promise<ResolvedPack> {
  const perCall = validateSchemaPackTrustGate(ctx, params.schema_pack);
  const scope = sourceScopeOpts(ctx);
  // v0.39 T19 + codex finding #2: pre-fix this collapsed sourceIds[] to
  // the FIRST entry, which is arbitrary pack selection for a federated
  // read. The correct behavior is: when federated_read is in play and
  // sources have divergent active packs, REJECT the request with a
  // permission_denied error pointing at v0.40+ per-source closure work.
  // Single-source reads (scope.sourceId scalar) keep the v0.34.1 semantics.
  let sourceId: string | undefined;
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    if (scope.sourceIds.length === 1) {
      sourceId = scope.sourceIds[0];
    } else {
      // Multi-source federated read: compare resolved pack names per
      // source. If they all agree, use the first; if they diverge, fail
      // closed with a permission_denied to surface the drift instead of
      // arbitrary pack selection.
      const { resolveActivePackName } = await import('./registry.ts');
      const cfg = loadConfig();
      const packNames = new Set<string>();
      for (const sid of scope.sourceIds) {
        const res = resolveActivePackName({
          remote: ctx.remote ?? true,
          envVar: process.env.GBRAIN_SCHEMA_PACK?.trim() || undefined,
          sourceId: sid,
          homeConfig: cfg?.schema_pack?.trim() || undefined,
        });
        packNames.add(res.pack_name);
      }
      if (packNames.size > 1) {
        throw new SchemaPackTrustGateError(
          `Federated read across ${scope.sourceIds.length} sources resolves to ${packNames.size} distinct packs (${[...packNames].join(', ')}). ` +
          `Per-source closure across mounts ships in v0.40+. Until then, ` +
          `register an OAuth client scoped to a single source OR have the sources agree on one pack.`,
        );
      }
      sourceId = scope.sourceIds[0];
    }
  } else {
    sourceId = scope.sourceId;
  }
  const input: LoadActivePackInput = {
    cfg: loadConfig(),
    remote: ctx.remote ?? true, // fail-closed default
    perCall,
    sourceId,
  };
  return await loadActivePack(input);
}
