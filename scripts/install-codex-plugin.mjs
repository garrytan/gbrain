#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

function usage() {
  process.stdout.write(`Usage: node scripts/install-codex-plugin.mjs [options]

Installs or updates the repo-owned gbrain-codex plugin for Codex Desktop by
creating ~/plugins/gbrain-codex and updating ~/.agents/plugins/marketplace.json.

Options:
  --repo-dir <path>       GBrain checkout root (default: current repo)
  --home <path>           Home directory to update (default: $HOME)
  --dry-run               Print intended actions without writing
  --force                 Replace an existing non-GBrain gbrain-codex directory
  -h, --help              Show this help
`);
}

function parseArgs(argv) {
  const requireValue = (flag, value) => {
    if (!value || value.startsWith('-')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  const opts = {
    repoDir: REPO_ROOT,
    home: process.env.HOME || '',
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-dir') opts.repoDir = resolve(requireValue('--repo-dir', argv[++i]));
    else if (arg === '--home') opts.home = resolve(requireValue('--home', argv[++i]));
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.home) throw new Error('Could not resolve home directory. Pass --home <path>.');
  return opts;
}

function log(message) {
  process.stderr.write(`[gbrain-codex:install] ${message}\n`);
}

function runStep(opts, message, fn) {
  log(message);
  if (!opts.dryRun) fn();
}

function assertRepoShape(repoDir) {
  const pluginRoot = join(repoDir, 'plugins', 'gbrain-codex');
  const manifest = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const mcp = join(pluginRoot, '.mcp.json');
  const skills = join(repoDir, 'skills');
  for (const path of [manifest, mcp, skills]) {
    if (!existsSync(path)) throw new Error(`Required path is missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  if (parsed.name !== 'gbrain-codex') {
    throw new Error(`Unexpected Codex plugin name in ${manifest}: ${parsed.name}`);
  }
  return { pluginRoot, manifest, mcp, skills };
}

function safeRemovePluginDir(pluginDir, force) {
  let stat;
  try {
    stat = lstatSync(pluginDir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    rmSync(pluginDir, { force: true });
    return;
  }

  const manifest = join(pluginDir, '.codex-plugin', 'plugin.json');
  if (!force && existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed.name === 'gbrain-codex') {
        rmSync(pluginDir, { recursive: true, force: true });
        return;
      }
    } catch {
      // Fall through to the guarded error below.
    }
  }

  if (!force) {
    throw new Error(
      `Refusing to replace existing plugin directory: ${pluginDir}\n` +
      `Pass --force if this directory is safe to replace.`,
    );
  }
  rmSync(pluginDir, { recursive: true, force: true });
}

function linkEntry(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(src, dest);
}

function installPluginTree(opts, paths) {
  const pluginsDir = join(opts.home, 'plugins');
  const pluginDir = join(pluginsDir, 'gbrain-codex');
  runStep(opts, `Installing Codex plugin into ${pluginDir}`, () => {
    mkdirSync(pluginsDir, { recursive: true });
    safeRemovePluginDir(pluginDir, opts.force);
    mkdirSync(pluginDir, { recursive: true });
    linkEntry(join(paths.pluginRoot, '.codex-plugin'), join(pluginDir, '.codex-plugin'));
    linkEntry(join(paths.pluginRoot, '.mcp.json'), join(pluginDir, '.mcp.json'));
    linkEntry(join(paths.pluginRoot, 'README.md'), join(pluginDir, 'README.md'));
    linkEntry(join(paths.pluginRoot, 'assets'), join(pluginDir, 'assets'));
    linkEntry(join(paths.pluginRoot, 'scripts'), join(pluginDir, 'scripts'));
    linkEntry(paths.skills, join(pluginDir, 'skills'));
  });
  return pluginDir;
}

function marketplacePath(home) {
  return join(home, '.agents', 'plugins', 'marketplace.json');
}

function updateMarketplace(opts) {
  const path = marketplacePath(opts.home);
  runStep(opts, `Updating Codex marketplace ${path}`, () => {
    mkdirSync(dirname(path), { recursive: true });
    let doc = { name: 'local', interface: { displayName: 'Local Plugins' }, plugins: [] };
    if (existsSync(path)) {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    }
    if (!Array.isArray(doc.plugins)) doc.plugins = [];
    doc.name = doc.name || 'local';
    doc.interface = doc.interface || { displayName: 'Local Plugins' };
    doc.interface.displayName = doc.interface.displayName || 'Local Plugins';
    const entry = {
      name: 'gbrain-codex',
      source: { source: 'local', path: './plugins/gbrain-codex' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Engineering',
    };
    const idx = doc.plugins.findIndex(plugin => plugin && plugin.name === entry.name);
    if (idx >= 0) doc.plugins[idx] = { ...doc.plugins[idx], ...entry };
    else doc.plugins.push(entry);
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  });
  return path;
}

export function installCodexPlugin(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const paths = assertRepoShape(opts.repoDir);
  const pluginDir = installPluginTree(opts, paths);
  const market = updateMarketplace(opts);
  const rel = relative(opts.home, pluginDir) || pluginDir;
  log(`Installed ${rel}; restart Codex Desktop to reload plugins.`);
  return { pluginDir, marketplace: market, dryRun: opts.dryRun };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = installCodexPlugin();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
