/**
 * advisor/collect-setup-smells.ts — config/setup misconfigurations.
 *
 * Reads merged config + DB-plane keys. Each smell is a concrete, fixable setup
 * problem an owner usually wants to know about: embeddings disabled while a
 * populated brain wants search, a missing embedding key, or skill publishing off
 * while a remote-MCP brain serves agents (they'd hit an empty list_skills).
 */

import type { AdvisorCollector, AdvisorFinding } from './types.ts';

async function dbBool(ctx: { engine: { getConfig(k: string): Promise<string | null> } }, key: string): Promise<boolean | null> {
  try {
    const v = await ctx.engine.getConfig(key);
    if (v == null) return null;
    return v === 'true';
  } catch {
    return null;
  }
}

export const collectSetupSmells: AdvisorCollector = {
  id: 'setup-smells',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];
    const cfg = ctx.config ?? ({} as typeof ctx.config);

    // Embeddings disabled — deferred setup never completed. No command_argv:
    // `config set embedding_model` is hard-refused (schema-sizing file-plane
    // key); the sanctioned path is a re-init.
    if (cfg.embedding_disabled === true) {
      findings.push({
        id: 'embeddings_disabled',
        severity: 'warn',
        title: 'Embeddings are disabled — semantic search and dedup are off.',
        detail:
          'Enable with `gbrain init --force --embedding-model voyage:voyage-4` ' +
          '(set VOYAGE_API_KEY first).',
        fix: { command_argv: null },
        collector: 'setup-smells',
        ask_user: true,
      });
    } else {
      // v0.46.3: key the "will embeds work" claim on the EFFECTIVE model —
      // configless brains resolve the legacy runtime fallback until the
      // September cutover, so the credential that matters is that provider's,
      // not the recommended default's. Both key planes are checked (env +
      // file config; the DB plane is never read by the embed pipeline).
      const { DEFAULT_EMBEDDING_MODEL } = await import('../ai/defaults.ts');
      const { getRecipe } = await import('../ai/recipes/index.ts');
      const effectiveModel = cfg.embedding_model ?? DEFAULT_EMBEDDING_MODEL;
      const provider = effectiveModel.split(':')[0];
      const recipe = getRecipe(provider);
      const keyName = recipe?.auth_env?.required?.[0];
      const fileKeys: Record<string, string | undefined> = {
        OPENAI_API_KEY: cfg.openai_api_key,
        VOYAGE_API_KEY: cfg.voyage_api_key,
        ZEROENTROPY_API_KEY: cfg.zeroentropy_api_key,
      };
      const keyMissing = !!keyName && !process.env[keyName] && !fileKeys[keyName];
      if (keyMissing) {
        const { NEW_INSTALL_DEFAULT_EMBEDDING_MODEL, renderCanonicalMigrationCommands } =
          await import('../ai/defaults.ts');
        const rep = recipe?.sunset?.replacement?.embedding;
        const migrateCmd = !rep || rep === NEW_INSTALL_DEFAULT_EMBEDDING_MODEL
          ? renderCanonicalMigrationCommands().recommendedDryRun
          : `gbrain migrate embeddings --to ${rep} --dry-run`;
        const sunsetNote = recipe?.sunset
          ? ` NOTE: ${recipe.name} shuts down ${recipe.sunset.date} — migrate instead of ` +
            `setting its key: \`${migrateCmd}\`.`
          : '';
        findings.push({
          id: 'embedding_key_missing',
          severity: 'warn',
          title: `Embedding resolves to ${effectiveModel} but ${keyName} is not set — embedding will fail at write time.`,
          detail:
            `Set ${keyName} in the environment (or add it to ~/.gbrain/config.json).` +
            sunsetNote +
            ' To switch providers: `gbrain init --force --embedding-model voyage:voyage-4` with VOYAGE_API_KEY set.',
          fix: { command_argv: null },
          collector: 'setup-smells',
          ask_user: true,
        });
      }
    }

    // Remote-MCP brain serving agents but skill publishing is off → agents hit
    // an empty list_skills and never learn what the brain can do.
    if (cfg.remote_mcp) {
      const publishDb = await dbBool(ctx, 'mcp.publish_skills');
      const publish = publishDb ?? cfg.mcp?.publish_skills === true;
      if (!publish) {
        findings.push({
          id: 'publish_skills_off',
          severity: 'info',
          title: 'Skill publishing is off while this brain serves agents over MCP.',
          detail: 'Connected agents get an empty list_skills and miss this brain\'s capabilities.',
          fix: { command_argv: ['gbrain', 'config', 'set', 'mcp.publish_skills', 'true'] },
          collector: 'setup-smells',
          ask_user: true,
        });
      }
    }

    return findings;
  },
};
