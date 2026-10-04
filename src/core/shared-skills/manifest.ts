import { opError } from '../ops/contract.ts';
import { sha256 } from '../persistence/digest.ts';
import { FAILSAFE_SCHEMA, safeLoad } from 'js-yaml';
import { SHARED_SKILL_LIMITS, type SharedSkillFileInput, type SkillFileClass, type SkillMetadata, type StoredSkillFile } from './model.ts';

export function skillName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) {
    throw opError('invalid_params', `${field} must be a lowercase skill identifier.`,
      `Pass ${field} as 1-128 characters of lowercase letters, digits, '_' or '-', starting with a letter or digit (for example "meeting-notes").`);
  }
  return value;
}
export function skillPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value.normalize('NFC') !== value ||
    !/^[a-zA-Z0-9_\-\u0080-\uFFFF][a-zA-Z0-9_.\-/\u0080-\uFFFF]*$/u.test(value) ||
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    value.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.') || s.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) || value.split('/').length > 16) {
    throw opError('invalid_params', 'A skill file path must be a contained normalized relative path.',
      'Use a relative, NFC-normalized path such as skills/meeting-notes/SKILL.md: at most 16 segments and 512 characters, no empty, dot-leading, dot-ending or reserved device-name segments, and no control or bidirectional characters.');
  }
  return value;
}
export function stringList(value: unknown, label: string, limit = 64): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== 'string' || !v || v.length > 256 || /[\x00-\x1f\x7f]/.test(v))) {
    throw opError('invalid_params', `${label} must be a bounded string array.`,
      `Pass ${label} as an array of at most ${limit} non-empty strings of up to 256 characters with no control characters.`);
  }
  return [...new Set(value as string[])].sort();
}
export function normalizeSkillFiles(name: string, input: unknown): StoredSkillFile[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > SHARED_SKILL_LIMITS.files) {
    throw opError('invalid_params', `A skill requires 1-${SHARED_SKILL_LIMITS.files} declared files.`,
      `Pass files as an array of 1-${SHARED_SKILL_LIMITS.files} objects ({path, content, file_class}); it must include skills/${name}/SKILL.md.`);
  }
  const seen = new Set<string>();
  let bytes = 0;
  const files = input.map((raw: SharedSkillFileInput) => {
    if (!raw || typeof raw !== 'object') {
      throw opError('invalid_params', 'Invalid skill file.',
        `Each files entry must be an object such as {"path": "skills/${name}/SKILL.md", "content": "...", "file_class": "prose"}.`);
    }
    const path = skillPath(raw.path);
    if (!(path.startsWith(`skills/${name}/`) || path.startsWith('skills/conventions/')) ||
      /(?:^|\/)(?:credentials?|secrets?|\.env)(?:[./]|$)/i.test(path)) {
      throw opError('invalid_params', 'Files must belong to this skill or its declared shared conventions.',
        `Place every file under skills/${name}/ or skills/conventions/, and never publish credential, secret or .env files.`);
    }
    const folded = path.toLocaleLowerCase('en-US');
    if (seen.has(folded)) {
      throw opError('invalid_params', 'Duplicate or case-colliding skill paths.',
        `List ${path} once; paths that differ only by letter case collide on case-insensitive checkouts, so rename one of them.`);
    }
    seen.add(folded);
    const main = path === `skills/${name}/SKILL.md`;
    const classes: SkillFileClass[] = ['prose', 'reference', 'asset', 'script'];
    if (!classes.includes(raw.file_class) || main !== (raw.file_class === 'prose')) {
      throw opError('invalid_params', 'Only the entry SKILL.md may be classified as prose.',
        `Set file_class "prose" on skills/${name}/SKILL.md only, and "reference", "asset" or "script" on every other file.`);
    }
    if (typeof raw.content !== 'string' || raw.content.length > SHARED_SKILL_LIMITS.fileBytes * 2 ||
      raw.encoding !== undefined && !['utf8', 'base64'].includes(raw.encoding)) {
      throw opError('invalid_params', 'Invalid file content encoding.',
        `Pass ${path}'s content as a string with encoding "utf8" (the default) or "base64", at most ${SHARED_SKILL_LIMITS.fileBytes} bytes once decoded.`);
    }
    const data = Buffer.from(raw.content, raw.encoding === 'base64' ? 'base64' : 'utf8');
    if (raw.encoding === 'base64' && data.toString('base64') !== raw.content) {
      throw opError('invalid_params', 'Invalid canonical base64 file content.',
        `Encode ${path}'s bytes as standard padded base64 with no whitespace or line breaks, or send text with encoding "utf8".`);
    }
    if (data.length > (main ? SHARED_SKILL_LIMITS.skillMdBytes : SHARED_SKILL_LIMITS.fileBytes) || (bytes += data.length) > SHARED_SKILL_LIMITS.bundleBytes) {
      throw opError('invalid_params', 'Skill publication exceeds the file or bundle byte limit.',
        `Keep SKILL.md under ${SHARED_SKILL_LIMITS.skillMdBytes} bytes, every other file under ${SHARED_SKILL_LIMITS.fileBytes} bytes and the whole bundle under ${SHARED_SKILL_LIMITS.bundleBytes} bytes; ${path} crossed a limit.`);
    }
    if (main && (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data))) {
      throw opError('invalid_params', 'SKILL.md must be UTF-8 prose.',
        `Send skills/${name}/SKILL.md as valid UTF-8 text with no NUL bytes; move binary content into a separate asset file.`);
    }
    const audience = stringList(raw.audience ?? ['readers'], 'audience');
    if (!audience.length) {
      throw opError('invalid_params', 'Each file needs an approved audience.',
        `Give ${path} at least one audience the source's publication policy approves, or omit audience to use ["readers"].`);
    }
    const media_type = raw.media_type ?? (main ? 'text/markdown' : 'application/octet-stream');
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(media_type)) {
      throw opError('invalid_params', 'Invalid file media type.',
        `Set ${path}'s media_type to a plain type/subtype such as text/markdown or application/json (no parameters), or omit it.`);
    }
    return { path, file_class: raw.file_class, audience, media_type, size: data.length,
      sha256: sha256(data), depends_on: stringList(raw.depends_on, 'depends_on').map(skillPath), content: data.toString('base64') };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const root = `skills/${name}/SKILL.md`;
  const byPath = new Map(files.map(f => [f.path, f]));
  if (!byPath.has(root)) {
    throw opError('invalid_params', 'The complete bundle must include its SKILL.md.',
      `Add ${root} (file_class "prose") to files; every publication sends the complete bundle.`);
  }
  const visited = new Set<string>();
  const heights = new Map<string, number>();
  const walk = (path: string, ancestors: Set<string>): number => {
    if (ancestors.has(path) || ancestors.size > SHARED_SKILL_LIMITS.closureDepth) {
      throw opError('invalid_params', 'Dependency cycle or depth limit.',
        `Remove the depends_on cycle through ${path}, or flatten the chain to at most ${SHARED_SKILL_LIMITS.closureDepth} levels below ${root}.`);
    }
    const height = heights.get(path);
    if (height !== undefined) {
      if (ancestors.size + height > SHARED_SKILL_LIMITS.closureDepth) {
        throw opError('invalid_params', 'Dependency depth limit.',
          `Flatten depends_on so no chain below ${root} is deeper than ${SHARED_SKILL_LIMITS.closureDepth} levels.`);
      }
      return height;
    }
    const file = byPath.get(path);
    if (!file) {
      throw opError('invalid_params', 'A dependency is absent from the complete file set.',
        `Include ${path} in files (the complete bundle), or remove it from depends_on.`);
    }
    visited.add(path);
    const maximum = file.depends_on.reduce((maximum, dep) => Math.max(maximum, 1 + walk(dep, new Set([...ancestors, path]))), 0);
    heights.set(path, maximum);
    return maximum;
  };
  walk(root, new Set());
  if (visited.size !== files.length) {
    throw opError('invalid_params', 'Every file must belong to the entry-point dependency closure.',
      `List ${files.filter(f => !visited.has(f.path)).map(f => f.path).join(', ')} in the depends_on of ${root} (or of a file it depends on), or drop them from files.`);
  }
  return files;
}
export function skillMetadata(name: string, files: StoredSkillFile[], params: Record<string, unknown>): SkillMetadata {
  const body = Buffer.from(files.find(f => f.path === `skills/${name}/SKILL.md`)!.content, 'base64').toString('utf8');
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let fm: Record<string, unknown> = {};
  if (/^---[ \t]*\n/.test(normalized)) {
    const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (!match) {
      throw opError('approval_required', 'Malformed skill frontmatter requires owner review before publication.',
        `Close skills/${name}/SKILL.md's frontmatter with a --- line after the YAML block (or remove the opening ---), then resubmit.`);
    }
    try {
      const parsed: unknown = safeLoad(match[1], { schema: FAILSAFE_SCHEMA });
      if (parsed !== undefined && parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('not a mapping');
      fm = parsed as Record<string, unknown> ?? {};
    } catch {
      throw opError('approval_required', 'Malformed or duplicate YAML keys require owner review before publication.',
        `Make skills/${name}/SKILL.md's frontmatter one valid YAML mapping with each key once, then resubmit.`);
    }
    if (Object.hasOwn(fm, '<<')) {
      throw opError('approval_required', 'Merged skill frontmatter requires explicit owner review.',
        `Replace the YAML merge key (<<) in skills/${name}/SKILL.md's frontmatter with the keys written out, then resubmit.`);
    }
  }
  if (fm.name !== undefined && fm.name !== name) {
    throw opError('invalid_params', 'Frontmatter name must match the skill key.',
      `Set name: ${name} in skills/${name}/SKILL.md's frontmatter (or remove the name key), then resubmit.`);
  }
  const description = params.description ?? (typeof fm.description === 'string' ? fm.description.replace(/\s+/g, ' ').trim() : fm.description) ?? '';
  if (typeof description !== 'string' || description.length > 2048 || /[\x00-\x1f\x7f]/.test(description)) {
    throw opError('invalid_params', 'Invalid skill description.',
      'Pass description (or the frontmatter description) as one line of text, at most 2048 characters, with no control characters.');
  }
  if (params.private !== undefined && typeof params.private !== 'boolean') {
    throw opError('invalid_params', 'private must be boolean.', 'Pass private as true or false, or omit it.');
  }
  const markers = new Map<string, boolean>();
  for (const [key, value] of Object.entries(fm)) {
    const canonical = key.trim().toLowerCase().replace(/-/g, '_');
    if (!['private', 'publish', 'mcp_publish', 'writes_pages', 'mutating'].includes(canonical)) continue;
    if (markers.has(canonical) || typeof value !== 'string' || !['true', 'false', 'yes', 'no'].includes(value.toLowerCase())) {
      throw opError('approval_required', 'A publication/privacy marker has ambiguous or unknown intent and requires owner review.',
        `Set ${key} once in skills/${name}/SKILL.md's frontmatter, to true, false, yes or no, then resubmit; ask the user which they intend if unsure.`);
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
