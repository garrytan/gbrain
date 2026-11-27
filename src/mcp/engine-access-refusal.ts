/**
 * The refusal `dispatchToolCall` returns before any work when a caller that is not trusted-local
 * reaches an engine that does not enforce visibility, owner and folder policy itself.
 *
 * The SQL engines apply private pages, `readable_by`, owners and folders inside each query
 * (`access_control`). The Rust store does not yet, so a remote caller (stdio or HTTP MCP, or any
 * caller whose `remote` is not strictly `false`) is refused with `engine_capability_missing`
 * naming `access_control`, and nothing runs. The trusted local CLI (`remote: false`) is not
 * affected. An engine with no readable capability set fails closed when its kind is `rust`.
 */
import type { OperationError } from '../core/ops/contract.ts';
import { capabilityMissing } from '../core/rust-engine/errors.ts';

export function remoteAccessRefusal(
  engine: { readonly kind?: unknown; readonly capabilities?: unknown },
  name: string,
  remote: boolean | undefined,
): OperationError | null {
  if (remote === false) return null;
  const caps = engine.capabilities as { has?: unknown } | undefined;
  const lacks = typeof caps?.has === 'function'
    ? !(caps as ReadonlySet<string>).has('access_control')
    : engine.kind === 'rust';
  return lacks ? capabilityMissing('access_control', `${name} for a remote caller`) : null;
}

/**
 * The refusal `dispatchToolCall` returns, before any work, for the brain owner's remote read on a Rust brain. An owner's
 * remote read is a lineage read (CallerAccess.lineage: the origin check and the fact provenance of its own member page),
 * which the Rust store does not model yet (lane 11, rust-engine/member-page-withdrawal-owner, then the owner fact reads
 * on rust-engine/remote-access-parity). Without this refusal each member the read reaches refuses on its own, or a
 * best-effort part of the answer is dropped; this names the gap once, the same way for every op. Every other caller,
 * and the owner on PGLite and Postgres, is not affected.
 */
export function ownerLineageRefusal(
  engine: { readonly kind?: unknown },
  name: string,
  access: { readonly owner?: boolean; readonly lineage?: boolean },
): OperationError | null {
  if (engine.kind !== 'rust' || access.owner !== true || access.lineage !== true) return null;
  return capabilityMissing('access_control', `${name} for the brain owner's remote read (the owner lineage read)`);
}
