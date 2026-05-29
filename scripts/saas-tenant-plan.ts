#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  formatReport,
  loadEnvFile,
  runPreflight,
  type PreflightIssue,
} from './saas-preflight.ts';
import { loadManifest, type CompanyBrainManifest } from './provision-company-brain.ts';

export interface TenantPlanArgs {
  planPath?: string;
  check: boolean;
  json: boolean;
  help: boolean;
}

export interface TenantProvider {
  name?: string;
  project?: string;
  environment?: string;
}

export interface TenantBrain {
  id: string;
  name?: string;
  description?: string;
  public_url?: string;
  publicUrl?: string;
  env_file?: string;
  envFile?: string;
  manifest: string;
  railway_service?: string;
  railwayService?: string;
  railway_worker_service?: string;
  railwayWorkerService?: string;
}

export interface TenantPlan {
  company?: { id?: string; name?: string };
  provider?: TenantProvider;
  brains?: TenantBrain[];
}

export interface ResolvedBrainPlan {
  id: string;
  name: string;
  description?: string;
  publicUrl?: string;
  envFile?: string;
  manifest: string;
  railwayService: string;
  railwayWorkerService: string;
}

export interface ResolvedTenantPlan {
  companyId: string;
  companyName: string;
  providerName: string;
  environment: string;
  brains: ResolvedBrainPlan[];
}

export interface TenantPlanCheck {
  brainId: string;
  issues: PreflightIssue[];
}

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function usageText(): string {
  return `Usage: bun run scripts/saas-tenant-plan.ts <tenant-brains.yml> [options]

Options:
  --check       Run SaaS preflight for every brain with env_file + manifest
  --json        Print machine-readable JSON
  -h, --help    Show this help`;
}

export function readArgs(argv: string[]): TenantPlanArgs {
  const out: TenantPlanArgs = { check: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--check') {
      out.check = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!out.planPath) {
      out.planPath = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }
  return out;
}

export async function loadTenantPlan(path: string): Promise<TenantPlan> {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) throw new Error(`Tenant plan not found: ${fullPath}`);
  const raw = await Bun.file(fullPath).text();
  const parsed = extname(fullPath).toLowerCase() === '.json'
    ? JSON.parse(raw)
    : yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tenant plan must be a YAML or JSON object.');
  }
  return parsed as TenantPlan;
}

function requireId(id: string | undefined, label: string): string {
  if (!id) throw new Error(`${label} is required`);
  if (!ID_RE.test(id)) {
    throw new Error(`${label} "${id}" must be lowercase alphanumeric with optional interior hyphens.`);
  }
  return id;
}

function normalizeServiceName(companyId: string, brainId: string, suffix: string): string {
  return `${companyId}-${brainId}-brain-${suffix}`;
}

export function resolveTenantPlan(plan: TenantPlan): ResolvedTenantPlan {
  const companyId = requireId(plan.company?.id, 'company.id');
  const companyName = plan.company?.name ?? companyId;
  const providerName = (plan.provider?.name ?? 'railway').toLowerCase();
  if (providerName !== 'railway' && providerName !== 'generic') {
    throw new Error(`provider.name "${providerName}" is not supported; use railway or generic.`);
  }
  const environment = plan.provider?.environment ?? 'production';
  const seenBrains = new Set<string>();
  const brains = (plan.brains ?? []).map((brain) => {
    const id = requireId(brain.id, 'brain.id');
    if (seenBrains.has(id)) throw new Error(`duplicate brain id "${id}"`);
    seenBrains.add(id);
    if (!brain.manifest) throw new Error(`brain "${id}" manifest is required`);
    const publicUrl = brain.public_url ?? brain.publicUrl;
    return {
      id,
      name: brain.name ?? id,
      description: brain.description,
      publicUrl,
      envFile: brain.env_file ?? brain.envFile,
      manifest: brain.manifest,
      railwayService: brain.railway_service ?? brain.railwayService ?? normalizeServiceName(companyId, id, 'web'),
      railwayWorkerService: brain.railway_worker_service ?? brain.railwayWorkerService ?? normalizeServiceName(companyId, id, 'worker'),
    };
  });
  if (brains.length === 0) throw new Error('tenant plan must define at least one brain');
  return { companyId, companyName, providerName, environment, brains };
}

export function renderTenantPlan(plan: ResolvedTenantPlan): string {
  const lines: string[] = [];
  lines.push(`# SaaS Tenant Plan: ${plan.companyName}`);
  lines.push('');
  lines.push(`Company ID: \`${plan.companyId}\``);
  lines.push(`Provider: \`${plan.providerName}\``);
  lines.push(`Environment: \`${plan.environment}\``);
  lines.push('');
  lines.push('Brain hierarchy: company tenant -> brains -> sources -> folders.');
  lines.push('Use sources as normal team/sub-brain boundaries. Add separate brains only for hard isolation, separate lifecycle, compliance, or scale.');
  lines.push('');
  for (const brain of plan.brains) {
    lines.push(`## Brain: ${brain.name} (${brain.id})`);
    if (brain.description) lines.push(brain.description);
    if (brain.publicUrl) lines.push(`Public URL: \`${brain.publicUrl}\``);
    if (brain.envFile) lines.push(`Env file: \`${brain.envFile}\``);
    lines.push(`Manifest: \`${brain.manifest}\``);
    lines.push(`Railway web service: \`${brain.railwayService}\``);
    lines.push(`Railway worker service: \`${brain.railwayWorkerService}\``);
    lines.push('');
    lines.push('Preflight:');
    lines.push('```bash');
    lines.push(`bun run preflight:saas -- --env-file ${brain.envFile ?? '<env-file>'} --manifest ${brain.manifest}`);
    lines.push('```');
    lines.push('');
    lines.push('Apply Railway variables to web and worker:');
    lines.push('```bash');
    lines.push(`railway service link ${brain.railwayService}`);
    lines.push('railway volume add --mount-path /data');
    lines.push(`railway service link ${brain.railwayWorkerService}`);
    lines.push('railway volume add --mount-path /data');
    lines.push(`bun run railway:apply-env -- --env-file ${brain.envFile ?? '<env-file>'} --service ${brain.railwayService} --service ${brain.railwayWorkerService} --environment ${plan.environment}`);
    lines.push(`railway variable set --service ${brain.railwayService} --environment ${plan.environment} --skip-deploys CORTEX_PROCESS=web`);
    lines.push(`railway variable set --service ${brain.railwayWorkerService} --environment ${plan.environment} --skip-deploys CORTEX_PROCESS=worker`);
    lines.push('```');
    lines.push('');
    lines.push('The hosted entrypoint derives `CORTEX_PUBLIC_URL` from Railway `RAILWAY_PUBLIC_DOMAIN` when available. Set `CORTEX_PUBLIC_URL` in the env file for custom domains or whenever you need stable OAuth issuer metadata before public networking is enabled.');
    lines.push('');
    lines.push('Deploy/update web:');
    lines.push('```bash');
    lines.push(`railway up --service ${brain.railwayService} --environment ${plan.environment}`);
    lines.push('```');
    lines.push('');
    lines.push('Deploy/update worker:');
    lines.push('```bash');
    lines.push(`railway up --service ${brain.railwayWorkerService} --environment ${plan.environment}`);
    lines.push('```');
    lines.push('');
    lines.push('Provision sources and OAuth clients:');
    lines.push('```bash');
    lines.push(`bun run provision:company-brain -- ${brain.manifest} --cortex-bin cortex --sync --credentials-out ${plan.companyId}-${brain.id}-oauth-clients.json`);
    lines.push('```');
    lines.push('');
    lines.push('Verify:');
    lines.push('```bash');
    lines.push(`curl ${brain.publicUrl ?? 'https://<brain-host>'}/health`);
    lines.push(`open ${brain.publicUrl ?? 'https://<brain-host>'}/admin/`);
    lines.push(`bun run smoke:saas-live -- --base-url ${brain.publicUrl ?? 'https://<brain-host>'} --admin-token '<admin-bootstrap-token>' --composio-secret '<composio-webhook-secret>' --billing-secret '<billing-webhook-secret>'`);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

export async function checkTenantPlan(plan: ResolvedTenantPlan): Promise<TenantPlanCheck[]> {
  const checks: TenantPlanCheck[] = [];
  for (const brain of plan.brains) {
    let env: Record<string, string | undefined> = process.env;
    let manifest: CompanyBrainManifest | undefined;
    try {
      if (brain.envFile) env = { ...process.env, ...(await loadEnvFile(brain.envFile)) };
      manifest = await loadManifest(brain.manifest);
      checks.push({ brainId: brain.id, issues: runPreflight({ env, manifest, manifestPath: brain.manifest }) });
    } catch (error) {
      checks.push({
        brainId: brain.id,
        issues: [{
          level: 'error',
          code: 'tenant_plan_check_failed',
          message: error instanceof Error ? error.message : String(error),
        }],
      });
    }
  }
  return checks;
}

export function formatChecks(checks: TenantPlanCheck[]): string {
  return checks.map((check) => {
    const header = `## Preflight: ${check.brainId}`;
    return `${header}\n${formatReport(check.issues)}`;
  }).join('\n\n');
}

async function main() {
  let args: TenantPlanArgs;
  try {
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(usageText());
    process.exit(2);
  }
  if (args.help) {
    console.log(usageText());
    process.exit(0);
  }
  if (!args.planPath) {
    console.error(usageText());
    process.exit(2);
  }

  const resolved = resolveTenantPlan(await loadTenantPlan(args.planPath));
  const checks = args.check ? await checkTenantPlan(resolved) : undefined;
  if (args.json) {
    const errors = checks?.flatMap((check) => check.issues).filter((issue) => issue.level === 'error').length ?? 0;
    console.log(JSON.stringify({ plan: resolved, checks, ok: errors === 0 }, null, 2));
  } else {
    console.log(renderTenantPlan(resolved));
    if (checks) {
      console.log(formatChecks(checks));
    }
  }
  const errors = checks?.flatMap((check) => check.issues).filter((issue) => issue.level === 'error').length ?? 0;
  if (errors > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
