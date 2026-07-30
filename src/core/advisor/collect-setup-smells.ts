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

    // Embeddings disabled — deferred setup never completed.
    if (cfg.embedding_disabled === true) {
      findings.push({
        id: 'embeddings_disabled',
        severity: 'warn',
        title: 'Embeddings are disabled — semantic search and dedup are off.',
        detail: 'Set an embedding model to turn on vector search.',
        fix: { command_argv: ['gbrain', 'config', 'set', 'embedding_model', '<model-id>'] },
        collector: 'setup-smells',
        ask_user: true,
      });
    } else if (!cfg.embedding_model && !cfg.openai_api_key && !process.env.OPENAI_API_KEY) {
      // No embedding_model configured → the compiled default (ollama:bge-m3)
      // applies at embed time, which needs a running Ollama daemon with the
      // model pulled. Post-v0.37 installs always persist embedding_model at
      // init, so landing here usually means setup never completed. No key
      // for the hosted fallback either → flag it. (Deliberately no network
      // probe here — advisor collectors stay cheap; `gbrain doctor` probes.)
      findings.push({
        id: 'embedding_key_missing',
        severity: 'warn',
        title: 'No embedding provider configured — embedding may fail at write time.',
        detail:
          'The default (ollama:bge-m3) needs Ollama running with the model pulled ' +
          '(`ollama pull bge-m3`). Alternatively set openai_api_key for the hosted ' +
          'fallback, or pick a provider via embedding_model. Run `gbrain doctor` to verify.',
        fix: { command_argv: ['gbrain', 'doctor'] },
        collector: 'setup-smells',
        ask_user: true,
      });
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
