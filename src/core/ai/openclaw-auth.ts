import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface OpenClawAuthTokenResolution {
  token: string;
  source: 'openclaw-codex-auth';
  profilePath: string;
}

function parseJsonFile(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function pickToken(value: any): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.access_token,
    value.api_key,
    value.token,
    value.oauth?.access_token,
    value.oauth?.token,
    value.tokens?.access_token,
    value.tokens?.api_key,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function candidatePaths(baseDir: string): string[] {
  return [
    join(baseDir, 'auth.json'),
    join(baseDir, 'codex-auth.json'),
    join(baseDir, 'openai-auth.json'),
    join(baseDir, 'profiles', 'codex.json'),
    join(baseDir, 'profiles', 'openai.json'),
    join(baseDir, 'auth', 'codex.json'),
    join(baseDir, 'auth', 'openai.json'),
  ];
}

export function resolveOpenClawCodexAuthToken(env: Record<string, string | undefined>): OpenClawAuthTokenResolution | null {
  if (env.GBRAIN_OPENCLAW_CODEX_AUTH !== '1') return null;
  const explicitPath = env.GBRAIN_OPENCLAW_AUTH_PATH?.trim();
  const baseDir = env.GBRAIN_OPENCLAW_AUTH_DIR?.trim() || env.OPENCLAW_AUTH_DIR?.trim() || '';
  const paths = [
    ...(explicitPath ? [explicitPath] : []),
    ...(baseDir ? candidatePaths(baseDir) : []),
  ];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    const parsed = parseJsonFile(path);
    const token = pickToken(parsed);
    if (token) return { token, source: 'openclaw-codex-auth', profilePath: path };
  }
  return null;
}
