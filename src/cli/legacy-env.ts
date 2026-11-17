/**
 * First import of every process entry (src/cli.ts, the agent installer, the
 * standalone auth tool): copy each `FORESIGHTS_*` variable into its stored
 * `GBRAIN_*` name when that is unset (core/brand.ts adoptAliasEnv), before any
 * module reads its settings. Children inherit it.
 */
import { adoptAliasEnv } from '../core/brand.ts';

/** The GBRAIN_* keys this process took from their FORESIGHTS_* alias (evaluated once, at first import). */
export const ALIAS_ENV_ADOPTED: readonly string[] = adoptAliasEnv(process.env);
