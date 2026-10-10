import { BRAIN_TOOL_ALLOWLIST } from '../minions/tools/brain-tool-allowlist.ts';
import type { TrustedSubmitOpts } from '../minions/queue.ts';

/** Explicit trusted producer for one synthesis child; never inferred from ambient CLI state. */
export type LocalSubagentSubmit = (
  data: Record<string, unknown>,
  operations: readonly string[],
  prefixes: readonly string[],
) => Promise<TrustedSubmitOpts>;

/**
 * Trusted-submit options for a synthesis child. An explicit producer mints a
 * payload-bound capability over the exact tool allowlist (stamped onto the
 * payload first); legacy producers keep the plain protected-submit flag.
 */
export async function childSubmitAuthority(
  localSubagentSubmit: LocalSubagentSubmit | undefined,
  childData: Record<string, unknown>,
  allowedSlugPrefixes: readonly string[],
): Promise<TrustedSubmitOpts> {
  const allowedOperations = [...BRAIN_TOOL_ALLOWLIST];
  if (localSubagentSubmit) childData.allowed_tools = allowedOperations;
  return localSubagentSubmit
    ? await localSubagentSubmit(childData, allowedOperations, allowedSlugPrefixes)
    : { allowProtectedSubmit: true };
}
