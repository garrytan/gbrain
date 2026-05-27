import { execFileSync } from 'child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { configDir, gbrainPath } from '../../config.ts';

export interface OpenAICodexTokenRecord {
  access_token: string;
  refresh_token?: string;
  expires_at: string;
  token_type?: string;
  scope?: string;
  account_id?: string;
}

export interface TokenStore {
  get(): Promise<OpenAICodexTokenRecord | null>;
  set(token: OpenAICodexTokenRecord): Promise<void>;
  delete(): Promise<void>;
}

const TOKEN_FILE = 'openai-codex-credentials.json';
const KEYCHAIN_SERVICE = 'gbrain-openai-codex';
const KEYCHAIN_ACCOUNT = 'default';

export function tokenCredentialPath(): string {
  return gbrainPath(TOKEN_FILE);
}

export function redactTokenLike(input: string): string {
  return input
    .replace(/(access_token|refresh_token|id_token|api[_-]?key|authorization)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/\b(?:access|refresh|id)-token-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

function assertInsideGBrainHome(path: string): void {
  const base = resolve(configDir());
  const target = resolve(path);
  const rel = relative(base, target);
  if (rel.startsWith('..') || rel === '..' || resolve(rel) === rel) {
    throw new Error(`openai-codex token path is outside GBRAIN_HOME: ${path}`);
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function assertSafeFile(path: string): void {
  assertInsideGBrainHome(path);
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new Error(`openai-codex token file must not be a symlink: ${path}`);
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`openai-codex token file permissions must be 0600; got ${mode.toString(8)}`);
  }
}

function validateTokenRecord(value: unknown): OpenAICodexTokenRecord {
  if (!value || typeof value !== 'object') throw new Error('openai-codex token record must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v.access_token !== 'string' || v.access_token.length === 0) throw new Error('openai-codex token record missing access_token');
  if (v.refresh_token !== undefined && typeof v.refresh_token !== 'string') throw new Error('openai-codex token record has invalid refresh_token');
  if (typeof v.expires_at !== 'string' || Number.isNaN(Date.parse(v.expires_at))) throw new Error('openai-codex token record missing valid expires_at');
  return {
    access_token: v.access_token,
    ...(typeof v.refresh_token === 'string' ? { refresh_token: v.refresh_token } : {}),
    expires_at: v.expires_at,
    ...(typeof v.token_type === 'string' ? { token_type: v.token_type } : {}),
    ...(typeof v.scope === 'string' ? { scope: v.scope } : {}),
    ...(typeof v.account_id === 'string' ? { account_id: v.account_id } : {}),
  };
}

export class InMemoryTokenStore implements TokenStore {
  private token: OpenAICodexTokenRecord | null = null;

  async get(): Promise<OpenAICodexTokenRecord | null> {
    return this.token ? { ...this.token } : null;
  }

  async set(token: OpenAICodexTokenRecord): Promise<void> {
    this.token = { ...validateTokenRecord(token) };
  }

  async delete(): Promise<void> {
    this.token = null;
  }
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly path = tokenCredentialPath()) {
    assertInsideGBrainHome(path);
  }

  async get(): Promise<OpenAICodexTokenRecord | null> {
    assertSafeFile(this.path);
    if (!existsSync(this.path)) return null;
    try {
      return validateTokenRecord(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read openai-codex token store: ${redactTokenLike(msg)}`);
    }
  }

  async set(token: OpenAICodexTokenRecord): Promise<void> {
    const record = validateTokenRecord(token);
    assertInsideGBrainHome(this.path);
    ensurePrivateDir(dirname(this.path));
    assertSafeFile(this.path);
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  async delete(): Promise<void> {
    assertSafeFile(this.path);
    rmSync(this.path, { force: true });
  }
}

export interface KeychainTokenStoreRuntime {
  platform?: NodeJS.Platform | string;
  execFile?: (file: string, args: string[]) => string;
}

export class KeychainTokenStore implements TokenStore {
  private readonly platform: NodeJS.Platform | string;
  private readonly execFile: (file: string, args: string[]) => string;

  constructor(
    private readonly service = KEYCHAIN_SERVICE,
    private readonly account = KEYCHAIN_ACCOUNT,
    runtime: KeychainTokenStoreRuntime = {},
  ) {
    this.platform = runtime.platform ?? process.platform;
    this.execFile = runtime.execFile ?? ((file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  }

  async get(): Promise<OpenAICodexTokenRecord | null> {
    if (this.platform !== 'darwin') return null;
    try {
      const raw = this.execFile('security', ['find-generic-password', '-s', this.service, '-a', this.account, '-w']).trim();
      if (!raw) return null;
      return validateTokenRecord(JSON.parse(raw));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/could not be found|The specified item could not be found/i.test(msg)) return null;
      throw new Error(`Failed to read openai-codex Keychain token: ${redactTokenLike(msg)}`);
    }
  }

  async set(token: OpenAICodexTokenRecord): Promise<void> {
    if (this.platform !== 'darwin') throw new Error('KeychainTokenStore is only available on macOS');
    const record = validateTokenRecord(token);
    const payload = JSON.stringify(record);
    try {
      this.execFile('security', ['add-generic-password', '-U', '-s', this.service, '-a', this.account, '-w', payload]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to write openai-codex Keychain token: ${redactTokenLike(msg)}`);
    }
  }

  async delete(): Promise<void> {
    if (this.platform !== 'darwin') return;
    try {
      this.execFile('security', ['delete-generic-password', '-s', this.service, '-a', this.account]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/could not be found|The specified item could not be found/i.test(msg)) return;
      throw new Error(`Failed to delete openai-codex Keychain token: ${redactTokenLike(msg)}`);
    }
  }
}

export function defaultTokenStore(): TokenStore {
  return process.platform === 'darwin' ? new KeychainTokenStore() : new FileTokenStore();
}
