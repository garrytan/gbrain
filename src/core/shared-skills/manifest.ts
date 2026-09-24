import { OperationError } from '../ops/contract.ts';
import { sha256 } from '../persistence/digest.ts';
import { FAILSAFE_SCHEMA, safeLoad } from 'js-yaml';
import { SHARED_SKILL_LIMITS, type SharedSkillFileInput, type SkillFileClass, type SkillMetadata, type StoredSkillFile } from './model.ts';

export function skillName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) {
    throw new OperationError('invalid_params', `${field} must be a lowercase skill identifier.`);
  }
  return value;
}
export function skillPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value.normalize('NFC') !== value ||
    !/^[a-zA-Z0-9_\-\u0080-\uFFFF][a-zA-Z0-9_.\-/\u0080-\uFFFF]*$/u.test(value) ||
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    value.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.') || s.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) || value.split('/').length > 16) {
    throw new OperationError('invalid_params', 'A skill file path must be a contained normalized relative path.');
  }
  return value;
}
export function stringList(value: unknown, label: string, limit = 64): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== 'string' || !v || v.length > 256 || /[\x00-\x1f\x7f]/.test(v))) {
    throw new OperationError('invalid_params', `${label} must be a bounded string array.`);
  }
  return [...new Set(value as string[])].sort();
}
export function normalizeSkillFiles(name: string, input: unknown): StoredSkillFile[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > SHARED_SKILL_LIMITS.files) {
    throw new OperationError('invalid_params', `A skill requires 1-${SHARED_SKILL_LIMITS.files} declared files.`);
  }
  const seen = new Set<string>();
  let bytes = 0;
  const files = input.map((raw: SharedSkillFileInput) => {
    if (!raw || typeof raw !== 'object') throw new OperationError('invalid_params', 'Invalid skill file.');
    const path = skillPath(raw.path);
    if (!(path.startsWith(`skills/${name}/`) || path.startsWith('skills/conventions/')) ||
      /(?:^|\/)(?:credentials?|secrets?|\.env)(?:[./]|$)/i.test(path)) {
      throw new OperationError('invalid_params', 'Files must belong to this skill or its declared shared conventions.');
    }
    const folded = path.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new OperationError('invalid_params', 'Duplicate or case-colliding skill paths.');
    seen.add(folded);
    const main = path === `skills/${name}/SKILL.md`;
    const classes: SkillFileClass[] = ['prose', 'reference', 'asset', 'script'];
    if (!classes.includes(raw.file_class) || main !== (raw.file_class === 'prose')) {
      throw new OperationError('invalid_params', 'Only the entry SKILL.md may be classified as prose.');
    }
    if (typeof raw.content !== 'string' || raw.content.length > SHARED_SKILL_LIMITS.fileBytes * 2 ||
      raw.encoding !== undefined && !['utf8', 'base64'].includes(raw.encoding)) throw new OperationError('invalid_params', 'Invalid file content encoding.');
    const data = Buffer.from(raw.content, raw.encoding === 'base64' ? 'base64' : 'utf8');
    if (raw.encoding === 'base64' && data.toString('base64') !== raw.content) throw new OperationError('invalid_params', 'Invalid canonical base64 file content.');
    if (data.length > (main ? SHARED_SKILL_LIMITS.skillMdBytes : SHARED_SKILL_LIMITS.fileBytes) || (bytes += data.length) > SHARED_SKILL_LIMITS.bundleBytes) {
      throw new OperationError('invalid_params', 'Skill publication exceeds the file or bundle byte limit.');
    }
    if (main && (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data))) throw new OperationError('invalid_params', 'SKILL.md must be UTF-8 prose.');
    const audience = stringList(raw.audience ?? ['readers'], 'audience');
    if (!audience.length) throw new OperationError('invalid_params', 'Each file needs an approved audience.');
    const media_type = raw.media_type ?? (main ? 'text/markdown' : 'application/octet-stream');
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(media_type)) throw new OperationError('invalid_params', 'Invalid file media type.');
    return { path, file_class: raw.file_class, audience, media_type, size: data.length,
      sha256: sha256(data), depends_on: stringList(raw.depends_on, 'depends_on').map(skillPath), content: data.toString('base64') };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const root = `skills/${name}/SKILL.md`;
  const byPath = new Map(files.map(f => [f.path, f]));
  if (!byPath.has(root)) throw new OperationError('invalid_params', 'The complete bundle must include its SKILL.md.');
  const visited = new Set<string>();
  const heights = new Map<string, number>();
  const walk = (path: string, ancestors: Set<string>): number => {
    if (ancestors.has(path) || ancestors.size > SHARED_SKILL_LIMITS.closureDepth) throw new OperationError('invalid_params', 'Dependency cycle or depth limit.');
    const height = heights.get(path);
    if (height !== undefined) {
      if (ancestors.size + height > SHARED_SKILL_LIMITS.closureDepth) throw new OperationError('invalid_params', 'Dependency depth limit.');
      return height;
    }
    const file = byPath.get(path);
    if (!file) throw new OperationError('invalid_params', 'A dependency is absent from the complete file set.');
    visited.add(path);
    const maximum = file.depends_on.reduce((maximum, dep) => Math.max(maximum, 1 + walk(dep, new Set([...ancestors, path]))), 0);
    heights.set(path, maximum);
    return maximum;
  };
  walk(root, new Set());
  if (visited.size !== files.length) throw new OperationError('invalid_params', 'Every file must belong to the entry-point dependency closure.');
  return files;
}
export function skillMetadata(name: string, files: StoredSkillFile[], params: Record<string, unknown>): SkillMetadata {
  const body = Buffer.from(files.find(f => f.path === `skills/${name}/SKILL.md`)!.content, 'base64').toString('utf8');
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let fm: Record<string, unknown> = {};
  if (/^---[ \t]*\n/.test(normalized)) {
    const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (!match) throw new OperationError('approval_required', 'Malformed skill frontmatter requires owner review before publication.');
    try {
      const parsed: unknown = safeLoad(match[1], { schema: FAILSAFE_SCHEMA });
      if (parsed !== undefined && parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('not a mapping');
      fm = parsed as Record<string, unknown> ?? {};
    } catch {
      throw new OperationError('approval_required', 'Malformed or duplicate YAML keys require owner review before publication.');
    }
    if (Object.hasOwn(fm, '<<')) throw new OperationError('approval_required', 'Merged skill frontmatter requires explicit owner review.');
  }
  if (fm.name !== undefined && fm.name !== name) throw new OperationError('invalid_params', 'Frontmatter name must match the skill key.');
  const description = params.description ?? (typeof fm.description === 'string' ? fm.description.replace(/\s+/g, ' ').trim() : fm.description) ?? '';
  if (typeof description !== 'string' || description.length > 2048 || /[\x00-\x1f\x7f]/.test(description)) throw new OperationError('invalid_params', 'Invalid skill description.');
  if (params.private !== undefined && typeof params.private !== 'boolean') throw new OperationError('invalid_params', 'private must be boolean.');
  const markers = new Map<string, boolean>();
  for (const [key, value] of Object.entries(fm)) {
    const canonical = key.trim().toLowerCase().replace(/-/g, '_');
    if (!['private', 'publish', 'mcp_publish', 'writes_pages', 'mutating'].includes(canonical)) continue;
    if (markers.has(canonical) || typeof value !== 'string' || !['true', 'false', 'yes', 'no'].includes(value.toLowerCase())) {
      throw new OperationError('approval_required', 'A publication/privacy marker has ambiguous or unknown intent and requires owner review.');
    }
    markers.set(canonical, ['true', 'yes'].includes(value.toLowerCase()));
  }
  return { description, triggers: stringList(params.triggers ?? fm.triggers, 'triggers'),
    requirements: stringList([...stringList(params.requirements, 'requirements'), ...stringList(fm.requires, 'requires'), ...stringList(fm.tools, 'tools').map(t => `tool:${t}`)], 'requirements'),
    private: params.private === true || markers.get('private') === true || markers.get('publish') === false || markers.get('mcp_publish') === false,
    audience: files.find(f => f.path === `skills/${name}/SKILL.md`)!.audience,
    writes_pages: markers.get('writes_pages') ?? false, mutating: markers.get('mutating') ?? false,
    file_policy: files.map(f => ({ file_class: f.file_class, audience: f.audience })) };
}
