/**
 * advisor/collect-schema-pack.ts — schema-pack resolvability (a setup smell).
 *
 * Source-aware (#7): resolution goes through loadActivePack, which honors the
 * per-source + brain-wide config tiers. A healthy brain resolves to its pack (or
 * the gbrain-base default) and emits nothing; a brain configured to a pack that
 * isn't on disk surfaces a warn so the owner can fix the config.
 */

import { loadActivePack } from '../schema-pack/load-active.ts';
import type { AdvisorCollector } from './types.ts';

export const collectSchemaPack: AdvisorCollector = {
  id: 'schema-pack',
  collect: async (ctx) => {
    let dbConfig: string | undefined;
    try {
      dbConfig = (await ctx.engine.getConfig('schema_pack')) ?? undefined;
    } catch {
      dbConfig = undefined;
    }
    try {
      await loadActivePack({ cfg: ctx.config, remote: ctx.remote, dbConfig });
      return []; // resolves cleanly → nothing to say
    } catch (err) {
      const name = dbConfig ?? ctx.config?.schema_pack ?? '(configured)';
      return [
        {
          id: 'schema_pack_unresolved',
          severity: 'warn',
          title: `The configured schema pack "${name}" could not be resolved.`,
          detail: `${(err as Error).message}. Pick an installed pack or clear the override.`,
          fix: { command_argv: ['gbrain', 'schema', 'packs'] },
          collector: 'schema-pack',
          ask_user: true,
        },
      ];
    }
  },
};
