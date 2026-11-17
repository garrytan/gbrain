/**
 * The two refusals the Rust engine addon loader raises. Both are thrown before the brain is touched.
 * The suggestion is the registry's, so the CLI, the MCP envelope and the docs say the same thing.
 */
import { opError } from '../ops/contract.ts';
import { CODES } from '../error-registry.ts';

export type AddonMissingReason = (typeof CODES)['rust_engine_addon_missing']['reasons'][number];
export type AddonMismatchReason = (typeof CODES)['rust_engine_addon_mismatch']['reasons'][number];

/** Selected, but no addon for this release is installed, the override path is missing, or no addon is published for this target. */
export function addonMissing(reason: AddonMissingReason, message: string) {
  return opError('rust_engine_addon_missing', message, CODES.rust_engine_addon_missing.suggestion, { reason });
}

/** The addon is there but is not the build this release names (checksum, engine_abi, engine_build, target), or it does not load. */
export function addonMismatch(reason: AddonMismatchReason, message: string) {
  return opError('rust_engine_addon_mismatch', message, CODES.rust_engine_addon_mismatch.suggestion, { reason });
}
