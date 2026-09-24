import type { BrainEngine } from '../engine.ts';
import { getCompanyBrainProfile } from '../company-brain/profile.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { OperationError } from '../ops/contract.ts';

export type SharedSkillSourcePolicy =
  | { mode: 'content'; reason?: never }
  | { mode: 'explicit_pack_required' | 'preserve_files'; reason: string };

export async function sharedSkillSourcePolicy(engine: BrainEngine, sourceId: string): Promise<SharedSkillSourcePolicy> {
  const company = await getCompanyBrainProfile(engine, sourceId);
  if (company?.noWriteback) return { mode: 'preserve_files',
    reason: 'source_writeback_required: the approved company-brain ingestion contract is file-preserving (noWriteback:true). Shared-skill setup cannot modify this repository, even if it contains a pack. Use a separately authorized content source; ingestion approval, files and grants remain unchanged.' };
  const [source] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) throw new OperationError('source_changed', 'The selected content source is missing or archived.');
  const config = parseSourceConfig(source.config);
  if (config.kind != null) return { mode: 'preserve_files',
    reason: 'source_skill_adoption_required: this connector-managed source is not a shared-skill write target. Preserve its generated/imported files and put approved shared skills in a separate content source.' };
  if (config.remote_url != null || config.managed_clone === true) return { mode: 'explicit_pack_required',
    reason: 'source_skill_adoption_required: this external repository has no explicit brain-resident skillpack approval. No packaged skills were added. Review an existing brain_resident:true manifest or use a separate owned content source.' };
  return { mode: 'content' };
}

export async function assertPackagedSkillSource(engine: BrainEngine, sourceId: string): Promise<void> {
  const policy = await sharedSkillSourcePolicy(engine, sourceId);
  if (policy.mode !== 'content') throw new OperationError('source_writeback_required', policy.reason);
}
