/**
 * orchestrator/deps-live.ts — wires the orchestrator to real GBrain subsystems.
 *
 * Kept OUT of run.ts so run.ts stays free of DB/LLM/skill-catalog imports and
 * remains unit-testable with plain stubs. The `orchestrate_input` op handler calls
 * `makeLiveDeps(ctx, …)` to get production dependencies:
 *   - loadCandidateSkills → the real skill catalog (`list_skills` internals), so
 *     the custom-skill gate runs against live, role-tagged skills.
 *   - retrieveHistory     → hybrid retrieval, scoped to the patient's source.
 *   - select              → the LLM ranker (select-llm.ts), given the real `chat`.
 */

import type { OperationContext } from '../operations.ts';
import { chat } from '../ai/gateway.ts';
import { hybridSearchCached } from '../search/hybrid.ts';
import type { OrchestratorDeps } from './run.ts';
import type { CandidateSkill, HistoryItem, OrchestratorContext } from './types.ts';
import { selectSkillsLLM } from './select-llm.ts';

export interface LiveDepsOpts {
  /** Scope history retrieval to this patient's source id. */
  patientId?: string;
  /** Max historical records to pull (default 20). */
  historyLimit?: number;
  /** false → fall back to run.ts's deterministic v0 selector (no model call). */
  useLlm?: boolean;
  /**
   * Force the relational recall arm on/off for history retrieval. Undefined =
   * search-mode smart default. On surfaces graph-connected history ("who/what
   * connects") the lexical/vector arms would miss.
   */
  relational?: boolean;
}

export function makeLiveDeps(ctx: OperationContext, opts: LiveDepsOpts = {}): OrchestratorDeps {
  const historyLimit = opts.historyLimit ?? 20;

  return {
    loadCandidateSkills: async (): Promise<CandidateSkill[]> => {
      // Same discovery + publish gate as the list_skills op.
      const sc = await import('../skill-catalog.ts');
      const publish = await sc.readMcpPublishSkills(ctx);
      sc.assertPublishEnabled(ctx, publish);
      const override = await sc.readMcpSkillsDir(ctx);
      const { dir, source } = sc.resolveSkillsDir(ctx, override);
      const { skills } = sc.buildSkillCatalog(ctx, dir, source);
      return skills.map((s): CandidateSkill => ({
        name: s.name,
        // The catalog carries no path; synthesize a stable, conventional one.
        path: `skills/${s.name}/SKILL.md`,
        description: s.description,
        role: s.role,
        triggers: s.triggers,
      }));
    },

    retrieveHistory: async (octx: OrchestratorContext): Promise<HistoryItem[]> => {
      const results = await hybridSearchCached(ctx.engine, octx.input.text, {
        limit: historyLimit,
        detail: 'medium',
        expansion: false, // keep retrieval DB-only — no expansion LLM call
        ...(opts.patientId ? { sourceId: opts.patientId } : {}),
        ...(typeof opts.relational === 'boolean' ? { relationalRetrieval: opts.relational } : {}),
      });
      return results.map((r) => ({ id: String(r.page_id), snippet: r.chunk_text, score: r.score }));
    },

    // undefined → run.ts uses its deterministic v0 selector.
    select: opts.useLlm === false ? undefined : (octx, cust) => selectSkillsLLM(octx, cust, chat),
  };
}
