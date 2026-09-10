import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, lstatSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { claudeUserMcpConfigPath, codexConfigPath, opencodeGlobalConfigPath, opencodeGlobalSiblingPath, CODEX_TOML_BLOCK_BEGIN } from '../bootstrap/host-specs.ts';
import { writeCodexHttpServerBlock, removeCodexHttpServerBlock } from '../bootstrap/codex-toml.ts';
import { writeOpencodeMcpEntry, removeOpencodeMcpEntry, parseOpencodeConfig } from '../bootstrap/opencode-json.ts';
import { renderAgentLauncher } from '../agent-install/launcher.ts';
import { isValidName, shellQuote } from '../mcp-registration.ts';
import { GBRAIN_MCP_INSTRUCTIONS } from '../../mcp/instructions.ts';
import { harnessAdapter } from './registry.ts';
import { credentialAccessToken, credentialReceipt, type HarnessCredentials } from './credentials.ts';
import { assertNoSymlinks, checkedRoot, confinedPath, sha256, privateWrite } from '../agent-install/state.ts';

interface InstallOptions { harness: string; name?: string; root?: string; configPath?: string; remove?: boolean }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readJson = (path: string): Record<string, any> => {
  assertNoSymlinks(path);
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink()) throw new Error('configuration_conflict: refusing a symbolic-link configuration');
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('configuration_conflict: existing configuration is not a JSON object'); }
};

function nativeEntry(path: string, format: string, name: string): unknown {
  assertNoSymlinks(path);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  const parsed = (format === 'codex-toml' ? Bun.TOML.parse(text) : format === 'opencode-json' ? parseOpencodeConfig(text, path) : readJson(path)) as Record<string, unknown>;
  const entries = parsed[format === 'codex-toml' ? 'mcp_servers' : format === 'opencode-json' ? 'mcp' : 'mcpServers'] as Record<string, unknown> | undefined;
  if (format === 'codex-toml' && text.includes(CODEX_TOML_BLOCK_BEGIN) && entries?.[name] === undefined) throw new Error('configuration_conflict: managed Codex block belongs to another connection');
  return entries?.[name];
}

function assertEntryOwned(entry: unknown, prior: Record<string, any>) {
  if (entry !== undefined && (!prior.client_id || ![prior.entry_hash, prior.pending_entry_hash].includes(hash(entry)))) throw new Error('configuration_conflict: refusing to replace an unowned or edited MCP entry');
}

/** Install only in the current environment. Foreign entries are never adopted. */
export async function installHarnessConnection(c: HarnessCredentials, opts: InstallOptions) {
  const adapter = harnessAdapter(opts.harness);
  const name = opts.name ?? 'gbrain';
  if (!isValidName(name)) throw new Error('Invalid connection name');
  const common = { ...credentialReceipt(c), harness: adapter.id, native_harness_verified: false, next_action: adapter.reload };
  if (adapter.connection === 'manual') return { ...common, status: 'pending', reason: 'manual_configuration_required', documentation: adapter.guide };
  if (adapter.connection === 'thin-cli') return installThinClient(c, opts, common);
  const configPath = opts.configPath ?? (adapter.connection === 'codex-toml' ? codexConfigPath()
    : adapter.connection === 'claude-json' ? claudeUserMcpConfigPath() : opencodeGlobalConfigPath());
  assertNoSymlinks(configPath);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const lock = await acquireBootstrapLock(dirname(configPath));
  try {
    const receiptPath = join(dirname(configPath), `.gbrain-connection-${adapter.id}-${name}.json`);
    const prior = readJson(receiptPath);
    if (prior.client_id && (prior.client_id !== c.client_id || prior.mcp_url !== c.mcp_url)) throw new Error('configuration_conflict: connection name belongs to another client');
    const before = nativeEntry(configPath, adapter.connection, name);
    assertEntryOwned(before, prior);
    if (adapter.connection === 'opencode-json') {
      const sibling = opencodeGlobalSiblingPath(configPath);
      if (sibling && nativeEntry(sibling, adapter.connection, name) !== undefined) throw new Error('configuration_conflict: same-name entry in sibling opencode config; preserve it and choose one explicit configuration before installing');
    }
    const token = opts.remove ? '' : await credentialAccessToken(c);
    const entry = adapter.connection === 'codex-toml' ? { url: c.mcp_url, http_headers: { Authorization: `Bearer ${token}` } }
      : adapter.connection === 'opencode-json' ? { type: 'remote', url: c.mcp_url, headers: { Authorization: `Bearer ${token}` }, enabled: true }
        : { type: 'http', url: c.mcp_url, headers: { Authorization: `Bearer ${token}` } };
    if (!opts.remove) atomicWriteTextFile(receiptPath, `${JSON.stringify({ ...prior, ...common, status: 'prepared', entry_hash: before === undefined ? null : hash(before), pending_entry_hash: hash(entry), config_path: configPath })}\n`, { forceMode: 0o600 });
    if (adapter.connection === 'codex-toml') {
      if (opts.remove) removeCodexHttpServerBlock(configPath, name);
      else writeCodexHttpServerBlock(configPath, { name, url: c.mcp_url, bearerToken: token });
    } else if (adapter.connection === 'opencode-json') {
      if (opts.remove) removeOpencodeMcpEntry(configPath, name, { url: c.mcp_url });
      else {
        writeOpencodeMcpEntry(configPath, { kind: 'remote', name, url: c.mcp_url, tokenMode: 'inline', bearerToken: token }, { expect: { url: c.mcp_url } });
      }
    } else {
      const config = readJson(configPath);
      if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw new Error('configuration_conflict: mcpServers is not an object');
      const servers = config.mcpServers ?? {};
      if (opts.remove) delete servers[name];
      else {
        servers[name] = entry;
      }
      config.mcpServers = servers;
      atomicWriteTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { forceMode: 0o600 });
    }
    if (opts.remove) {
      if (existsSync(receiptPath)) unlinkSync(receiptPath);
      return { ...common, status: 'removed', config_path: configPath, next_action: 'The client configuration was removed. Revoke the grant on the brain host if access should end.' };
    }
    const nextReceipt = { ...common, entry_hash: hash(nativeEntry(configPath, adapter.connection, name)), status: 'installed', config_path: configPath };
    atomicWriteTextFile(receiptPath, `${JSON.stringify(nextReceipt, null, 2)}\n`, { forceMode: 0o600 });
    return nextReceipt;
  } finally { lock.release(); }
}

async function installThinClient(c: HarnessCredentials, opts: InstallOptions, common: Record<string, unknown>) {
  if (!opts.root) throw new Error('storage_root_unverified: pass --root with a verified absolute persistent directory');
  const root = checkedRoot(opts.root);
  if (!opts.remove && !c.client_secret) throw new Error('Thin CLI installation requires a renewable client credential');
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const lock = await acquireBootstrapLock(root);
  try {
    const state = join(root, '.gbrain');
    const configPath = join(state, 'config.json');
    const receiptPath = join(state, 'harness-connection.json');
    const existing = readJson(configPath);
    const prior = readJson(receiptPath);
    if (!prior.client_id && readdirSync(root).some(p => p !== '.gbrain-bootstrap.lock')) {
      throw new Error('configuration_conflict: existing state has no connection receipt; choose a fresh root');
    }
    if (prior.client_id && (prior.client_id !== c.client_id || prior.mcp_url !== c.mcp_url || prior.root !== root)) throw new Error('configuration_conflict: receipt belongs to another connection or root');
    if (Object.keys(existing).length && (!prior.client_id || prior.client_id !== c.client_id || existing.remote_mcp?.oauth_client_id !== c.client_id || existing.remote_mcp?.mcp_url !== c.mcp_url)) {
      throw new Error('configuration_conflict: choose a fresh root; this command never converts an existing brain');
    }
    const config = { engine: 'postgres', remote_mcp: { issuer_url: c.issuer_url, mcp_url: c.mcp_url,
      oauth_client_id: c.client_id, oauth_client_secret: c.client_secret } };
    const sourceCli = fileURLToPath(new URL('../../cli.ts', import.meta.url));
    const launcher = join(root, 'bin', 'gbrain');
    const files = [
      { path: '.gbrain/config.json', text: `${JSON.stringify(config, null, 2)}\n`, mode: 0o600 },
      { path: 'bin/gbrain', text: renderAgentLauncher({ root, bunPath: process.execPath, cliPath: sourceCli.includes('$bunfs') ? undefined : sourceCli, sourceId: c.source_id,
        repairHint: `Reinstall GBrain in this environment, then repeat: gbrain connect ${shellQuote(c.mcp_url)} --harness ${shellQuote(opts.harness)} --credentials-file <private-handoff-file> --root ${shellQuote(root)} --install` }), mode: 0o700 },
      { path: 'GBRAIN-INSTRUCTIONS.md', text: `${GBRAIN_MCP_INSTRUCTIONS}\n\nRun commands with the absolute launcher: ${launcher}\nThis is a hosted connection. The host grant controls sources and permissions.\n`, mode: 0o600 },
    ];
    const owned: Record<string, string> = prior.owned_files ?? {};
    const pending: Record<string, { before: string | null; after: string }> = prior.pending_files ?? {};
    // Preflight EVERY file before making any change, including removal.
    for (const file of files) {
      const target = confinedPath(root, file.path);
      if (existsSync(target) && ![owned[file.path], pending[file.path]?.before, pending[file.path]?.after].includes(sha256(readFileSync(target)))) throw new Error('configuration_conflict: refusing to replace or remove an unowned or edited thin-client file');
    }
    if (opts.remove) {
      for (const file of files) { const path = confinedPath(root, file.path); if (existsSync(path)) unlinkSync(path); }
      privateWrite(receiptPath, `${JSON.stringify({ ...common, root, status: 'removed', owned_files: {} }, null, 2)}\n`);
      return { ...common, status: 'removed', root, next_action: 'Disable the native skill and routine. Revoke the client on the host to end access; separately protect or remove retained handoff files.' };
    }
    const receipt = { ...common, root, launcher, config_path: configPath, status: 'prepared', native_instructions: 'pending', owned_files: owned, pending_files: pending };
    const save = () => privateWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    save();
    for (const file of files) {
      const target = confinedPath(root, file.path);
      pending[file.path] = { before: existsSync(target) ? sha256(readFileSync(target)) : null, after: sha256(file.text) }; save();
      privateWrite(target, file.text, file.mode);
      owned[file.path] = pending[file.path].after; delete pending[file.path]; save();
    }
    receipt.status = 'installed'; save();
    return receipt;
  } finally { lock.release(); }
}
