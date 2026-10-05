import { createHash } from 'node:crypto';
import { execFileSync } from '../spawn.ts';
import { existsSync, readFileSync, mkdirSync, lstatSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
import { GIT_ENV } from '../git-remote.ts';
import { credentialAccessToken, credentialReceipt, type HarnessCredentials } from './credentials.ts';
import { assertNoSymlinks, checkedRoot, confinedPath, sha256, privateWrite } from '../agent-install/state.ts';
import { installSharedSkillsConnection } from './shared-skills.ts';
import type { SharedSkillsToolCaller } from '../shared-skills/adapter.ts';
import { harnessSharedSkillsRoot } from './status.ts';

export interface InstallOptions { harness: string; name?: string; root?: string; configPath?: string; remove?: boolean;
  sharedSkills?: HarnessCredentials['shared_skills']; toolCaller?: SharedSkillsToolCaller; nativeSkillsDir?: string; credentialsFile?: string; freshToken?: boolean }
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

/** The Git working tree whose next commit would include `path`, or null when it is ignored or outside every tree. */
function committingGitTree(path: string): string | null {
  const git = (args: string[]) => execFileSync('git', ['-C', dirname(path), ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV } }).trim();
  let tree: string;
  try { tree = git(['rev-parse', '--show-toplevel']); } catch { return null; }
  try { git(['check-ignore', '-q', '--', path]); return null; } catch { return tree; }
}

/** Where an installed bearer token lives and how to replace it, never the token itself (#5775). */
export function inlineTokenReceipt(c: HarnessCredentials, harness: string, name: string, configPath: string, reload: string, credentialsFile?: string) {
  const renew = ['gbrain connect', shellQuote(c.mcp_url), '--harness', shellQuote(harness), '--credentials-file',
    credentialsFile ? shellQuote(credentialsFile) : '<private-handoff-file>', ...(name === 'gbrain' ? [] : ['--name', shellQuote(name)]), '--install', ...(c.client_secret ? ['--fresh-token'] : [])].join(' ');
  const invalidate = (apply: string) => `gbrain mcp admin invalidate-tokens ${shellQuote(c.client_id)}${apply} --url ${shellQuote(c.mcp_url)} --admin-token-file <owner-admin-token-file> --json`;
  const tree = committingGitTree(configPath);
  // A cached unexpired handoff token may be the invalidated one, so renewal always exchanges a new token.
  const replace = c.client_secret ? `Write a freshly exchanged token here: ${renew}`
    : `This handoff cannot exchange a new token; get a new private handoff from the brain owner (gbrain mcp grant on the brain host), then run: ${renew}`;
  return {
    token_storage: 'inline' as const, config_path: configPath, renew_command: renew,
    if_exposed: {
      steps: [`On the brain host, preview: ${invalidate('')}`, `Apply with the previewed revision: ${invalidate(' --yes --if-version <revision>')}`,
        replace, reload],
      docs_url: 'docs/mcp/ADMIN.md#invalidate-tokens-revoke-or-delete',
    },
    ...(tree ? { token_warning: `${configPath} is inside the Git working tree ${tree}, so committing there would publish this bearer token. `
      + `Add ${relative(tree, configPath).split('\\').join('/')} to that repository's .gitignore or move the configuration; if it was already committed, follow if_exposed.` } : {}),
  };
}

function assertEntryOwned(entry: unknown, prior: Record<string, any>) {
  if (entry !== undefined && (!prior.client_id || ![prior.entry_hash, prior.pending_entry_hash].includes(hash(entry)))) throw new Error('configuration_conflict: refusing to replace an unowned or edited MCP entry');
}

/** Install only in the current environment. Foreign entries are never adopted. */
export async function installHarnessConnection(c: HarnessCredentials, opts: InstallOptions) {
  // A cached unexpired token may be the invalidated one; every later step (config and shared skills) uses the new token.
  if (opts.freshToken && !opts.remove) c = { ...c, access_token: await credentialAccessToken({ ...c, access_token: undefined }), expires_at: undefined };
  const adapter = harnessAdapter(opts.harness);
  const name = opts.name ?? 'gbrain';
  if (!isValidName(name)) throw new Error('Invalid connection name');
  const common = { ...credentialReceipt(c), harness: adapter.id, native_harness_verified: false, next_action: adapter.reload };
  let deactivated: Awaited<ReturnType<typeof installSharedSkillsConnection>> | undefined;
  if (opts.remove || (opts.sharedSkills ?? c.shared_skills)?.follow === false) {
    const root = harnessSharedSkillsRoot(opts);
    if (root) {
      const prior = readJson(adapter.connection === 'thin-cli' ? join(root, 'harness-connection.json')
        : join(dirname(root), `.gbrain-connection-${adapter.id}-${name}.json`));
      if (prior.client_id && (prior.client_id !== c.client_id || prior.mcp_url !== c.mcp_url)) throw new Error('configuration_conflict: connection name belongs to another client');
      deactivated = await installSharedSkillsConnection(c, { ...opts, root });
    }
  }
  if (adapter.connection === 'manual') return { ...common, status: 'pending', reason: 'manual_configuration_required', documentation: adapter.guide,
    shared_skills: { status: 'pending', reason: 'native_installation_authority_unverified', native: 'unverified' } };
  if (adapter.connection === 'thin-cli') {
    const installed = await installThinClient(c, opts, common);
    const shared_skills = deactivated ?? await installSharedSkillsConnection(c, { ...opts, root: join(opts.root!, '.gbrain'), launcher: join(opts.root!, 'bin', 'gbrain') });
    return { ...installed, native_harness_verified: false, shared_skills,
      remote_membership_pending: 'remote_membership_pending' in shared_skills && shared_skills.remote_membership_pending === true };
  }
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
      const shared_skills = deactivated ?? await installSharedSkillsConnection(c, { ...opts, root: join(dirname(configPath), `.gbrain-${adapter.id}-${name}`) });
      const pending = 'remote_membership_pending' in shared_skills && shared_skills.remote_membership_pending === true;
      return { ...common, status: 'removed', config_path: configPath, shared_skills, remote_membership_pending: pending,
        next_action: pending ? 'Local configuration and unchanged owned skills were removed. Remote membership deactivation remains pending; retry when host authority is available.'
          : 'The client configuration was removed. Revoke the grant on the brain host if access should end.' };
    }
    const nextReceipt = { ...common, entry_hash: hash(nativeEntry(configPath, adapter.connection, name)), status: 'installed',
      ...inlineTokenReceipt(c, adapter.id, name, configPath, adapter.reload, opts.credentialsFile) };
    atomicWriteTextFile(receiptPath, `${JSON.stringify(nextReceipt, null, 2)}\n`, { forceMode: 0o600 });
    const shared_skills = deactivated ?? await installSharedSkillsConnection(c, { ...opts, root: join(dirname(configPath), `.gbrain-${adapter.id}-${name}`) });
    return { ...nextReceipt, shared_skills, remote_membership_pending: 'remote_membership_pending' in shared_skills && shared_skills.remote_membership_pending === true };
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
      { path: 'bin/gbrain', text: renderAgentLauncher({ root, bunPath: process.execPath, cliPath: sourceCli.includes('$bunfs') ? undefined : sourceCli, mode: 'thin-client',
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
