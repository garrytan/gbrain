// hosts/projects joined people/companies after the 2026-08-06 memory eval: a
// bare infra token ("hive") fell through to slugify and recall returned
// nothing while the canonical hosts/<token> page + its facts sat one prefix
// away. `infra/` is deliberately NOT here — it is a mixed namespace of
// analysis/runbook documents (`infra/hive-dependency-audit-…`), and any such
// doc would trip the ambiguity gate and re-break bare-token resolution.
export const PREFIX_EXPANSION_DIRS = ['people', 'companies', 'hosts', 'projects'] as const;
/** Directories a bare entity name resolves under (findExactBasenameCandidates); factEntitySlugs reads the same set. */
export const BASENAME_DIRS = [...PREFIX_EXPANSION_DIRS, 'concepts'] as const;
/** GBRA-574: directories whose page at <dir>/<key> covers a bare name key's facts for privacy: the basename directories plus the identity directories (resolve.ts IDENTITY_DIRS) a page adopting the key can sit in. */
export const NAME_KEY_PAGE_DIRS = [...BASENAME_DIRS, 'funds', 'orgs', 'organizations'] as const;
