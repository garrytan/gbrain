export interface SharedSkillIdentity {
  brain_id: string;
  source_id: string;
  source_incarnation: string;
  pack_id: string;
  name: string;
  revision: string;
}

export interface FollowPolicy {
  approved: true;
  source_ids?: string[];
}

export interface SkillDeliveryEntry extends SharedSkillIdentity {
  description?: string;
  triggers?: string[];
  requirements?: unknown;
  [key: string]: unknown;
}

export interface DeliveryEvidence {
  stage: 'fetched' | 'installed';
  revisions: SharedSkillIdentity[];
  native?: { source: 'self_report'; adapter_version: string; host_version: string; session_id: string; revision: string };
}

export interface MembershipSnapshot {
  schema_version: 2;
  status: 'catalog_visible' | 'requirements_changed';
  complete: true;
  brain_id: string;
  installation_id: string;
  enrollment_epoch: number;
  view_token: string;
  batch_token: string;
  sequence: number;
  skills: SkillDeliveryEntry[];
  blocked_skills: SkillDeliveryEntry[];
  acknowledgment?: 'recorded' | 'historical' | 'replayed';
  delivery: { transport: 'verified'; installation: 'unverified' | 'self_reported'; native: 'unverified'; freshness: 'advisory_refresh' };
}

export function sharedSkillKey(skill: Omit<SharedSkillIdentity, 'revision'>): string {
  return [skill.brain_id, skill.source_id, skill.source_incarnation, skill.pack_id, skill.name].map(encodeURIComponent).join('/');
}
export const SHARED_SKILLS_DELIVERY_LIMITS = Object.freeze({
  skills: 1000,
  metadataBytes: 4 * 1024 * 1024,
  acknowledgmentBytes: 4 * 1024 * 1024,
  retainedBatches: 32,
});
