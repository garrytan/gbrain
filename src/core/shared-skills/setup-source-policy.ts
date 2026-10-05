import type { BrainEngine } from '../engine.ts';
import { getCompanyBrainProfile } from '../company-brain/profile.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { OperationError } from '../ops/contract.ts';

export const SHARED_SKILLS_OPT_OUT_DOCS = 'docs/guides/shared-brain-skills.md#choose-which-sources-adopt-shared-skills';

export type SharedSkillSourcePolicy =
  | { mode: 'content'; reason?: never }
  | { mode: 'explicit_pack_required' | 'preserve_files'; reason: string };

export async function sharedSkillSourcePolicy(engine: BrainEngine, sourceId: string): Promise<SharedSkillSourcePolicy> {
  const company = await getCompanyBrainProfile(engine, sourceId);
  if (company?.noWriteback) return { mode: 'preserve_files',
    reason: 'source_writeback_required: the approved company-brain ingestion contract is file-preserving (noWriteback:true). Shared-skill setup cannot modify this repository, even if it contains a pack. Use a separately authorized content source; ingestion approval, files and grants remain unchanged.' };
  const [source] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) {
    throw new OperationError('source_changed', 'The selected content source is missing or archived.',
      `Source ${sourceId} is archived or not registered; choose an active content source (gbrain sources list --json shows them).`);
  }
  const config = parseSourceConfig(source.config);
  // A source can decline adoption implicitly by being connector-managed or an
  // unapproved external repo (below), or explicitly with
  // `gbrain sources shared-skills <id> off` when it already delivers skills
  // another way (its own brain-resident skillpack over MCP, a plugin install).
  if (config.shared_skills === false) return { mode: 'preserve_files',
    reason: `source_shared_skills_disabled: this source opted out of shared-skills catalog adoption (config.shared_skills=false). Its existing skill-delivery path (e.g. list_brain_skillpack/get_skill, or an external plugin install) is unaffected; no files or grants were touched. Turn adoption back on with gbrain sources shared-skills ${sourceId} on (${SHARED_SKILLS_OPT_OUT_DOCS}).` };
  if (config.kind != null) return { mode: 'preserve_files',
    reason: `source_skill_adoption_required: this connector-managed source is not a shared-skill write target. Preserve its generated/imported files and put approved shared skills in a separate content source. gbrain sources shared-skills ${sourceId} status explains it (${SHARED_SKILLS_OPT_OUT_DOCS}).` };
  if (config.remote_url != null || config.managed_clone === true) return { mode: 'explicit_pack_required',
    reason: `source_skill_adoption_required: this external repository has no explicit brain-resident skillpack approval. No packaged skills were added. Review an existing brain_resident:true manifest or use a separate owned content source. gbrain sources shared-skills ${sourceId} status explains it (${SHARED_SKILLS_OPT_OUT_DOCS}).` };
  return { mode: 'content' };
}

/** The policy as the migration applies it: a policy that cannot be verified preserves files. */
export async function sharedSkillSourcePolicyOrPreserve(engine: BrainEngine, sourceId: string): Promise<SharedSkillSourcePolicy> {
  return sharedSkillSourcePolicy(engine, sourceId).catch(error => ({ mode: 'preserve_files' as const,
    reason: error instanceof OperationError ? `${error.code}: ${error.message}` : 'profile_incompatible: the source writeback policy could not be verified; no repository changes were attempted.' }));
}

export async function assertPackagedSkillSource(engine: BrainEngine, sourceId: string): Promise<void> {
  const policy = await sharedSkillSourcePolicy(engine, sourceId);
  if (policy.mode !== 'content') {
    throw new OperationError('source_writeback_required', policy.reason,
      `Source ${sourceId} is not a shared-skill write target, so nothing was added to it. Install packaged skills into a separate content source the user owns (gbrain init --content-root with a new directory creates one).`);
  }
}
