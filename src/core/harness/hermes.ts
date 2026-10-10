import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load, dump } from 'js-yaml';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { assertNoSymlinks, checkedRoot, confinedPath, sha256 } from '../agent-install/state.ts';
import { acquireHermesSetupLock } from './hermes-lock.ts';

type ObjectValue = Record<string, any>;
export interface HermesInstallReceipt extends ObjectValue { status: string }
type SavedValue = { exists: boolean; value?: unknown };
interface Receipt {
  version: 1; home: string; state: 'prepared' | 'installed' | 'removing' | 'removed';
  client_id?: string; connection_url?: string;
  leaves: Record<string, { before: SavedValue; after: SavedValue; previousAfter?: SavedValue }>;
  files: Record<string, { before: string | null; after: string; previousAfter?: string }>;
  env?: { before: string | null; after: string; previousAfter?: string };
}
const LEAVES = ['memory.provider', 'memory.gbrain', 'mcp_servers.gbrain'];
const TOKEN_KEY = 'GBRAIN_MCP_TOKEN';
const readText = (path: string): string | null => {
  assertNoSymlinks(path);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error('configuration_conflict: managed path is not a regular file');
  return readFileSync(path, 'utf8');
};
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const saved = (value: ObjectValue, key: string): SavedValue => {
  const [parent, leaf] = key.split('.');
  return value[parent] && Object.hasOwn(value[parent], leaf) ? { exists: true, value: value[parent][leaf] } : { exists: false };
};
function set(value: ObjectValue, key: string, state: SavedValue): void {
  const [parent, leaf] = key.split('.');
  if (state.exists) { value[parent] ??= {}; value[parent][leaf] = state.value; }
  else if (value[parent]) { delete value[parent][leaf]; if (!Object.keys(value[parent]).length) delete value[parent]; }
}
function configFrom(text: string | null, allowDisabled = false): ObjectValue {
  const value = text === null ? {} : load(text);
  if (!object(value)) throw new Error('configuration_conflict: Hermes config must be a YAML mapping');
  for (const key of ['memory', 'mcp_servers']) {
    if (value[key] !== undefined && !object(value[key])) throw new Error(`configuration_conflict: ${key} must be a mapping`);
  }
  const plugins = value.plugins;
  if (!allowDisabled && (plugins?.gbrain === false || plugins?.gbrain?.enabled === false || plugins?.disabled?.includes?.('gbrain'))) {
    throw new Error('configuration_conflict: gbrain plugin is explicitly disabled; enable it yourself before setup');
  }
  return value;
}
function tokenLine(text: string | null): string | null {
  const lines = (text ?? '').split(/\r?\n/).filter(line => /^\s*(?:export\s+)?GBRAIN_MCP_TOKEN\s*=/.test(line));
  if (lines.length > 1) throw new Error('configuration_conflict: multiple GBRAIN_MCP_TOKEN assignments');
  return lines[0] ?? null;
}
function hasProfileToken(line: string | null): boolean {
  if (line === null) return false;
  const raw = line.slice(line.indexOf('=') + 1).trim();
  if (!raw || raw.startsWith('#')) return false;
  const quoted = raw.match(/^(['"])(.*?)\1(?:\s*#.*)?\s*$/);
  if ((raw.startsWith('"') || raw.startsWith("'")) && !quoted) return false;
  const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim();
  // The pinned Hermes secret parser preserves dollar signs literally.
  // Malformed quoting, empty values and escaped/control-bearing values refuse.
  return !!value.trim() && !/[\r\n\0\\]/.test(value);
}
function envWithLine(text: string | null, before: string | null, after: string | null): string {
  const current = text ?? '';
  if (before !== null) return current.split(/(?<=\n)/).map(line => line.replace(/\r?\n$/, '') === before
    ? after === null ? '' : after + (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '') : line).join('');
  return after === null ? current : current + (current && !current.endsWith('\n') ? '\n' : '') + after + '\n';
}
function checkedUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.hash || url.search ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('invalid_url: use HTTPS or loopback HTTP without credentials, query or fragment');
  }
  return url.href;
}
function readReceipt(path: string, home: string): Receipt | null {
  const text = readText(path);
  if (text === null) return null;
  let value: Receipt;
  try { value = JSON.parse(text); } catch { throw new Error('configuration_conflict: unreadable Hermes installation receipt'); }
  if (value.version !== 1 || value.home !== home || !object(value.leaves) || !object(value.files) ||
    !['prepared', 'installed', 'removing', 'removed'].includes(value.state)) throw new Error('configuration_conflict: invalid Hermes installation receipt');
  for (const key of Object.keys(value.leaves)) if (!LEAVES.includes(key)) throw new Error('configuration_conflict: invalid owned config leaf');
  for (const [key, owned] of Object.entries(value.files)) {
    if ((!key.startsWith('plugins/gbrain/') && !key.startsWith('skills/')) || !object(owned) ||
      !(owned.before === null || typeof owned.before === 'string') || typeof owned.after !== 'string') throw new Error('configuration_conflict: invalid owned asset');
    confinedPath(home, key);
  }
  if (value.env && (typeof value.env.after !== 'string' || !/^GBRAIN_MCP_TOKEN=/.test(value.env.after) || /[\r\n]/.test(value.env.after))) throw new Error('configuration_conflict: invalid owned token assignment');
  return value;
}

/** Installs only in an explicit Hermes profile. It never opens the brain or enables capture. */
export async function installHermesPlugin(options: {
  home: string; url?: string; token?: string; clientId?: string; remove?: boolean; assets?: Record<string, string>;
}): Promise<HermesInstallReceipt> {
  const home = checkedRoot(options.home);
  const url = options.url ? checkedUrl(options.url) : options.remove ? undefined : checkedUrl('');
  if (options.token !== undefined && (!options.token.trim() || /[\r\n\0"\\]/.test(options.token))) throw new Error('invalid_token: token must be a single-line bearer credential');
  const configPath = confinedPath(home, 'config.yaml');
  const envPath = confinedPath(home, '.env');
  const receiptPath = confinedPath(home, '.gbrain-hermes/receipt.json');
  const lockPath = confinedPath(home, '.gbrain-hermes/setup.lock');
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = acquireHermesSetupLock(lockPath);
  try {
    const originalConfig = readText(configPath), originalEnv = readText(envPath);
    const config = configFrom(originalConfig, options.remove === true);
    let prior = readReceipt(receiptPath, home);
    if (prior?.state === 'removed') prior = null;
    if (prior && ((options.clientId !== undefined && prior.client_id !== options.clientId) ||
      (url !== undefined && prior.connection_url !== url))) {
      throw new Error('configuration_conflict: Hermes installation belongs to another client or endpoint; remove it explicitly before installing another connection');
    }
    const currentTokenLine = tokenLine(originalEnv);
    if (currentTokenLine && (lstatSync(envPath).mode & 0o077) !== 0) throw new Error('credential_required: this profile .env contains a token and must be private (0600)');
    if (!options.remove && options.token === undefined && !hasProfileToken(currentTokenLine)) {
      throw new Error('credential_required: pass a private token file or set GBRAIN_MCP_TOKEN in this profile .env');
    }
    const next: Receipt = prior ?? { version: 1, home, state: 'prepared', client_id: options.clientId, connection_url: url, leaves: {}, files: {} };
    const desired: ObjectValue = {
      memory: { provider: 'gbrain', gbrain: { url, capture: false } },
      mcp_servers: { gbrain: { url, headers: { Authorization: 'Bearer ${GBRAIN_MCP_TOKEN}' }, timeout: 15,
        connect_timeout: 10, tools: { resources: true, prompts: false } } },
    };
    // Preflight the complete owned footprint before mutation; unrelated leaves may change.
    for (const key of LEAVES) {
      const current = saved(config, key), owned = next.leaves[key];
      if (owned) {
        if (!same(current, owned.before) && !same(current, owned.after) && !same(current, owned.previousAfter)) throw new Error(`configuration_conflict: edited owned Hermes leaf ${key}`);
      } else if (key !== 'memory.provider' && current.exists) throw new Error(`configuration_conflict: foreign Hermes leaf ${key}`);
      else if (key === 'memory.provider' && current.value === 'gbrain') throw new Error('configuration_conflict: gbrain provider has no ownership receipt');
      if (!options.remove) next.leaves[key] = { before: owned?.before ?? current, after: saved(desired, key), ...(owned ? { previousAfter: current } : {}) };
    }
    const assets = options.remove ? {} : options.assets ?? (await import('./hermes-assets.generated.ts')).HERMES_PLUGIN_ASSETS;
    const planned = new Map<string, string>();
    const originalAssets = new Map<string, string | null>();
    for (const [path, text] of Object.entries(assets)) {
      const key = path.startsWith('skills/') ? path : `plugins/gbrain/${path}`;
      confinedPath(home, key);
      planned.set(key, text);
    }
    for (const key of new Set([...Object.keys(next.files), ...planned.keys()])) {
      const text = readText(confinedPath(home, key));
      originalAssets.set(key, text);
      const current = text === null ? null : sha256(text), owned = next.files[key];
      if (current !== null && (!owned || (current !== owned.before && current !== owned.after && current !== owned.previousAfter))) {
        throw new Error(`configuration_conflict: foreign or edited Hermes asset ${key}`);
      }
      if (planned.has(key)) next.files[key] = { before: owned ? owned.before : current, after: sha256(planned.get(key)!), ...(owned && current !== null ? { previousAfter: current } : {}) };
    }
    if (next.env && currentTokenLine !== next.env.before && currentTokenLine !== next.env.after && currentTokenLine !== next.env.previousAfter) throw new Error('configuration_conflict: edited owned profile token');
    let nextEnv = originalEnv;
    if (options.remove) {
      if (!prior) return { status: 'absent', home, native_harness_verified: false };
      for (const [key, owned] of Object.entries(next.leaves)) set(config, key, owned.before);
      if (next.env) nextEnv = envWithLine(originalEnv, currentTokenLine, next.env.before);
      next.state = 'removing';
    } else {
      if (options.token !== undefined) {
        const line = `${TOKEN_KEY}="${options.token.trim()}"`;
        if (currentTokenLine && !next.env && currentTokenLine !== line) throw new Error('configuration_conflict: profile token belongs to another installation');
        if (currentTokenLine !== line || next.env) {
          next.env = { before: next.env ? next.env.before : currentTokenLine, after: line, ...(next.env && currentTokenLine !== null ? { previousAfter: currentTokenLine } : {}) };
          nextEnv = envWithLine(originalEnv, currentTokenLine, line);
        }
      }
      for (const [key, owned] of Object.entries(next.leaves)) set(config, key, owned.after);
      next.state = 'prepared';
    }
    const write = (path: string, text: string) => {
      assertNoSymlinks(path);
      atomicWriteTextFile(path, text, { forceMode: 0o600 });
    };
    const save = () => write(receiptPath, JSON.stringify(next, null, 2) + '\n');
    // Private recovery copy is never surfaced in the public receipt returned below.
    if (!prior && !options.remove && originalConfig !== null) write(confinedPath(home, '.gbrain-hermes/config.before.yaml'), originalConfig);
    save();
    for (const [key, text] of planned) {
      const path = confinedPath(home, key);
      if (readText(path) !== originalAssets.get(key)) throw new Error('configuration_conflict: Hermes asset changed during setup');
      write(path, text);
    }
    if (!options.remove) {
      // A package upgrade removes unchanged files retired by the canonical bundle.
      // Keep their ownership in the prepared receipt until deletion succeeds.
      for (const [key, owned] of Object.entries(next.files)) {
        if (planned.has(key) || owned.before !== null) continue;
        const path = confinedPath(home, key);
        if (readText(path) !== originalAssets.get(key)) throw new Error('configuration_conflict: retired Hermes asset changed during setup');
        if (existsSync(path)) unlinkSync(path);
        delete next.files[key];
      }
    }
    if (readText(configPath) !== originalConfig || readText(envPath) !== originalEnv) throw new Error('configuration_conflict: profile config changed during setup; retry with its receipt');
    if (nextEnv !== originalEnv && nextEnv !== null) write(envPath, nextEnv);
    write(configPath, dump(config, { noRefs: true, lineWidth: -1, sortKeys: false }));
    if (options.remove) {
      for (const [key, owned] of Object.entries(next.files)) {
        if (owned.before === null) {
          const path = confinedPath(home, key);
          if (readText(path) !== originalAssets.get(key)) throw new Error('configuration_conflict: Hermes asset changed during removal');
          if (existsSync(path)) unlinkSync(path);
        }
      }
      next.state = 'removed';
    } else next.state = 'installed';
    for (const owned of Object.values(next.leaves)) delete owned.previousAfter;
    for (const owned of Object.values(next.files)) delete owned.previousAfter;
    if (next.env) delete next.env.previousAfter;
    save();
    return { status: next.state, home, config_path: configPath, receipt_path: receiptPath, capture: false,
      native_harness_verified: false, token_storage: next.env ? 'profile_env' : 'existing_profile_env',
      message: options.remove ? 'Restart Hermes. Revoke server credentials separately if access should end.'
        : 'Restart this Hermes profile and verify an allowed MCP call in a new conversation.' };
  } finally { lock.release(); }
}
