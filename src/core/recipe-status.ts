/**
 * recipe-status — shared "which integrations are configured?" answer.
 *
 * This module exists to keep the CLI flag registry honest, and inlining it
 * back into its consumer will silently regress that.
 *
 * `scripts/generate-flag-registry.ts` derives each command's legal flags by
 * scanning the command module PLUS one level of that module's relative
 * imports. When `commands/features.ts` imported `commands/integrations.ts`
 * directly, every flag literal in the integrations command was attributed to
 * `gbrain features`, which would then have accepted flags it does not read —
 * precisely the silent-acceptance class v0.42.76.0's strict validation exists
 * to eliminate.
 *
 * Routing through this module keeps the scan one level deep and flag-free:
 * features -> recipe-status (scanned, contributes nothing) -> integrations
 * (two levels out, not scanned).
 *
 * NOTE: the generator scans raw text, comments included, so never write a
 * literal flag spelling in this file — mentioning one here is enough to
 * attribute it to `gbrain features`. Describe flags in prose instead.
 *
 * Any module needing recipe config status from a command should import it
 * from here rather than reaching into commands/integrations.ts.
 */

export { listRecipeConfigStatus } from '../commands/integrations.ts';
