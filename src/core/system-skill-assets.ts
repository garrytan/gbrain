import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface SystemSkillAssetResult {
  skillsDir: string;
  created: string[];
  updated: string[];
  skipped: string[];
}

const SYSTEM_SKILL_ASSETS = [
  '_brain-filing-rules.json',
  '_brain-filing-rules.md',
] as const;

export function ensureSystemSkillAssets(brainDir: string): SystemSkillAssetResult {
  const root = resolve(brainDir);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const result: SystemSkillAssetResult = {
    skillsDir,
    created: [],
    updated: [],
    skipped: [],
  };

  for (const name of SYSTEM_SKILL_ASSETS) {
    const source = findSystemSkillAssetSource(name);
    const target = join(skillsDir, name);
    if (!source) {
      result.skipped.push(name);
      continue;
    }
    const existed = existsSync(target);
    if (existed && isFreshEnough(source, target)) {
      result.skipped.push(name);
      continue;
    }
    copyFileSync(source, target);
    if (existed) result.updated.push(name);
    else result.created.push(name);
  }

  return result;
}

export function brainDirFromConfig(config: { desktop?: { knowledge_directory?: string } } | null | undefined): string | null {
  const dir = config?.desktop?.knowledge_directory?.trim();
  return dir || null;
}

function isFreshEnough(source: string, target: string): boolean {
  try {
    const src = statSync(source);
    const dst = statSync(target);
    return dst.size === src.size && dst.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

function findSystemSkillAssetSource(name: string): string | null {
  const candidates = [
    join(__dirname, 'skills', name),
    join(__dirname, '..', '..', 'skills', name),
    join(process.cwd(), 'skills', name),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}
