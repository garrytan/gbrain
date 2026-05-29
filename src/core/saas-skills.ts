import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import {
  listSkillPolicies,
  normalizeSkillEnforcementStatus,
  normalizeSkillId,
  normalizeSkillStatus,
  upsertSkillPolicy,
  type SaasSkillEnforcementStatus,
  type SaasSkillPolicy,
  type SaasSkillStatus,
} from './saas-control-plane.ts';

export interface SaasSkillSummary {
  id: string;
  name: string;
  owner: string;
  status: SaasSkillStatus;
  triggers: string[];
  allowedClients: string[];
  sourceAccess: string[];
  lastRun: string;
  description: string;
  enforcementStatus: SaasSkillEnforcementStatus;
  persisted: boolean;
}

interface ManifestSkill {
  name?: unknown;
  path?: unknown;
  description?: unknown;
}

function skillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'skills');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(v => String(v).trim()).filter(Boolean)
    : [];
}

export function sanitizeCortexCopy(value: string): string {
  return value
    .replace(/\bGBrain\/OpenClaw\b/g, 'Cortex')
    .replace(/\bgbrain\/openclaw\b/gi, 'cortex')
    .replace(/\bGBRAIN_/g, 'CORTEX_')
    .replace(/\bGBRAIN\b/g, 'CORTEX')
    .replace(/\bGBrain\b/g, 'Cortex')
    .replace(/\bgbrain_cl_/g, 'cortex_cl_')
    .replace(/\bgbrain\.yml\b/g, 'cortex.yml')
    .replace(/~\/\.gbrain\b/g, '~/.cortex')
    .replace(/\bOpenClaw\b/g, 'Cortex agent runtime')
    .replace(/\bGStack\b/g, 'Cortex')
    .replace(/\bgstack\b/g, 'cortex')
    .replace(/\bgarrytan\/gbrain\b/g, 'Versatly/CortexBrain')
    .replace(/\bgbrain\b/g, 'cortex')
    .replace(/\bpersonal brain\b/gi, 'company brain');
}

function sanitizeCortexArray(values: string[]): string[] {
  return values.map(sanitizeCortexCopy);
}

function policyToSummary(policy: SaasSkillPolicy): SaasSkillSummary {
  return {
    id: policy.id,
    name: sanitizeCortexCopy(policy.name),
    owner: policy.owner,
    status: policy.status,
    triggers: policy.triggers,
    allowedClients: sanitizeCortexArray(policy.allowed_clients),
    sourceAccess: policy.source_access,
    lastRun: policy.last_run_at ? new Date(policy.last_run_at).toLocaleString() : 'not run',
    description: sanitizeCortexCopy(policy.description),
    enforcementStatus: policy.enforcement_status,
    persisted: true,
  };
}

function discoverBundledSkills(): SaasSkillSummary[] {
  const root = skillsDir();
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  let manifest: { skills?: ManifestSkill[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  const entries = Array.isArray(manifest.skills) ? manifest.skills : [];
  const summaries: SaasSkillSummary[] = [];
  for (const entry of entries) {
    const manifestName = typeof entry.name === 'string' ? entry.name : '';
    const relPath = typeof entry.path === 'string' ? entry.path : '';
    const id = normalizeSkillId(manifestName || relPath.replace(/\/SKILL\.md$/i, ''));
    if (!id) continue;

    let name = manifestName || id;
    let description = typeof entry.description === 'string' ? entry.description : '';
    let triggers: string[] = [];
    const skillPath = relPath ? join(root, relPath) : join(root, id, 'SKILL.md');
    if (existsSync(skillPath)) {
      try {
        const parsed = parseMarkdown(readFileSync(skillPath, 'utf8'), skillPath);
        const fm = parsed.frontmatter;
        name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : name;
        description = typeof fm.description === 'string' && fm.description.trim() ? fm.description.trim() : description;
        triggers = stringArray(fm.triggers);
      } catch {
        // Keep manifest-derived metadata when a single skill is malformed.
      }
    }
    summaries.push({
      id,
      name: sanitizeCortexCopy(name),
      owner: 'system',
      status: 'needs-enforcement',
      triggers: sanitizeCortexArray(triggers),
      allowedClients: [],
      sourceAccess: ['default'],
      lastRun: 'not run',
      description: sanitizeCortexCopy(description),
      enforcementStatus: 'needs_enforcement',
      persisted: false,
    });
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSaasSkills(engine: BrainEngine): Promise<SaasSkillSummary[]> {
  const policies = await listSkillPolicies(engine);
  const byId = new Map<string, SaasSkillSummary>();
  for (const skill of discoverBundledSkills()) byId.set(skill.id, skill);
  for (const policy of policies) {
    const base = byId.get(policy.id);
    const summary = policyToSummary(policy);
    byId.set(policy.id, {
      ...summary,
      triggers: summary.triggers.length > 0 ? summary.triggers : (base?.triggers || []),
      description: summary.description || base?.description || '',
    });
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.persisted !== b.persisted) return a.persisted ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function upsertSaasSkill(
  engine: BrainEngine,
  input: {
    id: string;
    name: string;
    owner?: string | null;
    status?: unknown;
    triggers?: unknown;
    allowedClients?: unknown;
    sourceAccess?: unknown;
    description?: string | null;
    enforcementStatus?: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<SaasSkillSummary> {
  const policy = await upsertSkillPolicy(engine, {
    id: input.id,
    name: sanitizeCortexCopy(input.name),
    owner: input.owner,
    status: normalizeSkillStatus(input.status),
    triggers: sanitizeCortexArray(stringArray(input.triggers)),
    allowedClients: sanitizeCortexArray(stringArray(input.allowedClients)),
    sourceAccess: stringArray(input.sourceAccess),
    description: input.description ? sanitizeCortexCopy(input.description) : input.description,
    enforcementStatus: normalizeSkillEnforcementStatus(input.enforcementStatus),
    metadata: input.metadata,
  });
  return policyToSummary(policy);
}
