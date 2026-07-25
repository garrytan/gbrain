/**
 * Read-only MCP skill catalog. Remote publication is explicit opt-in and every
 * returned file is confined to the resolved skills directory.
 */
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'fs';
import { basename, join, relative, resolve } from 'path';
import {
  autoDetectSkillsDir,
  autoDetectSkillsDirReadOnly,
  type SkillsDirSource,
} from './repo-root.ts';
import { loadOrDeriveManifest, type ManifestEntry } from './skill-manifest.ts';
import { parseSkillFrontmatter } from './skill-frontmatter.ts';
import {
  OperationError,
  type OperationContext,
} from './operations.ts';

const MAX_SKILL_MD_BYTES = 256 * 1024;
type CatalogSource = SkillsDirSource | 'config';

export async function readMcpPublishSkills(ctx: OperationContext): Promise<boolean> {
  const fromDb = await ctx.engine.getConfig('mcp.publish_skills').catch(() => null);
  if (fromDb !== null) return fromDb === 'true';
  return ctx.config?.mcp?.publish_skills === true;
}

export async function readMcpSkillsDir(ctx: OperationContext): Promise<string | undefined> {
  const fromDb = await ctx.engine.getConfig('mcp.skills_dir').catch(() => null);
  if (fromDb?.trim()) return fromDb.trim();
  return ctx.config?.mcp?.skills_dir?.trim() || undefined;
}

export function assertPublishEnabled(ctx: OperationContext, enabled: boolean): void {
  if (ctx.remote === true && !enabled) {
    throw new OperationError(
      'permission_denied',
      'Remote skill publication is disabled.',
      'Enable it explicitly with `pmbrain config set mcp.publish_skills true`.',
    );
  }
}

export function resolveSkillsDir(
  ctx: OperationContext,
  override?: string,
): { dir: string; source: CatalogSource } {
  if (override) {
    if (!existsSync(override)) {
      throw new OperationError('storage_error', `Configured skills directory does not exist: ${override}`);
    }
    return { dir: realpathSync(override), source: 'config' };
  }
  const detected = ctx.remote === true
    ? autoDetectSkillsDir()
    : autoDetectSkillsDirReadOnly();
  if (!detected.dir || !detected.source) {
    throw new OperationError(
      'storage_error',
      'No skills directory was found.',
      'Set `mcp.skills_dir` to the workspace skills directory.',
    );
  }
  return { dir: realpathSync(detected.dir), source: detected.source };
}

function confinedSkillPath(skillsDir: string, entry: ManifestEntry): string {
  const root = realpathSync(skillsDir);
  let candidate: string;
  try {
    candidate = realpathSync(join(root, entry.path));
  } catch {
    throw new OperationError('page_not_found', `Skill file not found: ${entry.name}`);
  }
  const rel = relative(root, candidate);
  if (
    rel.startsWith('..') ||
    resolve(root, rel) !== candidate ||
    basename(candidate) !== 'SKILL.md' ||
    !statSync(candidate).isFile()
  ) {
    throw new OperationError('permission_denied', `Skill path escapes the published directory: ${entry.name}`);
  }
  return candidate;
}

function readSkill(skillsDir: string, entry: ManifestEntry): string {
  const path = confinedSkillPath(skillsDir, entry);
  const size = statSync(path).size;
  if (size > MAX_SKILL_MD_BYTES) {
    throw new OperationError(
      'invalid_params',
      `Skill file exceeds ${MAX_SKILL_MD_BYTES} bytes: ${entry.name}`,
    );
  }
  return readFileSync(path, 'utf8');
}

function findEntry(skillsDir: string, name: string): ManifestEntry {
  if (!name || name.length > 128 || /[/\\]|\.\.|\0/.test(name)) {
    throw new OperationError('invalid_params', 'Skill name must be a plain catalog name.');
  }
  const entry = loadOrDeriveManifest(skillsDir).skills.find(item => item.name === name);
  if (!entry) {
    throw new OperationError('page_not_found', `Skill not found: ${name}`, 'Call list_skills first.');
  }
  return entry;
}

function descriptionFrom(content: string): string {
  const match = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  return match?.[1]?.trim() ?? '';
}

function bodyFrom(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export function buildSkillCatalog(
  skillsDir: string,
  source: CatalogSource,
  section?: string,
): {
  schema_version: 1;
  skills_dir_source: CatalogSource;
  count: number;
  skills: Array<Record<string, unknown>>;
} {
  const skills = loadOrDeriveManifest(skillsDir).skills.flatMap((entry) => {
    try {
      const content = readSkill(skillsDir, entry);
      const frontmatter = parseSkillFrontmatter(content);
      const skillSection = 'skill_frontmatter';
      if (section && section !== skillSection) return [];
      return [{
        name: entry.name,
        description: descriptionFrom(content),
        section: skillSection,
        triggers: frontmatter?.triggers ?? [],
        tools: frontmatter?.tools ?? [],
        writes_pages: frontmatter?.writes_pages ?? false,
        mutating: frontmatter?.mutating ?? false,
      }];
    } catch {
      return [];
    }
  });
  skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return {
    schema_version: 1,
    skills_dir_source: source,
    count: skills.length,
    skills,
  };
}

export function getSkillDetail(skillsDir: string, name: string): Record<string, unknown> {
  const entry = findEntry(skillsDir, name);
  const content = readSkill(skillsDir, entry);
  const frontmatter = parseSkillFrontmatter(content);
  return {
    schema_version: 1,
    name: entry.name,
    frontmatter: {
      name: frontmatter?.name,
      description: descriptionFrom(content),
      triggers: frontmatter?.triggers ?? [],
      tools: frontmatter?.tools ?? [],
      writes_pages: frontmatter?.writes_pages ?? false,
      mutating: frontmatter?.mutating ?? false,
    },
    body: bodyFrom(content),
  };
}
