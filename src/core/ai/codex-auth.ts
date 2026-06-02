import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type CodexAuthSource = 'auto' | 'codex-cli' | 'hermes' | 'env' | 'gbrain-oauth';
export type CodexResolvedAuthSource = Exclude<CodexAuthSource, 'auto'>;
export type CodexAuthErrorCode = 'unavailable' | 'expired' | 'unsupported_source';

export interface CodexAuthResolveOptions {
  /**
   * Source selector. `auto` tries local Codex, local Hermes, then the env
   * fallback. `gbrain-oauth` is reserved and intentionally fails closed until
   * implemented.
   */
  source?: CodexAuthSource;
  /** Env snapshot. The resolver never reads process.env directly. */
  env?: Record<string, string | undefined>;
  /** Home directory used to derive default auth paths. Defaults to os.homedir(). */
  homeDir?: string;
  /** Explicit Codex CLI auth fixture/path. Defaults to ~/.codex/auth.json. */
  codexAuthPath?: string;
  /** Explicit Hermes Codex auth fixture/path. Defaults to ~/.hermes/codex-auth.json. */
  hermesAuthPath?: string;
  /** Synchronous read seam for offline tests. Production uses readFileSync. */
  readFileText?: (path: string) => string;
  /** Clock seam for expiry tests. Accepts Date, epoch-ms, or a thunk returning either. */
  now?: Date | number | (() => Date | number);
}

export type CodexCredentialSnapshot =
  | {
      ok: true;
      source: Exclude<CodexResolvedAuthSource, 'gbrain-oauth'>;
      accessToken: string;
      tokenType: 'bearer';
      expiresAtMs: number;
      expiresAt: string;
      accountId?: string;
    }
  | {
      ok: false;
      source: CodexAuthSource | CodexResolvedAuthSource;
      code: CodexAuthErrorCode;
      message: string;
      hint?: string;
      checkedPaths?: string[];
    };

const DEFAULT_CODEX_RELATIVE_AUTH_PATH = join('.codex', 'auth.json');
const DEFAULT_HERMES_RELATIVE_AUTH_PATH = join('.hermes', 'codex-auth.json');
const ENV_TOKEN = 'OPENAI_CODEX_ACCESS_TOKEN';

const ACCESS_TOKEN_KEYS = [
  'access_token',
  'accessToken',
  'OPENAI_CODEX_ACCESS_TOKEN',
  'openai_codex_access_token',
  'codex_access_token',
  'codexAccessToken',
  'chatgpt_access_token',
  'chatgptAccessToken',
] as const;

const EXPIRY_KEYS = [
  'access_token_expires_at',
  'accessTokenExpiresAt',
  'expires_at',
  'expiresAt',
  'expiry',
  'expires',
  'expiration',
] as const;

const ACCOUNT_KEYS = [
  'account_id',
  'accountId',
  'user_id',
  'userId',
  'org_id',
  'orgId',
] as const;

function freezeSnapshot<T extends CodexCredentialSnapshot>(snapshot: T): T {
  return Object.freeze(snapshot);
}

function freezeSuccessfulSnapshot(snapshot: Extract<CodexCredentialSnapshot, { ok: true }>): CodexCredentialSnapshot {
  // Keep bearer material available to the transport through property access,
  // but non-enumerable so JSON.stringify/logging of the snapshot cannot leak it.
  const token = snapshot.accessToken;
  const accountId = snapshot.accountId;
  const redacted: Record<string, unknown> = { ...snapshot };
  delete (redacted as { accessToken?: string }).accessToken;
  delete (redacted as { accountId?: string }).accountId;
  Object.defineProperty(redacted, 'accessToken', {
    value: token,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  if (accountId) {
    Object.defineProperty(redacted, 'accountId', {
      value: accountId,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(redacted) as CodexCredentialSnapshot;
}

function snapshotStillFresh(snapshot: Extract<CodexCredentialSnapshot, { ok: true }>, now = Date.now()): boolean {
  return Number.isFinite(snapshot.expiresAtMs) && snapshot.expiresAtMs > now;
}

function nowMs(now: CodexAuthResolveOptions['now']): number {
  const value = typeof now === 'function' ? now() : now;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return Date.now();
}

function defaultReadFileText(path: string): string {
  return readFileSync(path, 'utf8');
}

function defaultHomeDir(homeDir?: string): string {
  return homeDir && homeDir.trim() ? homeDir : homedir();
}

function defaultCodexAuthPath(opts: CodexAuthResolveOptions): string {
  return opts.codexAuthPath ?? join(defaultHomeDir(opts.homeDir), DEFAULT_CODEX_RELATIVE_AUTH_PATH);
}

function defaultHermesAuthPath(opts: CodexAuthResolveOptions): string {
  return opts.hermesAuthPath ?? join(defaultHomeDir(opts.homeDir), DEFAULT_HERMES_RELATIVE_AUTH_PATH);
}

function unavailable(
  source: CodexCredentialSnapshot extends infer _ ? CodexAuthSource | CodexResolvedAuthSource : never,
  message: string,
  checkedPaths?: string[],
  hint?: string,
): CodexCredentialSnapshot {
  return freezeSnapshot({
    ok: false,
    source,
    code: 'unavailable',
    message,
    ...(hint ? { hint } : {}),
    ...(checkedPaths && checkedPaths.length > 0 ? { checkedPaths: [...checkedPaths] } : {}),
  });
}

function expired(
  source: Exclude<CodexResolvedAuthSource, 'gbrain-oauth'>,
  expiresAtMs: number,
  checkedPaths?: string[],
): CodexCredentialSnapshot {
  const expiresAt = Number.isFinite(expiresAtMs)
    ? new Date(expiresAtMs).toISOString()
    : 'unknown';
  return freezeSnapshot({
    ok: false,
    source,
    code: 'expired',
    message: `Codex auth credential is expired (source=${source}, expires_at=${expiresAt}).`,
    hint: `Refresh Codex login state or set ${ENV_TOKEN} to a fresh access token for offline/dev testing.`,
    ...(checkedPaths && checkedPaths.length > 0 ? { checkedPaths: [...checkedPaths] } : {}),
  });
}

function unsupportedSource(source: CodexAuthSource | CodexResolvedAuthSource): CodexCredentialSnapshot {
  return freezeSnapshot({
    ok: false,
    source,
    code: 'unsupported_source',
    message: `Codex auth source "${source}" is unsupported in this commit.`,
    hint: 'gbrain-oauth is reserved for a future implementation and fails closed for now.',
  });
}

function base64UrlDecodeJson(segment: string): unknown | undefined {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function getJwtExpiryMsUnverified(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return undefined;
  const payload = base64UrlDecodeJson(parts[1]);
  if (!payload || typeof payload !== 'object') return undefined;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}

function parseExpiryValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds are 10 digits today; epoch ms are 13 digits. Treat small
    // positive values as seconds. Negative/zero values are still useful for
    // tests that assert expired behavior.
    return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return parseExpiryValue(numeric);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function findStringByKeys(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (!isObject(value) || depth > 6) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(value)) {
    const nested = findStringByKeys(candidate, keys, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function findExpiryByKeys(value: unknown, depth = 0): number | undefined {
  if (!isObject(value) || depth > 6) return undefined;
  for (const key of EXPIRY_KEYS) {
    const parsed = parseExpiryValue(value[key]);
    if (parsed !== undefined) return parsed;
  }
  for (const candidate of Object.values(value)) {
    const nested = findExpiryByKeys(candidate, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function declaresUnsupportedGbrainOAuth(value: unknown): boolean {
  const source = findStringByKeys(value, ['source', 'auth_source', 'authSource', 'provider']);
  return source === 'gbrain-oauth';
}

function snapshotFromToken(input: {
  source: Exclude<CodexResolvedAuthSource, 'gbrain-oauth'>;
  accessToken: string | undefined;
  explicitExpiresAtMs?: number;
  accountId?: string;
  nowMs: number;
  checkedPaths?: string[];
}): CodexCredentialSnapshot {
  const token = input.accessToken?.trim();
  if (!token) {
    return unavailable(input.source, `Codex auth credential is unavailable (source=${input.source}).`, input.checkedPaths);
  }

  const jwtExpiresAtMs = getJwtExpiryMsUnverified(token);
  const expiresAtMs = input.explicitExpiresAtMs ?? jwtExpiresAtMs;
  if (expiresAtMs === undefined) {
    return unavailable(
      input.source,
      `Codex auth credential is unavailable (source=${input.source}; missing local expiry hint).`,
      input.checkedPaths,
      'Expected a Codex access token with a JWT exp claim or an auth fixture with expires_at.',
    );
  }
  if (expiresAtMs <= input.nowMs) {
    return expired(input.source, expiresAtMs, input.checkedPaths);
  }

  return freezeSuccessfulSnapshot({
    ok: true,
    source: input.source,
    accessToken: token,
    tokenType: 'bearer',
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
}

function snapshotFromParsedAuth(
  source: Exclude<CodexResolvedAuthSource, 'gbrain-oauth'>,
  parsed: unknown,
  now: number,
  checkedPaths: string[],
): CodexCredentialSnapshot {
  if (declaresUnsupportedGbrainOAuth(parsed)) return unsupportedSource('gbrain-oauth');
  const accessToken = findStringByKeys(parsed, ACCESS_TOKEN_KEYS);
  const explicitExpiresAtMs = findExpiryByKeys(parsed);
  const accountId = findStringByKeys(parsed, ACCOUNT_KEYS);
  return snapshotFromToken({ source, accessToken, explicitExpiresAtMs, accountId, nowMs: now, checkedPaths });
}

function readAuthPath(
  source: Exclude<CodexResolvedAuthSource, 'env' | 'gbrain-oauth'>,
  path: string,
  opts: CodexAuthResolveOptions,
  now: number,
): CodexCredentialSnapshot {
  const checkedPaths = [path];
  const read = opts.readFileText ?? defaultReadFileText;
  let text: string;
  try {
    text = read(path);
  } catch {
    return unavailable(source, `Codex auth credential is unavailable (source=${source}; auth file not found).`, checkedPaths);
  }
  if (!text || !text.trim()) {
    return unavailable(source, `Codex auth credential is unavailable (source=${source}; auth file is empty).`, checkedPaths);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable(source, `Codex auth credential is unavailable (source=${source}; auth file is not valid JSON).`, checkedPaths);
  }

  return snapshotFromParsedAuth(source, parsed, now, checkedPaths);
}

function envSnapshot(env: Record<string, string | undefined> | undefined, now: number): CodexCredentialSnapshot {
  return snapshotFromToken({
    source: 'env',
    accessToken: env?.[ENV_TOKEN],
    nowMs: now,
  });
}

function failurePriority(snapshot: CodexCredentialSnapshot): number {
  if (snapshot.ok) return 0;
  if (snapshot.code === 'unsupported_source') return 3;
  if (snapshot.code === 'expired') return 2;
  return 1;
}

function mergeFailure(a: CodexCredentialSnapshot, b: CodexCredentialSnapshot): CodexCredentialSnapshot {
  if (a.ok) return a;
  if (b.ok) return b;
  const chosen = failurePriority(b) > failurePriority(a) ? b : a;
  if (chosen.ok) return chosen;
  const paths = [
    ...(!a.ok ? (a.checkedPaths ?? []) : []),
    ...(!b.ok ? (b.checkedPaths ?? []) : []),
  ];
  if (paths.length === 0 || chosen.checkedPaths) return chosen;
  return freezeSnapshot({ ...chosen, checkedPaths: paths });
}

export function resolveCodexAuthSnapshot(options: CodexAuthResolveOptions = {}): CodexCredentialSnapshot {
  const source = options.source ?? 'auto';
  const now = nowMs(options.now);

  if (source === 'gbrain-oauth') return unsupportedSource(source);
  if (source !== 'auto' && source !== 'codex-cli' && source !== 'hermes' && source !== 'env') {
    return unsupportedSource(source as CodexAuthSource);
  }

  if (source === 'codex-cli') {
    return readAuthPath('codex-cli', defaultCodexAuthPath(options), options, now);
  }
  if (source === 'hermes') {
    return readAuthPath('hermes', defaultHermesAuthPath(options), options, now);
  }
  if (source === 'env') {
    return envSnapshot(options.env, now);
  }

  const codex = readAuthPath('codex-cli', defaultCodexAuthPath(options), options, now);
  if (codex.ok) return codex;
  if (codex.code === 'unsupported_source') return codex;
  const hermes = readAuthPath('hermes', defaultHermesAuthPath(options), options, now);
  if (hermes.ok) return hermes;
  if (hermes.code === 'unsupported_source') return hermes;
  const env = envSnapshot(options.env, now);
  if (env.ok) return env;
  return mergeFailure(mergeFailure(codex, hermes), env);
}

export function codexAuthAvailable(snapshot: CodexCredentialSnapshot | undefined): boolean {
  return snapshot?.ok === true && snapshotStillFresh(snapshot);
}

export function codexAuthFailureDetail(snapshot: CodexCredentialSnapshot | undefined): string {
  if (!snapshot) return 'Codex auth unavailable (code=unavailable).';
  if (snapshot.ok) return `Codex auth ready (source=${snapshot.source}, expires_at=${snapshot.expiresAt}).`;
  return `Codex auth ${snapshot.code.replace(/_/g, ' ')} (source=${snapshot.source}): ${snapshot.message}`;
}

export function codexAuthSetupHint(snapshot: CodexCredentialSnapshot | undefined): string {
  if (!snapshot || snapshot.ok) return `Run Codex login or set ${ENV_TOKEN} to a fresh Codex access token.`;
  return snapshot.hint ?? `Run Codex login or set ${ENV_TOKEN} to a fresh Codex access token.`;
}
