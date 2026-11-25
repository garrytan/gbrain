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
