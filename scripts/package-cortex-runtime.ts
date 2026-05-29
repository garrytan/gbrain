#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSaasRuntimeManifest } from '../src/core/saas-runtime-manifest.ts';

export interface RuntimePackageArgs {
  outDir?: string;
  publicUrl?: string;
  skipBinaries: boolean;
  clean: boolean;
  json: boolean;
  help: boolean;
}

export interface RuntimePackageOptions {
  outDir?: string;
  publicUrl?: string;
  skipBinaries?: boolean;
  clean?: boolean;
  json?: boolean;
  help?: boolean;
  rootDir?: string;
  generatedAt?: string;
}

export interface RuntimePackageFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface RuntimePackageIndex {
  schema: 'cortex.runtime-package.v1';
  generated_at: string;
  product: {
    name: 'Cortex Company Brain';
    package: 'cortex-brain';
    version: string;
  };
  entrypoints: {
    cli_dir: string;
    plugin: string;
    runtime_manifest: string;
    skills_manifest: string;
    resolver: string;
  };
  verification: string[];
  files: RuntimePackageFile[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = 'dist/cortex-runtime';
const REQUIRED_FILES = [
  'cortex.yml',
  'INSTALL_FOR_AGENTS.md',
  'docs/guides/agent-to-cortex.md',
  'docs/deploy/saas-runtime-packaging.md',
];
const CORTEX_BINARY_RE = /^cortex(?:$|[-.].*)/;
const LEGACY_PACKAGE_COPY_RE = /\b(GBrain|gbrain|garrytan|OpenClaw|GStack|gstack|personal brain|personal knowledge|self[- ]serve|self[- ]service|open[- ]source|local[- ]first|standalone install|individual memory|my brain|your brain|~\/\.gbrain|GBRAIN)\b/i;
const RUNTIME_SKILLS = [
  {
    name: 'setup',
    path: 'setup/SKILL.md',
    description: 'Set up Cortex SaaS onboarding for an organization, first brain, invites, runtime manifest, and agent-client verification.',
  },
  {
    name: 'schema-author',
    path: 'schema-author/SKILL.md',
    description: 'Evolve a Cortex tenant brain schema pack with admin-approved page types, prefixes, link verbs, and backfills.',
  },
];
const RUNTIME_SHARED_DEPS = ['skills/_AGENT_README.md'];

export function usageText(): string {
  return `Usage: bun run scripts/package-cortex-runtime.ts [options]

Options:
  --out-dir <path>      Output directory. Default: ${DEFAULT_OUT_DIR}
  --public-url <url>    Tenant origin to bake into the sample runtime manifest
  --skip-binaries       Package metadata, skills, and docs without requiring ./bin
  --no-clean            Do not delete the output directory before writing
  --json                Print machine-readable package summary
  -h, --help            Show this help`;
}

export function readArgs(argv: string[]): RuntimePackageArgs {
  const flagsWithValues = new Set(['--out-dir', '--public-url']);
  const boolFlags = new Set(['--skip-binaries', '--no-clean', '--json', '--help', '-h']);
  const out: RuntimePackageArgs = {
    skipBinaries: false,
    clean: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsWithValues.has(arg)) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--out-dir') out.outDir = val;
      if (arg === '--public-url') out.publicUrl = val;
      i += 1;
      continue;
    }
    if (boolFlags.has(arg)) {
      if (arg === '--skip-binaries') out.skipBinaries = true;
      if (arg === '--no-clean') out.clean = false;
      if (arg === '--json') out.json = true;
      if (arg === '--help' || arg === '-h') out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function assertSafeOutDir(rootDir: string, outDir: string): void {
  const root = resolve(rootDir);
  const out = resolve(rootDir, outDir);
  if (out === root) throw new Error('Refusing to package into the repository root.');
  const parsedRoot = resolve(root, '..');
  if (out === parsedRoot || out.length < 8) throw new Error(`Refusing unsafe output directory: ${out}`);
}

function copyRequiredFile(rootDir: string, outDir: string, path: string): void {
  const from = resolve(rootDir, path);
  if (!existsSync(from)) throw new Error(`Required package file is missing: ${path}`);
  const to = resolve(outDir, path);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function copyCortexBinaries(rootDir: string, outDir: string): number {
  const from = resolve(rootDir, 'bin');
  if (!existsSync(from)) return 0;
  const names = readdirSync(from).filter(name => CORTEX_BINARY_RE.test(name));
  if (names.length === 0) return 0;
  const to = resolve(outDir, 'bin');
  mkdirSync(to, { recursive: true });
  for (const name of names) {
    cpSync(resolve(from, name), resolve(to, name));
  }
  return names.length;
}

async function writeRuntimePlugin(rootDir: string, outDir: string): Promise<void> {
  const raw = await Bun.file(resolve(rootDir, 'cortex.plugin.json')).text();
  const plugin = JSON.parse(raw) as Record<string, unknown>;
  plugin.skills = RUNTIME_SKILLS.map(skill => `skills/${skill.path}`);
  plugin.sharedDeps = RUNTIME_SHARED_DEPS;
  plugin.excludedFromInstall = [];
  await Bun.write(resolve(outDir, 'cortex.plugin.json'), `${JSON.stringify(plugin, null, 2)}\n`);
}

async function writeRuntimeSkills(rootDir: string, outDir: string, version: string): Promise<void> {
  const skillsDir = resolve(outDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of RUNTIME_SKILLS) {
    const from = resolve(rootDir, 'skills', skill.path);
    if (!existsSync(from)) throw new Error(`Required runtime skill is missing: skills/${skill.path}`);
    const to = resolve(skillsDir, skill.path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  for (const dep of RUNTIME_SHARED_DEPS) {
    const from = resolve(rootDir, dep);
    if (!existsSync(from)) throw new Error(`Required runtime shared dependency is missing: ${dep}`);
    const to = resolve(outDir, dep);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  await Bun.write(resolve(skillsDir, 'manifest.json'), `${JSON.stringify({
    name: 'cortex-runtime',
    version,
    conformance_version: '1.0.0',
    description: 'Cortex runtime skillpack for hosted SaaS onboarding, agent setup, and tenant schema customization.',
    skills: RUNTIME_SKILLS,
    dependencies: {
      runtime: 'bun',
      package: 'cortex-brain',
    },
    setup: {
      skill: 'setup',
      description: 'Connect a hosted Cortex tenant and verify first source/client setup.',
    },
    resolver: 'RESOLVER.md',
  }, null, 2)}\n`);
  await Bun.write(resolve(skillsDir, 'RESOLVER.md'), `# Cortex Runtime Skill Resolver

This bundle intentionally includes only Cortex-clean runtime skills. Historical
or locally customized skills stay outside the hosted runtime package until they
are rebranded and guarded.

| Trigger | Skill |
| --- | --- |
| Set up Cortex, create an org, invite teammates, connect an agent, fetch runtime manifest | \`skills/setup/SKILL.md\` |
| Add or revise tenant brain types, prefixes, link verbs, expert routing, or schema backfills | \`skills/schema-author/SKILL.md\` |

Agent rule: anything a human can configure in the console should also be
available through the Cortex MCP/control-plane operation named by the skill.
`);
}

function collectFiles(root: string, dir = root): RuntimePackageFile[] {
  const files: RuntimePackageFile[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(root, fullPath));
      continue;
    }
    if (!stat.isFile()) continue;
    const bytes = readFileSync(fullPath);
    files.push({
      path: relative(root, fullPath).replace(/\\/g, '/'),
      bytes: stat.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function assertNoLegacyPackageCopy(outDir: string): void {
  const offenders: string[] = [];
  for (const file of collectFiles(outDir)) {
    if (file.path.startsWith('bin/')) continue;
    const fullPath = resolve(outDir, file.path);
    const body = readFileSync(fullPath, 'utf-8');
    if (LEGACY_PACKAGE_COPY_RE.test(body)) offenders.push(file.path);
  }
  if (offenders.length > 0) {
    throw new Error(`Runtime package contains legacy copy: ${offenders.join(', ')}`);
  }
}

async function readPackageVersion(rootDir: string): Promise<string> {
  const raw = await Bun.file(resolve(rootDir, 'package.json')).text();
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version || '0.0.0';
}

function runtimeReadme(publicUrl: string): string {
  return `# Cortex Runtime Bundle

This bundle contains the Cortex CLI binaries, plugin metadata, skills, runtime
manifest, and agent setup docs for a hosted tenant.

## Connect

\`\`\`bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor --manifest-url ${publicUrl.replace(/\/+$/, '')}/runtime-manifest.json
cortex runtime install claude-desktop
cortex runtime install claude-code --json
\`\`\`

The runtime manifest is public and secret-free. One-time client secrets are shown
only by signup or invite creation responses.

## Verify

\`\`\`bash
cortex --version
cortex runtime install cursor --manifest-url ${publicUrl.replace(/\/+$/, '')}/runtime-manifest.json --json
\`\`\`
`;
}

export async function buildRuntimePackage(options: RuntimePackageOptions = {}): Promise<RuntimePackageIndex> {
  const rootDir = resolve(options.rootDir || REPO_ROOT);
  const outDir = resolve(rootDir, options.outDir || DEFAULT_OUT_DIR);
  const publicUrl = options.publicUrl || process.env.CORTEX_PUBLIC_URL || 'https://tenant.example.com';
  const generatedAt = options.generatedAt || new Date().toISOString();

  assertSafeOutDir(rootDir, outDir);
  if (options.clean !== false && existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  for (const file of REQUIRED_FILES) copyRequiredFile(rootDir, outDir, file);

  if (!options.skipBinaries) {
    const copiedBinaries = copyCortexBinaries(rootDir, outDir);
    if (copiedBinaries === 0) {
      throw new Error('Missing Cortex binaries in ./bin. Run `bun run build:all` first or pass --skip-binaries.');
    }
  }

  const version = await readPackageVersion(rootDir);
  await writeRuntimePlugin(rootDir, outDir);
  await writeRuntimeSkills(rootDir, outDir, version);
  const runtimeManifest = buildSaasRuntimeManifest({ publicUrl, generatedAt });
  await Bun.write(resolve(outDir, 'runtime-manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  await Bun.write(resolve(outDir, 'README.md'), runtimeReadme(publicUrl));
  await Bun.write(resolve(outDir, 'package.json'), `${JSON.stringify({
    name: '@cortex/runtime-bundle',
    private: true,
    version,
    description: 'Cortex hosted company-brain runtime bundle for agents and client adapters',
    bin: {
      cortex: 'bin/cortex',
    },
    cortex: {
      plugin: './cortex.plugin.json',
      runtimeManifest: './runtime-manifest.json',
      skillsManifest: './skills/manifest.json',
      resolver: './skills/RESOLVER.md',
    },
  }, null, 2)}\n`);

  assertNoLegacyPackageCopy(outDir);
  const files = collectFiles(outDir);
  const index: RuntimePackageIndex = {
    schema: 'cortex.runtime-package.v1',
    generated_at: generatedAt,
    product: {
      name: 'Cortex Company Brain',
      package: 'cortex-brain',
      version,
    },
    entrypoints: {
      cli_dir: 'bin',
      plugin: 'cortex.plugin.json',
      runtime_manifest: 'runtime-manifest.json',
      skills_manifest: 'skills/manifest.json',
      resolver: 'skills/RESOLVER.md',
    },
    verification: [
      'cortex --version',
      'cortex connect <onboarding-url> --client-secret <one-time-secret>',
      `cortex runtime install cursor --manifest-url ${publicUrl.replace(/\/+$/, '')}/runtime-manifest.json --json`,
    ],
    files,
  };
  await Bun.write(resolve(outDir, 'runtime-package.json'), `${JSON.stringify(index, null, 2)}\n`);
  await Bun.write(resolve(outDir, 'checksums.sha256'), files.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n');
  return index;
}

async function main(): Promise<void> {
  let args: RuntimePackageArgs;
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

  const index = await buildRuntimePackage(args);
  const outDir = resolve(REPO_ROOT, args.outDir || DEFAULT_OUT_DIR);
  if (args.json) {
    console.log(JSON.stringify({ ok: true, outDir, files: index.files.length, index }, null, 2));
  } else {
    console.log(`Cortex runtime package written to ${outDir}`);
    console.log(`Files: ${index.files.length}`);
    console.log('Verify with: cortex --version');
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
