export type SkillFileClass = 'prose' | 'reference' | 'asset' | 'script';
export interface SharedSkillKey {
  brain_id: string;
  source_id: string;
  source_incarnation: string;
  pack_id: string;
  name: string;
}
export interface SharedSkillFile {
  path: string;
  file_class: SkillFileClass;
  audience: string[];
  media_type: string;
  size: number;
  sha256: string;
  depends_on: string[];
}
export interface StoredSkillFile extends SharedSkillFile { content: string; }
export interface SharedSkillFileInput {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  file_class: SkillFileClass;
  audience?: string[];
  media_type?: string;
  depends_on?: string[];
}
export interface SharedSkillPolicy {
  version: 1;
  enabled: boolean;
  classes: SkillFileClass[];
  audiences: string[];
  requirements: string[];
  allow_follow: boolean;
}
export interface SharedSkillPutInput {
  request_id?: string;
  expected_revision: string | null;
  source_id?: string;
  source_incarnation?: string;
  pack_id: string;
  name: string;
  description?: string;
  triggers?: string[];
  requirements?: string[];
  files: SharedSkillFileInput[];
  private?: boolean;
}
export interface SkillMetadata {
  description: string;
  triggers: string[];
  requirements: string[];
  private: boolean;
  audience: string[];
  writes_pages: boolean;
  mutating: boolean;
  file_policy: Array<Pick<SharedSkillFile, 'file_class' | 'audience'>>;
  /** #5150: false when the SKILL.md declared no `tools`, so readers inherit the caller's brain tools; absent on revisions published before it was recorded. */
  tools_declared?: boolean;
}
export interface SharedSkillSummary extends SharedSkillKey, Omit<SkillMetadata, 'file_policy' | 'tools_declared'> {
  qualified_id: string;
  revision: string;
  policy_epoch: string;
  allow_follow: boolean;
  delivery: 'prose_only' | 'complete';
  usable_tools: string[];
  unavailable_tools: string[];
  unavailable_requirements: string[];
  usable: boolean;
}
export interface SharedSkillList {
  schema_version: 2;
  brain_id: string;
  view_token: string;
  skills: SharedSkillSummary[];
  next_cursor?: string;
}
export interface SharedSkillDetail extends SharedSkillSummary {
  schema_version: 2;
  body: string;
  files: SharedSkillFile[];
}
export interface SharedSkillSelector {
  name?: string;
  qualified_id?: string;
  brain_id?: string;
  source_id?: string;
  source_incarnation?: string;
  pack_id?: string;
  revision?: string;
}
export interface StoredSkillRevision {
  source_id: string;
  source_incarnation: string;
  pack_id: string;
  name: string;
  revision: string;
  metadata: SkillMetadata;
  files: StoredSkillFile[];
  deleted: boolean;
  policy_epoch: string;
}
/**
 * `files` bounds one skill's declared files. `packFiles` bounds one canonical
 * publication (adoption writes one SKILL.md per declared skill plus
 * skillpack.json); it equals the persistence bundle bound
 * (`BUNDLE_FILE_LIMITS.files`) that the journal enforces on every bundle (#5476).
 */
export const SHARED_SKILL_LIMITS = Object.freeze({ files: 64, packFiles: 128, fileBytes: 1024 * 1024,
  skillMdBytes: 256 * 1024, bundleBytes: 4 * 1024 * 1024, closureDepth: 12,
  pageSize: 100, catalogSkills: 10_000 });
