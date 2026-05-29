#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export interface SourceSpec {
  id: string;
  name?: string;
  path?: string;
  url?: string;
  federated?: boolean;
}

export interface ClientSpec {
  name: string;
  grant_types?: string[];
  grantTypes?: string[];
  scopes?: string[];
  source: string;
  federated_read?: string[];
  federatedRead?: string[];
  redirect_uris?: string[];
  redirectUris?: string[];
  token_endpoint_auth_method?: string;
  tokenEndpointAuthMethod?: string;
}

export interface CompanyBrainManifest {
  company?: { id?: string; name?: string };
  tenant?: { id?: string; name?: string };
  sources?: SourceSpec[];
  clients?: ClientSpec[];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ProvisionArgs {
  manifestPath?: string;
  local: boolean;
  dryRun: boolean;
  skipClients: boolean;
  sync: boolean;
  help: boolean;
  credentialsOut?: string;
  cortexBin?: string;
}

export function usageText(): string {
  return `Usage: bun run scripts/provision-company-brain.ts <manifest.yml> [options]

Options:
  -h, --help              Show this help
  --local                 Run this checkout via "bun src/cli.ts" instead of "cortex"
  --cortex-bin <path>     Use an installed cortex binary
  --dry-run               Print actions without changing the brain
  --skip-clients          Create/update sources only; do not mint OAuth clients
  --sync                  Run "cortex sync --all" after sources are present
  --credentials-out <p>   Write minted OAuth credentials to a JSON file

Re-running client provisioning mints new secrets. Use --skip-clients for repeat source syncs.`;
}

function usage(code = 2): never {
  const out = code === 0 ? console.log : console.error;
  out(usageText());
  process.exit(code);
}

export function readArgs(argv: string[]): ProvisionArgs {
  let manifestPath: string | undefined;
  const flagsWithValues = new Set(['--cortex-bin', '--gbrain-bin', '--credentials-out']);
  const boolFlags = new Set(['--local', '--dry-run', '--skip-clients', '--sync', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsWithValues.has(arg)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--') || arg === '-h') {
      if (!boolFlags.has(arg)) throw new Error(`Unknown flag: ${arg}`);
      continue;
    }
    if (!arg.startsWith('--') && !manifestPath) {
      manifestPath = arg;
    } else if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  const has = (flag: string) => argv.includes(flag);
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  return {
    manifestPath,
    local: has('--local'),
    dryRun: has('--dry-run'),
    skipClients: has('--skip-clients'),
    sync: has('--sync'),
    help: has('--help') || has('-h'),
    credentialsOut: val('--credentials-out'),
    cortexBin: val('--cortex-bin') || val('--gbrain-bin'),
  };
}

export function commandPrefix(opts: ProvisionArgs): string[] {
  if (opts.local) return [process.execPath, resolve(REPO_ROOT, 'src/cli.ts')];
  if (opts.cortexBin) return [opts.cortexBin];
  if (process.env.CORTEX_BIN) return [process.env.CORTEX_BIN];
  if (process.env.GBRAIN_BIN) return [process.env.GBRAIN_BIN];
  return ['cortex'];
}

export function renderCommand(parts: string[]): string {
  return parts.map((part) => {
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }).join(' ');
}

async function run(prefix: string[], args: string[], dryRun = false): Promise<RunResult> {
  const rendered = renderCommand([...prefix, ...args]);
  if (dryRun) {
    console.log(`[dry-run] ${rendered}`);
    return { code: 0, stdout: '', stderr: '' };
  }

  const proc = Bun.spawn([...prefix, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    console.error(stderr.trim() || stdout.trim() || `Command failed: ${rendered}`);
    process.exit(code);
  }
  return { code, stdout, stderr };
}

export async function loadManifest(path: string): Promise<CompanyBrainManifest> {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) {
    throw new Error(`Manifest not found: ${fullPath}`);
  }
  const raw = await Bun.file(fullPath).text();
  const parsed = extname(fullPath).toLowerCase() === '.json'
    ? JSON.parse(raw)
    : yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Manifest must be a YAML or JSON object.');
  }
  return parsed as CompanyBrainManifest;
}

function requireSourceId(id: string, label: string): void {
  if (!SOURCE_ID_RE.test(id)) {
    throw new Error(`${label} "${id}" must be 1-32 lowercase alphanumeric chars with optional interior hyphens.`);
  }
}

export function validate(manifest: CompanyBrainManifest): void {
  const seenSources = new Set<string>();
  for (const source of manifest.sources ?? []) {
    if (!source.id) throw new Error('source.id is required');
    requireSourceId(source.id, 'source.id');
    if (seenSources.has(source.id)) {
      throw new Error(`duplicate source id "${source.id}"`);
    }
    seenSources.add(source.id);
    if (!source.path && !source.url) {
      throw new Error(`source "${source.id}" needs either path or url`);
    }
    if (source.path && source.url) {
      throw new Error(`source "${source.id}" cannot set both path and url`);
    }
  }
  const sourceIds = new Set((manifest.sources ?? []).map((source) => source.id));
  const seenClients = new Set<string>();
  for (const client of manifest.clients ?? []) {
    if (!client.name) throw new Error('client.name is required');
    if (seenClients.has(client.name)) {
      throw new Error(`duplicate client name "${client.name}"`);
    }
    seenClients.add(client.name);
    requireSourceId(client.source, `client "${client.name}" source`);
    if (sourceIds.size > 0 && !sourceIds.has(client.source)) {
      throw new Error(`client "${client.name}" writes to unknown source "${client.source}"`);
    }
    for (const id of client.federated_read ?? client.federatedRead ?? [client.source]) {
      requireSourceId(id, `client "${client.name}" federated_read`);
      if (sourceIds.size > 0 && !sourceIds.has(id)) {
        throw new Error(`client "${client.name}" reads unknown source "${id}"`);
      }
    }
  }
}

async function currentSourceIds(prefix: string[], dryRun: boolean): Promise<Set<string>> {
  if (dryRun) return new Set();
  const result = await run(prefix, ['sources', 'list', '--json']);
  const parsed = JSON.parse(result.stdout) as { sources?: Array<{ id: string }> };
  return new Set((parsed.sources ?? []).map((source) => source.id));
}

export function parseClientOutput(stdout: string) {
  const clientId = stdout.match(/Client ID:\s+(.+)/)?.[1]?.trim();
  const rawSecret = stdout.match(/Client Secret:\s+(.+)/)?.[1]?.trim();
  const clientSecret = rawSecret && !rawSecret.startsWith('<public client') ? rawSecret : undefined;
  return { clientId, clientSecret };
}

async function main() {
  let opts: ProvisionArgs;
  try {
    opts = readArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    usage(2);
  }
  if (opts.help) usage(0);
  if (!opts.manifestPath) usage(2);

  const manifest = await loadManifest(opts.manifestPath);
  validate(manifest);

  const prefix = commandPrefix(opts);
  const tenant = manifest.company?.id ?? manifest.tenant?.id ?? 'company-brain';
  console.log(`Provisioning ${tenant}`);

  const existingSources = await currentSourceIds(prefix, opts.dryRun);
  for (const source of manifest.sources ?? []) {
    if (existingSources.has(source.id)) {
      console.log(`source ${source.id}: already exists`);
      continue;
    }
    const args = ['sources', 'add', source.id];
    if (source.path) args.push('--path', source.path);
    if (source.url) args.push('--url', source.url);
    if (source.name) args.push('--name', source.name);
    args.push(source.federated === false ? '--no-federated' : '--federated');
    await run(prefix, args, opts.dryRun);
  }

  if (opts.sync) {
    await run(prefix, ['sync', '--all'], opts.dryRun);
  }

  const credentials: Array<Record<string, unknown>> = [];
  if (!opts.skipClients) {
    for (const client of manifest.clients ?? []) {
      const grantTypes = client.grant_types ?? client.grantTypes ?? ['client_credentials'];
      const scopes = client.scopes ?? ['read'];
      const federatedRead = client.federated_read ?? client.federatedRead ?? [client.source];
      const redirectUris = client.redirect_uris ?? client.redirectUris ?? [];
      const tokenAuth = client.token_endpoint_auth_method ?? client.tokenEndpointAuthMethod;
      const args = [
        'auth',
        'register-client',
        client.name,
        '--grant-types',
        grantTypes.join(','),
        '--scopes',
        scopes.join(' '),
        '--source',
        client.source,
        '--federated-read',
        federatedRead.join(','),
      ];
      for (const uri of redirectUris) args.push('--redirect-uri', uri);
      if (tokenAuth) args.push('--token-endpoint-auth-method', tokenAuth);

      const result = await run(prefix, args, opts.dryRun);
      const parsed = parseClientOutput(result.stdout);
      credentials.push({
        name: client.name,
        source: client.source,
        federated_read: federatedRead,
        scopes,
        grant_types: grantTypes,
        client_id: parsed.clientId,
        client_secret: parsed.clientSecret,
      });
      if (!opts.dryRun) console.log(result.stdout.trim());
    }
  }

  if (opts.credentialsOut && !opts.dryRun) {
    await Bun.write(
      opts.credentialsOut,
      JSON.stringify({ tenant, generated_at: new Date().toISOString(), clients: credentials }, null, 2),
    );
    console.log(`Wrote credentials to ${opts.credentialsOut}`);
  }

  console.log('Provisioning complete.');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
