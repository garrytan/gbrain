/**
 * `gbrain sources set-trust <id> <tier>` / `--clear` (#5575 A3): the per-source
 * trust default (`sources.config.trust_tier`) that owner sync and import of
 * that source start from, for mirrors of third-party repositories. It can
 * only lower: the highest accepted value is operator_curated (the owner-sync
 * tier), and page frontmatter markers still lower further. Trusted local CLI
 * only (the sources command has no MCP surface). Applies to rows written by
 * the next sync or import; existing rows keep their tier. Any value but
 * operator_curated (or --clear) ends a `gbrain trust claim-sources` claim.
 */
import type { BrainEngine } from '../core/engine.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../core/sources-load.ts';
import { OWNER_TIER_FLOOR, TRUST_TIERS, compareTrust, isTrustTier, trustLabel } from '../core/trust/tier.ts';
import { dropClaimUnlessOwnerDefault, isClaimedConfig } from '../core/trust/claim-state.ts';

const ACCEPTED = TRUST_TIERS.filter(tier => compareTrust(tier, OWNER_TIER_FLOOR) <= 0);
export const SOURCES_SET_TRUST_USAGE = `Usage: gbrain sources set-trust <id> <${ACCEPTED.join('|')}> | --clear`;

export async function runSetTrust(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, value] = args;
  if (!id || id.startsWith('-') || !value) {
    console.error(SOURCES_SET_TRUST_USAGE);
    process.exit(2);
  }
  if (value !== '--clear' && (!isTrustTier(value) || compareTrust(value, OWNER_TIER_FLOOR) > 0)) {
    console.error(`${JSON.stringify(value)} is not a source trust default. Accepted: ${ACCEPTED.join(', ')} (user_confirmed is only ever set by the owner confirming a row: gbrain trust confirm).`);
    process.exit(2);
  }
  const [src] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src.config);
  const claimed = isClaimedConfig(config);
  if (value === '--clear') delete config.trust_tier;
  else config.trust_tier = value;
  await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify(normalizeSourceConfig(dropClaimUnlessOwnerDefault(config))), id]);
  if (claimed && value !== OWNER_TIER_FLOOR) console.log(`Source "${id}" is no longer claimed (gbrain trust claim-sources); rows it already lifted keep their tier.`);
  console.log(value === '--clear'
    ? `Source "${id}" syncs at the owner default again (${OWNER_TIER_FLOOR}: "${trustLabel(OWNER_TIER_FLOOR)}"), lowered by page markers. Existing rows keep their tier.`
    : `Source "${id}" now syncs at ${value} ("${trustLabel(value as never)}") or lower. It applies to pages the next sync or import writes; existing rows keep their tier.`);
}
