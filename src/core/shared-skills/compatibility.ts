import { OperationError, type OperationContext } from '../ops/contract.ts';
import { SKILL_CATALOG_INSTRUCTIONS, SKILL_CLIENT_GUIDANCE } from '../operations-descriptions.ts';
import { parseSkillFrontmatter } from '../skill-frontmatter.ts';
import { getSharedSkill, listSharedSkills } from './catalog.ts';
import type { SharedSkillSummary } from './model.ts';
import type { GetSkillResult, ListSkillsResult } from '../skill-catalog.ts';
import type { ResidentPackResult, ResidentSkillDetail } from '../skillpack/brain-resident-locate.ts';

export async function sharedCatalogActive(ctx: OperationContext): Promise<boolean> {
  const [brain] = await ctx.engine.executeRaw<{ skill_bundles_enabled: boolean }>('SELECT skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
  return brain?.skill_bundles_enabled === true;
}
async function allSkills(ctx: OperationContext): Promise<SharedSkillSummary[]> {
  const skills: SharedSkillSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await listSharedSkills(ctx, { limit: 100, cursor });
    skills.push(...page.skills); cursor = page.next_cursor;
  } while (cursor);
  return skills;
}
export async function listLegacySharedSkills(ctx: OperationContext, section?: string): Promise<ListSkillsResult> {
  const { sharedSkillToolAccess } = await import('./tool-access.ts');
  const access = await sharedSkillToolAccess(ctx);
  const skills = (await allSkills(ctx)).filter(() => !section || section === 'Published skills').map(skill => {
    const tools = skill.requirements.filter(r => r.startsWith('tool:')).map(r => r.slice(5));
    return { name: skill.name, description: skill.description, section: 'Published skills', triggers: skill.triggers, tools,
      usable_tools: tools.filter(t => access.includes(t)), unavailable_tools: tools.filter(t => !access.includes(t)), writes_pages: skill.writes_pages, mutating: skill.mutating };
  });
  return { schema_version: 1, skills_dir_source: 'config', count: skills.length, skills,
    instructions: { summary: SKILL_CATALOG_INSTRUCTIONS.summary, how_to_use: [...SKILL_CATALOG_INSTRUCTIONS.how_to_use], available_brain_tools: access, fetch_op: 'get_skill' } };
}
export async function getLegacySharedSkill(ctx: OperationContext, name: unknown, sourceId?: string): Promise<GetSkillResult | ResidentSkillDetail> {
  if (typeof name !== 'string' || !name) throw new OperationError('invalid_params', 'A legacy skill request requires name.');
  const skill = await getSharedSkill(ctx, { name, source_id: sourceId });
  if (sourceId) return { source_id: skill.source_id, pack_name: skill.pack_id, slug: skill.name, description: skill.description, body: skill.body };
  const fm = parseSkillFrontmatter(skill.body);
  const tools = skill.requirements.filter(r => r.startsWith('tool:')).map(r => r.slice(5));
  const { sharedSkillToolAccess } = await import('./tool-access.ts');
  const access = await sharedSkillToolAccess(ctx);
  return { schema_version: 1, name: skill.name, frontmatter: { name: skill.name, description: skill.description, triggers: skill.triggers,
    tools, writes_pages: fm?.writes_pages ?? false, mutating: fm?.mutating ?? false }, body: skill.body,
    usable_tools: tools.filter(t => access.includes(t)), unavailable_tools: tools.filter(t => !access.includes(t)),
    client_guidance: { nature: SKILL_CLIENT_GUIDANCE.nature, protocol: [...SKILL_CLIENT_GUIDANCE.protocol], available_brain_tools: access, mutating: fm?.mutating ?? false } };
}
export async function listLegacySharedPacks(ctx: OperationContext): Promise<ResidentPackResult> {
  const skills = await allSkills(ctx);
  const packs: ResidentPackResult['packs'] = [];
  for (const skill of skills) {
    let pack = packs.find(p => p.source_id === skill.source_id && p.name === skill.pack_id);
    if (!pack) {
      const [stored] = await ctx.engine.executeRaw<{ manifest: Record<string, unknown> }>(`SELECT manifest FROM shared_skill_packs
        WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3`, [skill.source_id, skill.source_incarnation, skill.pack_id]);
      if (!stored) throw new OperationError('catalog_unavailable', 'A canonical pack changed during enumeration.');
      pack = { source_id: skill.source_id, name: skill.pack_id, version: typeof stored.manifest.version === 'string' ? stored.manifest.version : '0.0.0',
        schema_pack: typeof stored.manifest.schema_pack === 'string' ? stored.manifest.schema_pack : null,
        active_schema_pack: null, schema_pack_match: null, skills: [], scaffold_spec: null, installed: false };
      packs.push(pack);
    }
    pack.skills.push({ slug: skill.name, description: skill.description });
  }
  return { packs };
}
