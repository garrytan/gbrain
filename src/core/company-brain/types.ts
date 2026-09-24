import type { ResolvedPack } from '../schema-pack/registry.ts';

export const COMPANY_BRAIN_PROFILE = 'company-brain' as const;
export const COMPANY_BRAIN_PLAN_VERSION = 1 as const;
export const COMPANY_BRAIN_MAX_ENTRIES = 100_000;
export const COMPANY_BRAIN_MAX_METADATA_BYTES = 16 * 1024 ** 2;
export const COMPANY_BRAIN_MAX_FILE_BYTES = 5_000_000;

export interface InspectionLimits {
  maxEntries?: number;
  maxMetadataBytes?: number;
  maxFileBytes?: number;
}

export interface InspectionFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface RevisionIdentity {
  root: string;
  git_root: string;
  git_dir: string;
  scope: string;
  root_device: string;
  root_inode: string;
  git_device: string;
  git_inode: string;
  commit: string;
  tree: string;
  object_format: 'sha1' | 'sha256';
}

export interface CommittedEntry {
  path: string;
  mode: string;
  object_id: string;
  object_type: 'blob' | 'commit';
  bytes: number | null;
}

export interface InspectionReference {
  kind: 'markdown' | 'frontmatter';
  target: string;
  field?: string;
  link_type?: string;
  source_id?: string;
  resolution: 'resolved' | 'unresolved' | 'ambiguous' | 'cross_source';
  resolved_slug?: string;
}

export interface InspectionPage {
  slug: string;
  type: string;
  type_explicit: boolean;
  title: string;
  aliases: string[];
  audience: string[];
  verified: string | null;
  content_sha256: string;
  references: InspectionReference[];
}

export interface InspectionEntry extends CommittedEntry {
  disposition: 'included' | 'excluded' | 'unsupported';
  reason: string;
  page?: InspectionPage;
}

export interface UncommittedEntry {
  path: string;
  kind: 'staged' | 'modified' | 'deleted' | 'untracked' | 'unsafe';
  eligible: boolean;
}

export interface CompanyBrainPlan {
  schema_version: typeof COMPANY_BRAIN_PLAN_VERSION;
  profile: typeof COMPANY_BRAIN_PROFILE;
  profile_selection: 'explicit' | 'detected' | 'ambiguous';
  revision: RevisionIdentity | null;
  schema: { name: string; version: string; identity: string; resolved_digest: string } | null;
  extractor_version: string;
  selection: { include: string[]; exclude: string[]; defaults_version: 1 };
  limits: Required<InspectionLimits>;
  manifest: InspectionEntry[];
  uncommitted: UncommittedEntry[];
  audience_requirements: string[];
  counts: { tracked: number; included: number; excluded: number; unsupported: number; dirty_eligible: number; untracked: number };
  findings: InspectionFinding[];
  ready: boolean;
  plan_digest: string;
}

export interface InspectCompanyBrainOptions {
  path: string;
  profile?: typeof COMPANY_BRAIN_PROFILE;
  include?: string[];
  exclude?: string[];
  pack?: ResolvedPack;
  revision?: string;
  limits?: InspectionLimits;
}

export interface PlanValidationResult {
  valid: boolean;
  code: 'ok' | 'plan_stale' | 'source_not_ready';
  findings: InspectionFinding[];
  plan?: CompanyBrainPlan;
}
