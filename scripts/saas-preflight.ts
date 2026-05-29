#!/usr/bin/env bun
import { loadManifest, validate, type CompanyBrainManifest } from './provision-company-brain.ts';

export type PreflightLevel = 'error' | 'warn';

export interface PreflightIssue {
  level: PreflightLevel;
  code: string;
  message: string;
}

export interface PreflightArgs {
  envFile?: string;
  manifestPath?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
}

export interface PreflightInput {
  env: Record<string, string | undefined>;
  manifest?: CompanyBrainManifest;
  manifestPath?: string;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function usageText(): string {
  return `Usage: bun run scripts/saas-preflight.ts [options]

Options:
  --env-file <path>      Load tenant environment values from a dotenv file
  --manifest <path>      Validate a company-brain tenant manifest
  --json                 Print machine-readable JSON
  --strict               Exit non-zero on warnings as well as errors
  -h, --help             Show this help`;
}

export function readArgs(argv: string[]): PreflightArgs {
  const flagsWithValues = new Set(['--env-file', '--manifest']);
  const boolFlags = new Set(['--json', '--strict', '--help', '-h']);
  const out: PreflightArgs = { json: false, strict: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsWithValues.has(arg)) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--env-file') out.envFile = val;
      if (arg === '--manifest') out.manifestPath = val;
      i += 1;
      continue;
    }
    if (boolFlags.has(arg)) {
      if (arg === '--json') out.json = true;
      if (arg === '--strict') out.strict = true;
      if (arg === '--help' || arg === '-h') out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  const raw = await Bun.file(path).text();
  const env: Record<string, string> = {};
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq < 1) {
      throw new Error(`${path}:${index + 1}: expected KEY=value`);
    }
    const key = withoutExport.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`${path}:${index + 1}: invalid environment key "${key}"`);
    }
    env[key] = unquoteEnvValue(withoutExport.slice(eq + 1).trim());
  });
  return env;
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function add(issues: PreflightIssue[], level: PreflightLevel, code: string, message: string): void {
  issues.push({ level, code, message });
}

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function envFirst(env: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = envValue(env, key);
    if (value) return value;
  }
  return undefined;
}

function isTruthy(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

function isFalsy(raw: string | undefined): boolean {
  return raw !== undefined && FALSY.has(raw.trim().toLowerCase());
}

function isPlaceholder(raw: string | undefined): boolean {
  if (!raw) return true;
  return /(<[^>]+>|PROJECT_REF|PASSWORD|your-|example\.com|brain\.example\.com|\.\.\.)/i.test(raw);
}

function parseDatabaseUrl(raw: string, issues: PreflightIssue[]): URL | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      add(issues, 'error', 'database_url_protocol', 'DATABASE_URL must use postgres:// or postgresql://.');
      return undefined;
    }
    return parsed;
  } catch {
    add(issues, 'error', 'database_url_invalid', 'DATABASE_URL is not a valid Postgres connection string.');
    return undefined;
  }
}

function checkDatabaseUrl(env: Record<string, string | undefined>, issues: PreflightIssue[]): void {
  const raw = envFirst(env, 'CORTEX_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_DATABASE_URL');
  if (!raw) {
    add(issues, 'error', 'database_url_missing', 'DATABASE_URL or CORTEX_DATABASE_URL is required.');
    return;
  }
  if (isPlaceholder(raw)) {
    add(issues, 'error', 'database_url_placeholder', 'DATABASE_URL still contains placeholder values.');
  }

  const parsed = parseDatabaseUrl(raw, issues);
  if (!parsed) return;
  const host = parsed.hostname.toLowerCase();
  const isSupabase = host.endsWith('.supabase.co') || host.endsWith('.pooler.supabase.com');
  if (!isSupabase) {
    add(issues, 'warn', 'database_url_not_supabase', 'DATABASE_URL is not a Supabase host; this is fine only if you intentionally swapped providers.');
  }

  if (host.endsWith('.pooler.supabase.com') && parsed.port === '6543') {
    const urlPrepare = parsed.searchParams.get('prepare')?.toLowerCase();
    const envPrepare = envFirst(env, 'CORTEX_PREPARE', 'GBRAIN_PREPARE')?.toLowerCase();
    if (envPrepare === 'true' || envPrepare === '1') {
      add(issues, 'error', 'supabase_transaction_prepare_enabled', 'Supabase transaction pooler on port 6543 cannot be used with CORTEX_PREPARE=true.');
    } else if (urlPrepare !== 'false' && envPrepare !== 'false' && envPrepare !== '0') {
      add(issues, 'error', 'supabase_transaction_prepare_missing', 'Supabase transaction pooler on port 6543 requires ?prepare=false or CORTEX_PREPARE=false.');
    }
  }

  if (host.endsWith('.pooler.supabase.com') && !isTruthy(envFirst(env, 'CORTEX_DISABLE_DIRECT_POOL', 'GBRAIN_DISABLE_DIRECT_POOL'))) {
    add(
      issues,
      'warn',
      'supabase_direct_pool_may_need_ipv6',
      'Cortex derives db.<project-ref>.supabase.co:5432 for DDL when using a Supabase pooler URL; set CORTEX_DISABLE_DIRECT_POOL=1 on hosts that cannot reach the direct Supabase endpoint.',
    );
  }

  if (isSupabase && !parsed.port) {
    add(issues, 'warn', 'supabase_port_missing', 'Supabase DATABASE_URL should include the copied port so direct/session/transaction mode is unambiguous.');
  }
}

function checkPublicHttp(env: Record<string, string | undefined>, issues: PreflightIssue[]): void {
  const railwayDomain = envFirst(env, 'RAILWAY_PUBLIC_DOMAIN');
  const publicUrl = envFirst(env, 'CORTEX_PUBLIC_URL', 'GBRAIN_PUBLIC_URL', 'PUBLIC_URL')
    ?? (railwayDomain ? `https://${railwayDomain}` : undefined);
  if (!publicUrl) {
    add(issues, 'error', 'public_url_missing', 'CORTEX_PUBLIC_URL is required for a hosted OAuth issuer. On Railway, enable public networking so RAILWAY_PUBLIC_DOMAIN is available or set CORTEX_PUBLIC_URL explicitly.');
  } else if (isPlaceholder(publicUrl)) {
    add(issues, 'error', 'public_url_placeholder', 'CORTEX_PUBLIC_URL still contains a placeholder host.');
  } else {
    try {
      const parsed = new URL(publicUrl);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !isLocal) {
        add(issues, 'error', 'public_url_https', 'CORTEX_PUBLIC_URL must be HTTPS for public SaaS tenants.');
      }
      if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        add(issues, 'warn', 'public_url_shape', 'CORTEX_PUBLIC_URL should be the origin only, without path, query, or hash.');
      }
    } catch {
      add(issues, 'error', 'public_url_invalid', 'CORTEX_PUBLIC_URL is not a valid URL.');
    }
  }

  const cors = envFirst(env, 'CORTEX_HTTP_CORS_ORIGIN', 'GBRAIN_HTTP_CORS_ORIGIN');
  if (!cors) {
    if (!railwayDomain) {
      add(issues, 'warn', 'cors_origin_missing', 'CORTEX_HTTP_CORS_ORIGIN is empty; browser admin clients will be default-denied.');
    }
  } else if (publicUrl && !isPlaceholder(publicUrl)) {
    const origins = cors.split(',').map((part) => part.trim()).filter(Boolean);
    if (!origins.includes(publicUrl.replace(/\/$/, ''))) {
      add(issues, 'warn', 'cors_origin_public_url_missing', 'CORTEX_HTTP_CORS_ORIGIN should include CORTEX_PUBLIC_URL.');
    }
  }

  const trustProxy = envFirst(env, 'CORTEX_HTTP_TRUST_PROXY', 'GBRAIN_HTTP_TRUST_PROXY');
  if (!isTruthy(trustProxy)) {
    add(issues, 'warn', 'trust_proxy_missing', 'Set CORTEX_HTTP_TRUST_PROXY=1 behind a hosted HTTPS proxy/load balancer.');
  }
}

function checkRuntimeSecurity(env: Record<string, string | undefined>, issues: PreflightIssue[]): void {
  const token = envFirst(env, 'CORTEX_ADMIN_BOOTSTRAP_TOKEN', 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN');
  if (!token) {
    add(issues, 'error', 'bootstrap_token_missing', 'CORTEX_ADMIN_BOOTSTRAP_TOKEN is required so bootstrap secrets are not generated in logs.');
  } else if (isPlaceholder(token) || token.length < 32) {
    add(issues, 'warn', 'bootstrap_token_weak', 'CORTEX_ADMIN_BOOTSTRAP_TOKEN should be a random value of at least 32 characters.');
  }

  const suppress = envFirst(env, 'CORTEX_SUPPRESS_BOOTSTRAP_TOKEN', 'GBRAIN_SUPPRESS_BOOTSTRAP_TOKEN');
  if (!isTruthy(suppress)) {
    add(issues, 'warn', 'bootstrap_token_log_risk', 'Set CORTEX_SUPPRESS_BOOTSTRAP_TOKEN=1 to keep bootstrap tokens out of hosted logs.');
  }

  const shellJobs = env.CORTEX_ALLOW_SHELL_JOBS ?? env.GBRAIN_ALLOW_SHELL_JOBS;
  if (shellJobs !== undefined && !isFalsy(shellJobs)) {
    add(issues, 'error', 'shell_jobs_enabled', 'Leave CORTEX_ALLOW_SHELL_JOBS unset for hosted SaaS tenants unless the runtime is separately isolated.');
  }
}

function checkRuntimeTuning(env: Record<string, string | undefined>, issues: PreflightIssue[]): void {
  if (!envFirst(env, 'CORTEX_HOME', 'GBRAIN_HOME')) {
    add(issues, 'warn', 'cortex_home_missing', 'Set CORTEX_HOME to a persistent volume path such as /data/cortex.');
  }

  const poolSize = envFirst(env, 'CORTEX_POOL_SIZE', 'GBRAIN_POOL_SIZE');
  if (!poolSize) {
    add(issues, 'warn', 'pool_size_missing', 'Set CORTEX_POOL_SIZE=2 for first Supabase-backed tenants, then tune from connection metrics.');
  } else {
    const parsed = Number.parseInt(poolSize, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== poolSize) {
      add(issues, 'error', 'pool_size_invalid', 'CORTEX_POOL_SIZE must be a positive integer.');
    } else if (parsed > 5) {
      add(issues, 'warn', 'pool_size_high', 'CORTEX_POOL_SIZE is high for a first tenant; start near 2 unless Supabase metrics say otherwise.');
    }
  }

  if (isTruthy(envFirst(env, 'CORTEX_RUN_FULL_MIGRATIONS_ON_START', 'GBRAIN_RUN_FULL_MIGRATIONS_ON_START'))) {
    add(issues, 'warn', 'web_full_migrations', 'Prefer a release/migrate phase over CORTEX_RUN_FULL_MIGRATIONS_ON_START=1 after first boot.');
  }
  if (isTruthy(envFirst(env, 'CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS', 'GBRAIN_WORKER_RUN_SCHEMA_MIGRATIONS'))) {
    add(issues, 'warn', 'worker_migrations', 'Worker schema migrations should stay off when web/release migrations are present.');
  }
}

function checkProviderKeys(env: Record<string, string | undefined>, issues: PreflightIssue[]): void {
  if (!envValue(env, 'ZEROENTROPY_API_KEY')) {
    add(issues, 'warn', 'zeroentropy_missing', 'ZEROENTROPY_API_KEY is missing; default embedding/reranking flows may not work.');
  }
  const hasLlm = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GOOGLE_API_KEY',
    'AI_GATEWAY_API_KEY',
  ].some((key) => !!envValue(env, key));
  if (!hasLlm) {
    add(issues, 'warn', 'llm_key_missing', 'No LLM provider key found; synthesis and enrichment jobs may fail.');
  }
}

function checkEmailDelivery(env: Record<string, string | undefined>, issues: PreflightIssue[]): void {
  const provider = envFirst(env, 'CORTEX_EMAIL_PROVIDER');
  if (!provider) {
    add(issues, 'warn', 'email_provider_missing', 'Set CORTEX_EMAIL_PROVIDER=resend before sending owner onboarding and teammate invite email.');
    return;
  }
  if (provider.toLowerCase() !== 'resend') {
    add(issues, 'warn', 'email_provider_unsupported', 'Cortex currently ships a Resend invite delivery drain; other providers need an adapter.');
    return;
  }
  if (!envFirst(env, 'CORTEX_RESEND_API_KEY', 'RESEND_API_KEY')) {
    add(issues, 'error', 'resend_api_key_missing', 'CORTEX_EMAIL_PROVIDER=resend requires RESEND_API_KEY or CORTEX_RESEND_API_KEY.');
  }
  if (!envFirst(env, 'CORTEX_EMAIL_FROM', 'RESEND_FROM_EMAIL', 'RESEND_FROM')) {
    add(issues, 'error', 'email_from_missing', 'CORTEX_EMAIL_PROVIDER=resend requires CORTEX_EMAIL_FROM or RESEND_FROM_EMAIL.');
  }
  if (!envFirst(env, 'CORTEX_EMAIL_DELIVERY_SECRET', 'CORTEX_WORKER_SECRET')) {
    add(issues, 'warn', 'email_delivery_secret_missing', 'Set CORTEX_EMAIL_DELIVERY_SECRET for the hosted invite delivery worker endpoint.');
  }
}

function checkManifest(input: PreflightInput, issues: PreflightIssue[]): void {
  if (!input.manifest) {
    add(issues, 'warn', 'manifest_missing', 'Pass --manifest deploy/saas/company-brain.yml to validate tenant sources and OAuth clients before provisioning.');
    return;
  }
  try {
    validate(input.manifest);
  } catch (error) {
    add(issues, 'error', 'manifest_invalid', error instanceof Error ? error.message : String(error));
    return;
  }
  if ((input.manifest.sources ?? []).length === 0) {
    add(issues, 'error', 'manifest_sources_missing', 'Tenant manifest must define at least one source.');
  }
  if ((input.manifest.clients ?? []).length === 0) {
    add(issues, 'warn', 'manifest_clients_missing', 'Tenant manifest has no OAuth clients, so teammates cannot connect yet.');
  }
}

export function runPreflight(input: PreflightInput): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  checkDatabaseUrl(input.env, issues);
  checkPublicHttp(input.env, issues);
  checkRuntimeSecurity(input.env, issues);
  checkRuntimeTuning(input.env, issues);
  checkProviderKeys(input.env, issues);
  checkEmailDelivery(input.env, issues);
  checkManifest(input, issues);
  return issues;
}

export function formatReport(issues: PreflightIssue[]): string {
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warn').length;
  const heading = errors > 0
    ? `SaaS preflight failed: ${errors} error(s), ${warnings} warning(s)`
    : `SaaS preflight passed: ${warnings} warning(s)`;
  const lines = [heading];
  for (const issue of issues) {
    lines.push(`[${issue.level}] ${issue.code}: ${issue.message}`);
  }
  return lines.join('\n');
}

async function main() {
  let args: PreflightArgs;
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

  const env = args.envFile
    ? { ...process.env, ...(await loadEnvFile(args.envFile)) }
    : process.env;
  const manifest = args.manifestPath ? await loadManifest(args.manifestPath) : undefined;
  const issues = runPreflight({ env, manifest, manifestPath: args.manifestPath });
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warn').length;

  if (args.json) {
    console.log(JSON.stringify({ ok: errors === 0 && (!args.strict || warnings === 0), errors, warnings, issues }, null, 2));
  } else {
    console.log(formatReport(issues));
  }

  if (errors > 0 || (args.strict && warnings > 0)) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
